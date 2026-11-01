#include "api.hpp"
#include "generated/routes.hpp"
#include "logic/config.hpp"
#include "logic/professor.hpp"
#include "runtime/http.hpp"
#include "runtime/signing.hpp"
#include <drogon/WebSocketController.h>
#include <regex>
namespace {
planet::Game *current = nullptr;
bool authenticated(const drogon::HttpRequestPtr &req) {
    const auto id = req->getHeader("x-verified-user-id"),
               timestamp = req->getHeader("x-user-timestamp"),
               signature = req->getHeader("x-user-signature");
    try {
        if (!std::regex_match(id, std::regex("^[0-9a-f]{32}$")) ||
            !std::regex_match(timestamp, std::regex("^[0-9]{10}$")) || signature.size() != 64 ||
            std::llabs(std::time(nullptr) - std::stoll(timestamp)) > 30)
            throw std::invalid_argument("unauthorized");
        auto expected = userSignature(id, timestamp);
        if (sodium_memcmp(expected.data(), signature.data(), 64) != 0)
            throw std::invalid_argument("unauthorized");
        return true;
    } catch (...) {
        return false;
    }
}

} // namespace
class PlanetSocket : public drogon::WebSocketController<PlanetSocket> {
  public:
    WS_PATH_LIST_BEGIN
    WS_PATH_ADD(planet::routes::signal, drogon::Get);
    WS_PATH_LIST_END
    void handleNewConnection(const drogon::HttpRequestPtr &req,
                             const drogon::WebSocketConnectionPtr &socket) override {
        const auto allowed = planet::env("CHAT_ALLOWED_ORIGIN", "");
        if (allowed.empty() || req->getHeader("origin") != allowed) {
            socket->shutdown(drogon::CloseCode::kViolation, "Origin denied");
            return;
        }
        current->opened(socket);
    }
    void handleConnectionClosed(const drogon::WebSocketConnectionPtr &socket) override {
        current->closed(socket);
    }
    void handleNewMessage(const drogon::WebSocketConnectionPtr &socket, std::string &&text,
                          const drogon::WebSocketMessageType &type) override {
        if (type == drogon::WebSocketMessageType::Text)
            current->message(socket, text);
    }
};
void installApi(planet::Game &game) {
    current = &game;
    for (const char *path : {planet::routes::healthz, planet::routes::health_ready}) {
        const bool readiness = std::string(path) == planet::routes::health_ready;
        drogon::app().registerHandler(
            path,
            [&game, readiness](const drogon::HttpRequestPtr &, solo::Callback &&cb) {
                Json::Value body;
                body["status"] = (!readiness || game.ready()) ? "ok" : "unavailable";
                cb(solo::JsonResponse((!readiness || game.ready()) ? drogon::k200OK
                                                                   : drogon::k503ServiceUnavailable,
                                      body));
            },
            {drogon::Get});
    }
    for (const bool chief : {false, true}) {
        drogon::app().registerHandler(
            chief ? planet::routes::engineer_respond : planet::routes::professor_respond,
            [chief](const drogon::HttpRequestPtr &req, solo::Callback &&cb) {
                if (!authenticated(req)) {
                    cb(solo::Error(drogon::k401Unauthorized, "unauthorized"));
                    return;
                }
                if (req->getHeader("content-type") != "audio/wav" || req->body().size() < 44 ||
                    req->body().size() > 256044) {
                    cb(solo::Error(drogon::k400BadRequest, "invalid_wav"));
                    return;
                }
                (chief ? planet::engineerReply : planet::professorReply)(std::string(req->body()),
                                                                         std::move(cb));
            },
            {drogon::Post});
    }
    auto identity = [](const drogon::HttpRequestPtr &req, solo::Callback &&cb) {
        if (!authenticated(req)) {
            cb(solo::Error(drogon::k401Unauthorized, "unauthorized"));
            return;
        }
        Json::Value body;
        body["user_id"] = req->getHeader("x-verified-user-id");
        cb(solo::JsonResponse(drogon::k200OK, body));
    };
    for (const bool health : {true, false}) {
        drogon::app().registerHandler(
            health ? planet::routes::speech_health : planet::routes::speech_transcribe,
            [health](const drogon::HttpRequestPtr &req, solo::Callback &&cb) {
                if (!authenticated(req)) {
                    cb(solo::Error(drogon::k401Unauthorized, "unauthorized"));
                    return;
                }
                if (!health && (req->getHeader("content-type") != "audio/wav" ||
                                req->body().size() < 44 || req->body().size() > 256044)) {
                    cb(solo::Error(drogon::k400BadRequest, "invalid_wav"));
                    return;
                }
                auto client = drogon::HttpClient::newHttpClient(
                    planet::env("WHISPER_URL", "http://whisper.soloapp.svc.cluster.local:8178"));
                auto out = drogon::HttpRequest::newHttpRequest();
                out->setMethod(health ? drogon::Get : drogon::Post);
                out->setPath(health ? "/health" : "/transcribe");
                if (!health) {
                    out->setContentTypeString("audio/wav");
                    out->setBody(std::string(req->body()));
                }
                client->sendRequest(
                    out,
                    [client, cb = std::move(cb)](auto result, const auto &response) {
                        if (result != drogon::ReqResult::Ok || !response) {
                            cb(solo::Error(drogon::k503ServiceUnavailable, "speech_unavailable"));
                            return;
                        }
                        auto forwarded = drogon::HttpResponse::newHttpResponse();
                        forwarded->setStatusCode(response->statusCode());
                        forwarded->setContentTypeCode(drogon::CT_APPLICATION_JSON);
                        forwarded->addHeader("Cache-Control", "no-store");
                        forwarded->setBody(std::string(response->body()));
                        cb(forwarded);
                    },
                    health ? 3.0 : 90.0);
            },
            {health ? drogon::Get : drogon::Post});
    }
    drogon::app().registerHandler(planet::routes::user_id, identity, {drogon::Get});
    drogon::app().registerHandler("/api/v1/app-api/v1/user-id", identity, {drogon::Get});
    drogon::app().registerHandler("/api/v1/whoami/v1/user-id", identity, {drogon::Get});
    drogon::app().registerHandler("/user-id", identity, {drogon::Get});
    drogon::app().registerHandler(
        "/metrics",
        [&game](const drogon::HttpRequestPtr &, solo::Callback &&cb) {
            drogon::app().getLoop()->queueInLoop([&game, cb = std::move(cb)] {
                auto r = drogon::HttpResponse::newHttpResponse();
                r->addHeader("Content-Type", "text/plain; version=0.0.4");
                r->setBody("soloapp_world_leader " + std::to_string(game.leader && game.ready()) +
                           "\nsoloapp_world_epoch " + std::to_string(game.epoch) +
                           "\nsoloapp_world_connections " + std::to_string(game.connections()) +
                           "\nsoloapp_world_database_errors_total " +
                           std::to_string(game.databaseErrors.load()) + "\n");
                cb(r);
            });
        },
        {drogon::Get});
}
