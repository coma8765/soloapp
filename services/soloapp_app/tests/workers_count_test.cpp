#include "workers.hpp"
#include <iostream>
#include <stdexcept>
void check(bool ok, const char *message) {
    if (!ok)
        throw std::runtime_error(message);
}
int main() {
    try {
        Json::Value data, players(Json::arrayValue), player, command;
        player["id"] = 1;
        player["user_id"] = "admin-user";
        player["email"] = "a@gmail.com";
        players.append(player);
        planet::WorkersAuthority::update(data, players, {});
        check(data["count"] == 7, "default count");
        command["type"] = "workers_set";
        command["from"] = Json::UInt64(1);
        command["user_id"] = "admin-user";
        command["requestId"] = "first";
        command["revision"] = 1;
        command["count"] = 10;
        auto reply = planet::WorkersAuthority::update(data, players, {command});
        check(reply[0]["accepted"].asBool() && data["count"] == 10, "admin change rejected");
        command["count"] = 1;
        reply = planet::WorkersAuthority::update(data, players, {command});
        check(reply[0]["accepted"].asBool() && data["count"] == 10, "replayed request applied");
        command["requestId"] = "stale";
        reply = planet::WorkersAuthority::update(data, players, {command});
        check(reply[0]["error"] == "stale_workers", "stale revision accepted");
        command["revision"] = data["revision"];
        for (auto bad : {Json::Value(0), Json::Value(11), Json::Value(1.5), Json::Value("5")}) {
            command["count"] = bad;
            command["requestId"] = bad.toStyledString();
            reply = planet::WorkersAuthority::update(data, players, {command});
            check(reply[0]["error"] == "invalid_count", "bad count accepted");
        }
        players[0]["email"] = "member@example.test";
        command["email"] = "a@gmail.com";
        command["admin"] = true;
        command["requestId"] = "forged";
        command["count"] = 1;
        reply = planet::WorkersAuthority::update(data, players, {command});
        check(reply[0]["error"] == "forbidden" && data["count"] == 10, "forged admin accepted");
        players[0]["email"] = "a@gmail.com";
        command["requestId"] = "last";
        reply = planet::WorkersAuthority::update(data, players, {command});
        check(reply[0]["accepted"].asBool() && data["count"] == 1, "minimum count rejected");
        check(!planet::WorkersAuthority::publicState(data).isMember("receipts"), "receipts leaked");
        std::cout << "PASS: workers authorization, bounds, replay and concurrent revisions\n";
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
