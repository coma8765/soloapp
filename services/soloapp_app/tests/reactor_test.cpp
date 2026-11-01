#include "json.hpp"
#include "reactor.hpp"
#include <iostream>
#include <stdexcept>

namespace {
void check(bool valid, const char *message) {
    if (!valid)
        throw std::runtime_error(message);
}
Json::Value player(unsigned id, const char *user) {
    Json::Value result;
    result["id"] = id;
    result["user_id"] = user;
    result["reactor"] = true;
    return result;
}
Json::Value request(unsigned actor, const char *user, const char *id, const Json::Value &command) {
    Json::Value value;
    value["type"] = "reactor_command";
    value["from"] = actor;
    value["user_id"] = user;
    value["requestId"] = id;
    value["command"] = command;
    return value;
}
Json::Value control(const char *name, const char *mode, Json::Value value) {
    Json::Value command;
    command["kind"] = "control";
    command["name"] = name;
    command["mode"] = mode;
    command[mode == std::string("delta") ? "delta" : "value"] = std::move(value);
    return command;
}
} // namespace

int main(int argc, char **argv) {
    try {
        if (argc != 2)
            return 2;
        planet::ReactorAuthority authority(argv[1]);
        Json::Value data, players(Json::arrayValue);
        players.append(player(1, "a"));
        players.append(player(2, "b"));
        authority.update(data, players, {}, 1000);
        check(data["writer"].asUInt64() == 1, "writer election");
        const auto increment = control("targetPower", "delta", 5);
        auto replies = authority.update(
            data, players, {request(1, "a", "one", increment), request(2, "b", "two", increment)},
            2000);
        check(replies.size() == 2 && data["state"]["controls"]["targetPower"].asDouble() == 110,
              "concurrent deltas must serialize");
        check(data["revision"].asUInt64() == 2, "command revision");
        players.append(player(17, "a"));
        replies = authority.update(data, players, {request(17, "a", "one", increment)}, 2100);
        check(replies[0]["accepted"].asBool() && replies[0]["to"].asUInt64() == 17 &&
                  data["revision"].asUInt64() == 2,
              "retry after reconnect must be idempotent");
        const auto previous = data["state"];
        replies = authority.update(
            data, players, {request(2, "b", "invalid", control("targetPower", "set", 999))}, 2200);
        check(!replies[0]["accepted"].asBool() && data["state"] == previous,
              "invalid command must be atomic");
        replies = authority.update(
            data, players, {request(2, "b", "pump", control("mcpLeft1", "set", false))}, 2300);
        check(data["state"]["controls"]["pumpsLeft"].asInt() == 2, "pump aggregate");
        const auto scenarioBefore = data["state"]["controls"]["scenario"];
        authority.update(data, players,
                         {request(2, "b", "scenario", control("scenario", "delta", 1))}, 2400);
        check(data["state"]["controls"]["scenario"] != scenarioBefore, "scenario selector");
        Json::Value malformed;
        malformed["kind"] = "action";
        malformed["action"] = Json::Value(Json::objectValue);
        replies = authority.update(data, players, {request(2, "b", "malformed", malformed)}, 2500);
        check(!replies[0]["accepted"].asBool(), "malformed action");

        Json::Value snapshot;
        snapshot["type"] = "reactor_snapshot";
        snapshot["from"] = 1;
        snapshot["user_id"] = "a";
        snapshot["writerEpoch"] = data["writerEpoch"];
        snapshot["revision"] = data["revision"];
        snapshot["state"] = data["state"];
        snapshot["state"]["elapsed"] = 1.0;
        snapshot["state"]["power"] = 99.0;
        // Simulate JSON serialization between the DB and the wire (signed /
        // unsigned JsonCpp representation must not break epoch comparisons).
        data = planet::decode(planet::encode(data));
        snapshot = planet::decode(planet::encode(snapshot));
        authority.update(data, players, {snapshot}, 2600);
        check(data["state"]["power"] == 99.0, "valid committed snapshot");
        authority.update(data, players, {request(2, "b", "new", increment)}, 2700);
        snapshot["state"]["power"] = 500.0;
        authority.update(data, players, {snapshot}, 2800);
        check(data["state"]["power"] == 99.0, "stale revision must be fenced");
        Json::Value remaining(Json::arrayValue);
        remaining.append(player(2, "b"));
        authority.update(data, remaining, {}, 2900);
        snapshot["revision"] = data["revision"];
        authority.update(data, remaining, {snapshot}, 3000);
        check(data["writer"].asUInt64() == 2 && data["state"]["power"] == 99.0,
              "old elected writer must be fenced");

        Json::Value entry;
        entry["id"] = "note-1";
        entry["journal"] = "ИУР";
        entry["kind"] = "наблюдение";
        entry["text"] = "Показание проверено";
        entry["equipment"] = "Блок";
        entry["sender"] = "";
        entry["recipient"] = "";
        entry["ref"] = "";
        entry["eventAt"] = 0;
        entry["actor"] = "подставной автор";
        entry["status"] = "зафиксировано";
        Json::Value command;
        command["kind"] = "journal";
        command["entry"] = entry;
        replies = authority.update(data, remaining, {request(2, "b", "journal", command)}, 4000);
        check(replies[0]["accepted"].asBool() && data["journal"].size() == 1 &&
                  data["journal"][0]["actor"] == "участник #2" &&
                  data["journal"][0]["recordedAt"] == data["state"]["elapsed"],
              "journal author and recording time are server assigned");
        command["entry"]["id"] = "bad-ref";
        command["entry"]["kind"] = "исправление";
        command["entry"]["ref"] = "missing";
        replies = authority.update(data, remaining, {request(2, "b", "bad-ref", command)}, 4100);
        check(!replies[0]["accepted"].asBool() && data["journal"].size() == 1,
              "invalid correction must not change history");
        planet::ReactorAuthority restarted(argv[1]);
        auto restored = planet::decode(planet::encode(data));
        restarted.update(restored, remaining, {}, 4200);
        check(planet::encode(restored["state"]) == planet::encode(data["state"]) &&
                  planet::encode(restored["journal"]) == planet::encode(data["journal"]),
              "restoring serialized authority must preserve state and journal");
        auto legacy = data;
        legacy["state"]["modelVersion"] = 3;
        for (const char *name : {"fuelTemperatures", "voidFractions", "geometricLevels", "cycle"})
            legacy["state"].removeMember(name);
        legacy["state"]["loopMasses"][0] = 690000.0;
        legacy["state"]["loopEnergies"][0] = 870000.0;
        legacy["state"]["fuelTemperature"] = 710.0;
        const auto original = legacy;
        restarted.update(legacy, remaining, {}, 4300);
        check(legacy["state"]["modelVersion"] == 4 &&
                  legacy["previousModelState"] == original["state"] &&
                  legacy["state"]["controls"] == original["state"]["controls"] &&
                  legacy["state"]["elapsed"] == original["state"]["elapsed"] &&
                  legacy["state"]["fuelTemperatures"][0] == 710.0 &&
                  legacy["state"]["cycle"]["initialMass"] == 1910000.0 &&
                  legacy["journal"] == original["journal"] &&
                  legacy["commands"] == original["commands"] &&
                  legacy["receipts"] == original["receipts"] &&
                  legacy["revision"] == original["revision"] &&
                  legacy["writerEpoch"].asUInt64() == original["writerEpoch"].asUInt64() + 1,
              "v3 upgrade must preserve the exercise, audit and fence old writers");
        const auto upgraded = legacy;
        restarted.update(legacy, remaining, {}, 4400);
        check(legacy == upgraded, "v3 migration must run only once");
        auto invalidCycle = legacy["state"];
        invalidCycle["cycle"]["returnMass"][0] = -1;
        snapshot["from"] = 2;
        snapshot["user_id"] = "b";
        snapshot["writerEpoch"] = legacy["writerEpoch"];
        snapshot["revision"] = legacy["revision"];
        snapshot["state"] = invalidCycle;
        authority.update(legacy, remaining, {snapshot}, 4500);
        check(legacy == upgraded, "negative return inventory rejected");
        invalidCycle = legacy["state"];
        invalidCycle["cycle"].removeMember("initialEnergy");
        snapshot["state"] = invalidCycle;
        authority.update(legacy, remaining, {snapshot}, 4600);
        check(legacy == upgraded, "incomplete cycle rejected");
        std::cout << "PASS: command order, reconnect idempotency, validation, writer fencing, "
                     "journal identity and restore\n";
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
