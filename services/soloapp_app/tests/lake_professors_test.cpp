#include "lake_professors.hpp"
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

using planet::LakeProfessorsAuthority;
void check(bool ok, const char *message) {
    if (!ok)
        throw std::runtime_error(message);
}
Json::Value player(unsigned id, unsigned lake = 0) {
    Json::Value p;
    p["id"] = id;
    p["user_id"] = std::to_string(id);
    p["state"]["map"] = "planet";
    p["state"]["professorTarget"] = lake;
    for (int coordinate : {int(id), 0, 3})
        p["state"]["position"].append(coordinate);
    return p;
}
Json::Value command(unsigned id, const char *turn, const char *action, unsigned lake = 0) {
    Json::Value m;
    m["type"] = "professor_command";
    m["from"] = id;
    m["user_id"] = std::to_string(id);
    m["lake"] = lake;
    m["turn"] = turn;
    m["requestId"] = std::string(turn) + action;
    m["action"] = action;
    m["text"] = "Как устроено озеро?";
    m["answer"] = "Это небольшой водоём на планете.";
    return m;
}
// Browser integration drives the actual authority through newline-delimited JSON.
int wire() {
    Json::Value data;
    Json::CharReaderBuilder reader;
    Json::StreamWriterBuilder writer;
    writer["indentation"] = "";
    for (std::string line; std::getline(std::cin, line);) {
        Json::Value input, output;
        std::string error;
        std::unique_ptr<Json::CharReader> parser(reader.newCharReader());
        check(parser->parse(line.data(), line.data() + line.size(), &input, &error), "wire JSON");
        std::vector<Json::Value> messages(input["messages"].begin(), input["messages"].end());
        const auto now = input["now"].asInt64();
        output["replies"] = LakeProfessorsAuthority::update(data, input["players"], messages, now);
        output["state"] = LakeProfessorsAuthority::publicState(data, now);
        std::cout << Json::writeString(writer, output) << std::endl;
    }
    return 0;
}
int main(int argc, char **argv) {
    try {
        if (argc == 2 && std::string(argv[1]) == "--wire")
            return wire();
        Json::Value data, players(Json::arrayValue);
        players.append(player(2));
        LakeProfessorsAuthority::update(data, players, {}, 1000);
        check(data["lakes"].size() == 4 && data["lakes"][0]["focus"].asUInt() == 2,
              "four lakes, initial focus");
        players.append(player(1));
        LakeProfessorsAuthority::update(data, players, {}, 1100);
        check(data["lakes"][0]["focus"].asUInt() == 2, "idle focus stays stable on arrival");
        auto replies = LakeProfessorsAuthority::update(
            data, players, {command(1, "a", "begin"), command(2, "b", "begin")}, 1200);
        check(replies[0]["accepted"].asBool() && replies[1]["error"] == "busy",
              "one concurrent question wins");
        check(data["lakes"][0]["focus"].asUInt() == 1 &&
                  data["lakes"][0]["position"] == players[1]["state"]["position"],
              "everyone faces the speaker");
        const auto started = data;
        LakeProfessorsAuthority::update(data, players, {command(1, "a", "begin")}, 1300);
        check(data == started, "lost begin ACK retry does not extend lease");
        replies = LakeProfessorsAuthority::update(data, players, {command(2, "b", "result")}, 1400);
        check(replies[0]["error"] == "stale_turn", "other user cannot publish answer");
        auto forged = command(1, "a", "result");
        forged["user_id"] = "other-session";
        replies = LakeProfessorsAuthority::update(data, players, {forged}, 1400);
        check(replies[0]["error"] == "not_visiting", "identity required");
        auto result = command(1, "a", "result");
        replies = LakeProfessorsAuthority::update(data, players, {result}, 1500);
        check(replies[0]["accepted"].asBool() && data["lakes"][0]["answer"] == result["answer"],
              "shared answer committed");
        const auto answered = data;
        result["answer"] = "Changed retry";
        LakeProfessorsAuthority::update(data, players, {result}, 1600);
        check(data == answered, "result retry cannot replace answer or restart animation");
        players[0]["state"]["professorTarget"] = 1;
        replies =
            LakeProfessorsAuthority::update(data, players, {command(2, "c", "begin", 1)}, 1700);
        check(replies[0]["accepted"].asBool() && data["lakes"][0]["phase"] == "answer",
              "lakes are independent");
        players[0]["state"]["map"] = "rbmk-training-room";
        replies =
            LakeProfessorsAuthority::update(data, players, {command(2, "c", "result", 1)}, 1800);
        check(replies[0]["error"] == "not_visiting" && data["lakes"][1]["phase"] == "idle",
              "leaving cancels pending turn");
        Json::StreamWriterBuilder writer;
        Json::CharReaderBuilder reader;
        const auto encoded = Json::writeString(writer, data);
        Json::Value recovered;
        std::string error;
        std::unique_ptr<Json::CharReader> parser(reader.newCharReader());
        check(parser->parse(encoded.data(), encoded.data() + encoded.size(), &recovered, &error),
              "restore JSON");
        auto snapshot = LakeProfessorsAuthority::publicState(recovered, 2000);
        check(snapshot["lakes"][0]["answer"] == data["lakes"][0]["answer"] &&
                  snapshot["lakes"][0]["startedAt"].asInt64() ==
                      data["lakes"][0]["startedAt"].asInt64() &&
                  snapshot["serverTime"].asInt64() == 2000,
              "late join gets answer and original animation timeline");
        LakeProfessorsAuthority::update(recovered, players, {}, 200000);
        check(recovered["lakes"][0]["phase"] == "idle" &&
                  recovered["lakes"][0]["answer"] == answered["lakes"][0]["answer"],
              "animation expires, answer remains");
        replies = LakeProfessorsAuthority::update(
            recovered, players, {command(1, "a", "result"), command(1, "a", "begin")}, 200001);
        check(replies[0]["error"] == "stale_turn" && replies[1]["error"] == "stale_turn",
              "expired turn cannot restart");
        LakeProfessorsAuthority::update(recovered, players, {command(1, "d", "begin")}, 200002);
        LakeProfessorsAuthority::update(recovered, players, {}, 380003);
        check(recovered["lakes"][0]["phase"] == "idle", "hung HTTP request releases professor");
        LakeProfessorsAuthority::update(
            recovered, players, {command(1, "e", "begin"), command(1, "e", "cancel")}, 380004);
        check(recovered["lakes"][0]["phase"] == "idle", "abort releases professor");
        auto bad = command(1, "f", "begin");
        bad["lake"] = 4;
        check(LakeProfessorsAuthority::update(recovered, players, {bad}, 380005).empty(),
              "invalid lake ignored");
        std::cout << "PASS: shared focus, concurrency, retries, isolation, identity, persistence, "
                     "late join, cancellation and timeout\n";
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
