#include "door.hpp"
#include <iostream>
#include <memory>
#include <stdexcept>

void check(bool ok, const char *message) {
    if (!ok)
        throw std::runtime_error(message);
}
Json::Value request(unsigned actor, const char *id, const char *action, const char *side,
                    const Json::Value &data) {
    Json::Value m;
    m["type"] = "door_request";
    m["from"] = actor;
    m["user_id"] = actor == 2 ? "b" : "a";
    m["requestId"] = id;
    m["action"] = action;
    m["side"] = side;
    m["revision"] = data["revision"];
    return m;
}
int main() {
    try {
        using planet::DoorAuthority;
        Json::Value data, players(Json::arrayValue);
        for (unsigned id : {1, 2}) {
            Json::Value p;
            p["id"] = id;
            p["user_id"] = id == 1 ? "a" : "b";
            p["reactor"] = id == 2;
            p["state"]["map"] = id == 1 ? "planet" : "rbmk-training-room";
            players.append(p);
        }
        DoorAuthority::update(data, players, {}, 1000);
        check(!data["open"].asBool(), "initially closed");
        auto replies = DoorAuthority::update(data, players,
                                             {request(1, "closed", "pass", "planet", data)}, 1100);
        check(!replies[0]["accepted"].asBool(), "closed door blocks passage");
        auto open = request(1, "open", "open", "planet", data);
        replies = DoorAuthority::update(data, players, {open}, 1200);
        check(replies[0]["accepted"].asBool() && data["open"].asBool(),
              "planet user opens without reactor join");
        const auto opened = data;
        replies = DoorAuthority::update(data, players, {open}, 1300);
        check(replies[0]["accepted"].asBool() && data == opened, "retry does not extend timeout");
        replies = DoorAuthority::update(data, players,
                                        {request(1, "early", "pass", "planet", data)}, 1400);
        check(!replies[0]["accepted"].asBool(), "wait for opening");
        const auto a = request(1, "a-pass", "pass", "planet", data);
        const auto b = request(2, "b-pass", "pass", "rbmk-training-room", data);
        replies = DoorAuthority::update(data, players, {a, b}, 1800);
        check(replies[0]["accepted"].asBool() &&
                  replies[0]["destination"] == "rbmk-training-room" &&
                  !replies[1]["accepted"].asBool() && !data["open"].asBool(),
              "concurrent passes serialize and close");
        auto revision = data["revision"];
        players[0]["id"] = 17;
        players[0]["state"]["map"] = "rbmk-training-room";
        auto retry = a;
        retry["from"] = 17;
        replies = DoorAuthority::update(data, players, {retry}, 1900);
        check(replies[0]["accepted"].asBool() && replies[0]["to"] == 17 &&
                  data["revision"] == revision,
              "lost pass ACK replays after reconnect");
        replies = DoorAuthority::update(data, players,
                                        {request(2, "wrong", "open", "planet", data)}, 2000);
        check(!replies[0]["accepted"].asBool(), "cannot claim other side");
        auto forged = request(2, "forged", "open", "rbmk-training-room", data);
        forged["user_id"] = "a";
        check(DoorAuthority::update(data, players, {forged}, 2100).empty(),
              "session identity required");
        replies = DoorAuthority::update(
            data, players, {request(2, "closing", "open", "rbmk-training-room", data)}, 2200);
        check(replies[0]["error"] == "door_closing", "finish closing before next opening");
        DoorAuthority::update(
            data, players, {request(2, "return-open", "open", "rbmk-training-room", data)}, 2400);
        replies = DoorAuthority::update(
            data, players, {request(2, "return-pass", "pass", "rbmk-training-room", data)}, 3000);
        check(replies[0]["destination"] == "planet" && !data["open"].asBool(),
              "return closes door");
        DoorAuthority::update(
            data, players, {request(2, "timeout-open", "open", "rbmk-training-room", data)}, 3600);
        Json::StreamWriterBuilder writer;
        Json::CharReaderBuilder reader;
        auto encoded = Json::writeString(writer, data);
        Json::Value recovered;
        std::string error;
        std::unique_ptr<Json::CharReader> parser(reader.newCharReader());
        check(parser->parse(encoded.data(), encoded.data() + encoded.size(), &recovered, &error),
              "decode persistence");
        check(DoorAuthority::publicState(recovered)["open"].asBool(), "late join sees open state");
        DoorAuthority::update(recovered, Json::Value(Json::arrayValue), {}, 11600);
        check(!recovered["open"].asBool(), "closes without clients after restart");
        check(!DoorAuthority::publicState(recovered).isMember("receipts"), "receipts private");
        std::cout << "PASS: door passage, concurrency, retries, identity, restore and timeout\n";
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
