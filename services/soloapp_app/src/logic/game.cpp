#include "game.hpp"
#include "config.hpp"
#include "player_state.hpp"
#include "runtime/health.hpp"
#include <algorithm>
#include <chrono>
#include <iterator>
#include <regex>
namespace planet {
namespace {
double clockNow() {
    return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}
} // namespace
Game::Game()
    : store_(std::make_unique<WorldStore>(
          databaseConfig(), env("WORLD_NAVIGATION", "/app/data/lakes.json"), randomId())),
      auth_(drogon::HttpClient::newHttpClient(
          env("AUTH_URL", "http://auth.soloapp.svc.cluster.local:19082"))) {
    worker_ = std::thread([this] {
        while (!stop_) {
            const auto start = std::chrono::steady_clock::now();
            Json::Value local;
            std::vector<Json::Value> signals;
            std::vector<Json::Value> reactorMessages;
            {
                std::lock_guard<std::mutex> lock(mutex_);
                local = local_;
                signals.swap(signals_);
                reactorMessages.swap(reactorMessages_);
            }
            try {
                auto frame = store_->exchange(local, signals, reactorMessages);
                lastFrame_ = clockNow();
                drogon::app().getLoop()->queueInLoop([this, frame = std::move(frame)]() mutable {
                    if (!stop_)
                        received(std::move(frame));
                });
            } catch (...) {
                ++databaseErrors;
                // Do not lose commands on an aborted/ambiguous transaction.
                // Request IDs make a retry after a committed timeout idempotent.
                std::lock_guard<std::mutex> lock(mutex_);
                reactorMessages_.insert(reactorMessages_.begin(), reactorMessages.begin(),
                                        reactorMessages.end());
                if (reactorMessages_.size() > 256)
                    reactorMessages_.resize(256);
            }
            std::this_thread::sleep_until(start + std::chrono::milliseconds(100));
        }
    });
    drogon::app().getLoop()->runEvery(0.1, [this] { refresh(); });
}
Game::~Game() {
    stop_ = true;
    if (worker_.joinable())
        worker_.join();
}
bool Game::ready() const {
    return clockNow() - lastFrame_.load() < 3 && solo::ProcessHealth().Ready();
}
void Game::send(const drogon::WebSocketConnectionPtr &socket, const Json::Value &payload) {
    if (socket->connected())
        socket->send(encode(payload));
}
void Game::reject(const drogon::WebSocketConnectionPtr &socket) {
    Json::Value v;
    v["type"] = "auth_error";
    send(socket, v);
    socket->shutdown(drogon::CloseCode::kViolation, "Unauthorized");
    sessions_.erase(socket.get());
}
void Game::opened(const drogon::WebSocketConnectionPtr &socket) {
    if (!drogon::app().getLoop()->isInLoopThread()) {
        drogon::app().getLoop()->queueInLoop([this, socket] { opened(socket); });
        return;
    }
    if (sessions_.size() >= 64 || !ready()) {
        socket->shutdown(static_cast<drogon::CloseCode>(1013), "Unavailable");
        return;
    }
    Session s;
    s.socket = socket;
    s.authAt = clockNow();
    sessions_[socket.get()] = std::move(s);
}
void Game::closed(const drogon::WebSocketConnectionPtr &socket) {
    if (!drogon::app().getLoop()->isInLoopThread()) {
        drogon::app().getLoop()->queueInLoop([this, socket] { closed(socket); });
        return;
    }
    sessions_.erase(socket.get());
}
void Game::verify(const drogon::WebSocketConnectionPtr &socket, const std::string &token) {
    auto it = sessions_.find(socket.get());
    if (it == sessions_.end() || it->second.checking)
        return;
    it->second.checking = true;
    auto req = drogon::HttpRequest::newHttpRequest();
    req->setPath("/api/v1/auth/v1/me");
    req->addHeader("Authorization", "Bearer " + token);
    auth_->sendRequest(
        req,
        [this, socket, token](drogon::ReqResult result, const drogon::HttpResponsePtr &response) {
            drogon::app().getLoop()->queueInLoop([this, socket, token, result, response] {
                auto found = sessions_.find(socket.get());
                if (found == sessions_.end())
                    return;
                auto json = response ? response->getJsonObject() : nullptr;
                if (result != drogon::ReqResult::Ok || !response || response->statusCode() != 200 ||
                    !json ||
                    !std::regex_match((*json)["user_id"].asString(),
                                      std::regex("^[0-9a-f]{32}$"))) {
                    reject(socket);
                    return;
                }
                auto &session = found->second;
                if (!session.user.empty() && session.user != (*json)["user_id"].asString()) {
                    reject(socket);
                    return;
                }
                session.checking = false;
                session.authAt = clockNow();
                session.user = (*json)["user_id"].asString();
                // Only auth's stored username can identify the administrator.
                // An older auth deployment omits it: fail closed until upgraded.
                session.email =
                    (*json)["username"].isString() ? (*json)["username"].asString() : "";
                session.token = token;
                if (!session.id)
                    session.id = std::stoull(randomId().substr(0, 12), nullptr, 16) + 1;
            });
        },
        2.0);
}
void Game::message(const drogon::WebSocketConnectionPtr &socket, const std::string &text) {
    if (!drogon::app().getLoop()->isInLoopThread()) {
        drogon::app().getLoop()->queueInLoop([this, socket, text] { message(socket, text); });
        return;
    }
    auto it = sessions_.find(socket.get());
    if (it == sessions_.end())
        return;
    auto &s = it->second;
    if (clockNow() - s.window >= 1) {
        s.window = clockNow();
        s.messages = 0;
    }
    if (++s.messages > 100 || text.size() > 32768) {
        socket->shutdown(drogon::CloseCode::kViolation, "Rate limit");
        return;
    }
    Json::Value v;
    try {
        v = decode(text);
    } catch (...) {
        return;
    }
    if (!v.isObject())
        return;
    if (s.user.empty()) {
        if (v["type"] != "auth" || !v["token"].isString() ||
            !std::regex_match(v["token"].asString(), std::regex("^[a-f0-9]{64}$"))) {
            reject(socket);
            return;
        }
        verify(socket, v["token"].asString());
        return;
    }
    if (!s.joined)
        return;
    if (v["type"] == "telemetry_reply") {
        s.telemetry.accept(v, clockNow());
        return;
    }
    if (v["type"] == "reactor_join" && v["active"].isBool()) {
        s.reactor = v["active"].asBool();
        s.reactorVersion = s.journalSequence = s.commandRevision = 0;
        refresh();
        return;
    }
    if (v["type"] == "door_request" ||
        ((v["type"] == "reactor_command" || v["type"] == "reactor_snapshot") && s.reactor)) {
        v["from"] = Json::UInt64(s.id);
        v["user_id"] = s.user;
        refresh(); // Include the last pose/map before processing a door request.
        std::lock_guard<std::mutex> lock(mutex_);
        if (reactorMessages_.size() < 128)
            reactorMessages_.push_back(std::move(v));
        return;
    }
    if (v["type"] == "state") {
        if (validPlayerState(v) &&
            (s.state.empty() || v["sequence"].asUInt64() > s.state["sequence"].asUInt64()))
            s.state = v;
        return;
    }
    if (v["type"] == "ping") {
        v["type"] = "pong";
        send(socket, v);
        return;
    }
    // Only bounded peer SDP/ICE is relayed. Identity always comes from this session.
    if ((v["type"] == "sdp" || v["type"] == "ice") && v["to"].isUInt64() &&
        v["to"].asUInt64() != s.id) {
        v["from"] = Json::UInt64(s.id);
        v["to"] = Json::UInt64(v["to"].asUInt64());
        std::lock_guard<std::mutex> lock(mutex_);
        if (signals_.size() < 64)
            signals_.push_back(std::move(v));
    }
}
void Game::refresh() {
    Json::Value local(Json::arrayValue);
    std::vector<drogon::WebSocketConnectionPtr> expired;
    for (auto &[_, s] : sessions_) {
        if (!s.socket->connected()) {
            expired.push_back(s.socket);
            continue;
        }
        if ((s.user.empty() && clockNow() - s.authAt > 5) ||
            (!s.user.empty() && clockNow() - s.authAt > 20)) {
            expired.push_back(s.socket);
            continue;
        }
        if (!ready()) {
            s.socket->shutdown(static_cast<drogon::CloseCode>(1013), "Database unavailable");
            expired.push_back(s.socket);
            continue;
        }
        if (s.user.empty())
            continue;
        if (clockNow() - s.authAt > 10 && !s.checking)
            verify(s.socket, s.token);
        Json::Value player;
        player["id"] = Json::UInt64(s.id);
        player["user_id"] = s.user;
        player["email"] = s.email;
        player["telemetry"] = s.telemetry.snapshot(clockNow());
        player["state"] = s.state;
        player["reactor"] = s.reactor;
        local.append(player);
    }
    for (const auto &socket : expired) {
        socket->shutdown(static_cast<drogon::CloseCode>(1013), "Session unavailable");
        closed(socket);
    }
    std::lock_guard<std::mutex> lock(mutex_);
    local_ = std::move(local);
}
void Game::received(Frame frame) {
    leader = frame.leader;
    epoch = frame.epoch;
    std::set<unsigned long long> peers;
    std::transform(frame.players.begin(), frame.players.end(), std::inserter(peers, peers.end()),
                   [](const Json::Value &p) { return p["id"].asUInt64(); });
    for (auto &[_, s] : sessions_) {
        if (s.user.empty())
            continue;
        if (!s.joined) {
            if (!peers.count(s.id)) {
                if (peers.size() >= 8)
                    s.socket->shutdown(drogon::CloseCode::kViolation, "Room is full");
                continue;
            }
            Json::Value welcome;
            welcome["type"] = "welcome";
            welcome["id"] = Json::UInt64(s.id);
            welcome["user_id"] = s.user;
            welcome["email"] = s.email;
            welcome["world_protocol"] = 2;
            welcome["reactor_protocol"] = 1;
            welcome["door_protocol"] = 1;
            welcome["rtc_config"]["iceServers"] = Json::Value(Json::arrayValue);
            welcome["peers"] = Json::Value(Json::arrayValue);
            for (auto id : peers)
                if (id != s.id)
                    welcome["peers"].append(Json::UInt64(id));
            send(s.socket, welcome);
            s.joined = true;
        } else {
            for (auto id : peers)
                if (id != s.id && !peers_.count(id)) {
                    Json::Value v;
                    v["type"] = "joined";
                    v["id"] = Json::UInt64(id);
                    send(s.socket, v);
                }
            for (auto id : peers_)
                if (id != s.id && !peers.count(id)) {
                    Json::Value v;
                    v["type"] = "left";
                    v["id"] = Json::UInt64(id);
                    send(s.socket, v);
                }
        }
        const auto now = clockNow();
        if (now - s.participantsAt >= 1) {
            send(s.socket, participantsMessage(frame.players, participantMetricsAdmin(s.email)));
            s.participantsAt = now;
        }
        if (s.telemetry.due(now))
            send(s.socket, s.telemetry.probe(randomId(), now));
        if (!frame.fish.empty())
            send(s.socket, frame.fish);
        for (const auto &p : frame.players)
            if (p["id"].asUInt64() != s.id && !p["state"].empty()) {
                Json::Value v;
                v["type"] = "player_state";
                v["from"] = p["id"];
                v["state"] = p["state"];
                send(s.socket, v);
            }
        for (const auto &signal : frame.signals)
            if (signal["to"].asUInt64() == s.id)
                send(s.socket, signal);
        if (frame.door["revision"].asUInt64() != s.doorRevision) {
            send(s.socket, frame.door);
            s.doorRevision = frame.door["revision"].asUInt64();
        }
        for (const auto &reply : frame.doorReplies)
            if (reply["to"].asUInt64() == s.id)
                send(s.socket, reply);
        if (s.reactor) {
            const auto version = frame.reactor["version"].asUInt64();
            if (version != s.reactorVersion) {
                send(s.socket, frame.reactor);
                s.reactorVersion = version;
            }
            for (const auto &entry : frame.reactorJournal)
                if (entry["serverSequence"].asUInt64() > s.journalSequence) {
                    Json::Value envelope;
                    envelope["type"] = "reactor_journal";
                    envelope["entry"] = entry;
                    send(s.socket, envelope);
                    s.journalSequence = entry["serverSequence"].asUInt64();
                }
            for (const auto &record : frame.reactorCommands)
                if (record["revision"].asUInt64() > s.commandRevision) {
                    Json::Value envelope;
                    envelope["type"] = "reactor_command_record";
                    envelope["record"] = record;
                    envelope["record"].removeMember("user_id");
                    send(s.socket, envelope);
                    s.commandRevision = record["revision"].asUInt64();
                }
            for (const auto &reply : frame.reactorReplies)
                if (reply["to"].asUInt64() == s.id)
                    send(s.socket, reply);
        }
    }
    peers_ = std::move(peers);
}
} // namespace planet
