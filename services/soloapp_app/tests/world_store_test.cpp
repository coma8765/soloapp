#include "world_store.hpp"
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <thread>
int run_test(int argc, char **argv) {
    if (argc != 3)
        return 2;
    planet::WorldStore first(argv[1], argv[2], "test-first");
    planet::WorldStore second(argv[1], argv[2], "test-second");
    const Json::Value empty(Json::arrayValue);
    auto initial = first.exchange(empty, {});
    auto follower = second.exchange(empty, {});
    if (!initial.reactor["serverTime"].isInt64() || initial.reactor["serverTime"].asInt64() <= 0 ||
        follower.reactor["serverTime"].asInt64() < initial.reactor["serverTime"].asInt64())
        throw std::runtime_error("Room NPC database clock missing or reversed across nodes");
    if (!initial.leader || follower.leader || initial.epoch != follower.epoch ||
        initial.fish != follower.fish)
        throw std::runtime_error("leader election failed");
    std::this_thread::sleep_for(std::chrono::milliseconds(3200));
    auto promoted = second.exchange(empty, {});
    if (!promoted.leader || promoted.epoch <= initial.epoch ||
        promoted.fish["sequence"].asUInt64() <= initial.fish["sequence"].asUInt64())
        throw std::runtime_error("checkpoint failover failed");
    if (promoted.reactor["serverTime"].asInt64() < initial.reactor["serverTime"].asInt64() + 3000)
        throw std::runtime_error("Room NPC clock stopped without a reactor writer");
    auto stale = first.exchange(empty, {});
    if (stale.leader || stale.epoch != promoted.epoch || stale.fish != promoted.fish)
        throw std::runtime_error("old leader not fenced");
    auto participant = [](unsigned id, const char *user) {
        Json::Value players(Json::arrayValue), p;
        p["id"] = id;
        p["user_id"] = user;
        p["reactor"] = true;
        p["state"] = Json::Value(Json::objectValue);
        players.append(p);
        return players;
    };
    const auto one = participant(1, "synthetic-user-1"), two = participant(2, "synthetic-user-2");
    first.exchange(one, {});
    auto joined = second.exchange(two, {});
    // PostgreSQL JSON decoding can change unsigned IDs to signed JSON integers.
    // Exercise the same 48-bit IDs and UInt64 signal targets as live WebSockets.
    auto checkSignals = [&](planet::WorldStore &sender, planet::WorldStore &receiver,
                            const Json::Value &senderPlayers, const Json::Value &receiverPlayers) {
        for (const char *type : {"sdp", "ice"}) {
            Json::Value signal;
            signal["type"] = type;
            signal["from"] = Json::UInt64(senderPlayers[0]["id"].asUInt64());
            signal["to"] = Json::UInt64(receiverPlayers[0]["id"].asUInt64());
            signal["payload"] = "synthetic-negotiation";
            auto sent = sender.exchange(senderPlayers, {signal});
            auto received = &sender == &receiver ? sent : receiver.exchange(receiverPlayers, {});
            if (received.signals.size() != 1 || received.signals[0]["type"] != type ||
                received.signals[0]["from"].asUInt64() != signal["from"].asUInt64() ||
                received.signals[0]["to"].asUInt64() != signal["to"].asUInt64() ||
                received.signals[0]["payload"] != signal["payload"])
                throw std::runtime_error("SDP/ICE signal was lost or misrouted");
            if (!receiver.exchange(receiverPlayers, {}).signals.empty())
                throw std::runtime_error("SDP/ICE signal delivered twice");
        }
    };
    auto peerOne = one, peerTwo = two;
    peerOne[0]["id"] = Json::UInt64(0x123456789abcULL);
    peerTwo[0]["id"] = Json::UInt64(0x23456789abcdULL);
    first.exchange(peerOne, {});
    second.exchange(peerTwo, {});
    checkSignals(first, second, peerOne, peerTwo);
    checkSignals(second, first, peerTwo, peerOne);
    checkSignals(first, first, peerOne, peerOne);
    first.exchange(one, {});
    second.exchange(two, {});
    std::cout << "PASS: bidirectional cross-node and same-node SDP/ICE delivery\n";
    Json::Value command;
    command["type"] = "reactor_command";
    command["from"] = 2;
    command["user_id"] = "synthetic-user-2";
    command["requestId"] = "postgres-increment";
    command["command"]["kind"] = "control";
    command["command"]["name"] = "targetPower";
    command["command"]["mode"] = "delta";
    command["command"]["delta"] = 5;
    auto changed = second.exchange(two, {}, {command});
    if (!changed.reactorReplies[0]["accepted"].asBool() ||
        changed.reactor["state"]["controls"]["targetPower"].asDouble() != 105)
        throw std::runtime_error("PostgreSQL command not committed");
    auto repeated = second.exchange(two, {}, {command});
    if (repeated.reactor["revision"].asUInt64() != changed.reactor["revision"].asUInt64())
        throw std::runtime_error("PostgreSQL retry applied twice");
    auto observed = first.exchange(one, {});
    if (observed.reactor["state"]["controls"]["targetPower"].asDouble() != 105)
        throw std::runtime_error("Cross-node reactor state did not converge");
    Json::Value snapshot;
    snapshot["type"] = "reactor_snapshot";
    snapshot["from"] = 1;
    snapshot["user_id"] = "synthetic-user-1";
    snapshot["writerEpoch"] = observed.reactor["writerEpoch"];
    snapshot["revision"] = observed.reactor["revision"];
    snapshot["state"] = observed.reactor["state"];
    snapshot["state"]["elapsed"] = 1.0;
    snapshot["state"]["power"] = 99.0;
    first.exchange(one, {}, {snapshot});
    planet::WorldStore restarted(argv[1], argv[2], "test-restarted");
    auto recovered = restarted.exchange(empty, {});
    if (recovered.reactor["state"]["power"].asDouble() != 99)
        throw std::runtime_error("Reactor snapshot did not survive node restart");
    first.exchange(empty, {});
    auto writerChanged = second.exchange(two, {});
    snapshot["state"]["power"] = 500.0;
    auto fenced = first.exchange(empty, {}, {snapshot});
    if (writerChanged.reactor["writer"].asUInt64() != 2 ||
        fenced.reactor["state"]["power"].asDouble() != 99)
        throw std::runtime_error("Old reactor writer not fenced in PostgreSQL");
    Json::Value entry;
    entry["id"] = "postgres-note";
    entry["journal"] = "ИУР";
    entry["kind"] = "наблюдение";
    entry["text"] = "Состояние проверено после переподключения";
    entry["equipment"] = "ГЦН-Л";
    entry["eventAt"] = 0;
    entry["status"] = "зафиксировано";
    for (const char *field : {"sender", "recipient", "ref"})
        entry[field] = "";
    command["requestId"] = "postgres-journal";
    command["command"] = Json::Value(Json::objectValue);
    command["command"]["kind"] = "journal";
    command["command"]["entry"] = entry;
    auto written = second.exchange(two, {}, {command});
    if (!written.reactorReplies[0]["accepted"].asBool() || written.reactorJournal.size() != 1)
        throw std::runtime_error("Journal entry not committed in PostgreSQL");
    planet::WorldStore reader(argv[1], argv[2], "test-reader");
    if (reader.exchange(empty, {}).reactorJournal[0]["id"] != "postgres-note")
        throw std::runtime_error("Journal entry did not survive fresh database connection");
    auto visitorOne = one, visitorTwo = two;
    for (auto *visitors : {&visitorOne, &visitorTwo}) {
        auto &p = (*visitors)[0];
        p["reactor"] = false;
        p["state"]["map"] = "planet";
        p["state"]["professorTarget"] = 0;
        for (int coordinate : {1, 0, 3})
            p["state"]["position"].append(coordinate);
    }
    first.exchange(visitorOne, {});
    second.exchange(visitorTwo, {});
    Json::Value question;
    question["type"] = "professor_command";
    question["from"] = 1;
    question["user_id"] = "synthetic-user-1";
    question["requestId"] = "professor-begin";
    question["turn"] = "shared-question";
    question["action"] = "begin";
    question["lake"] = 0;
    auto claimed = first.exchange(visitorOne, {}, {question});
    if (!claimed.professorReplies[0]["accepted"].asBool())
        throw std::runtime_error("Professor question not claimed");
    auto competing = question;
    competing["from"] = 2;
    competing["user_id"] = "synthetic-user-2";
    competing["turn"] = "competing-question";
    auto busy = second.exchange(visitorTwo, {}, {competing});
    if (busy.professorReplies[0]["error"] != "busy")
        throw std::runtime_error("Professor accepted concurrent questions across nodes");
    question["action"] = "result";
    question["requestId"] = "professor-result";
    question["text"] = "Вопрос у озера";
    question["answer"] = "Общий ответ профессора";
    auto answered = first.exchange(visitorOne, {}, {question});
    auto seen = second.exchange(visitorTwo, {});
    auto late = reader.exchange(empty, {});
    for (const auto *snapshot : {&seen.professors, &late.professors}) {
        const auto &lake = (*snapshot)["lakes"][0];
        if (lake["answer"] != question["answer"] || lake["focus"].asUInt64() != 1 ||
            lake["startedAt"].asInt64() != answered.professors["lakes"][0]["startedAt"].asInt64())
            throw std::runtime_error(
                "Professor text, focus or animation lost across nodes/late join");
    }
    std::cout << "PASS: PostgreSQL shared professor conversation, competing nodes and late join\n";
    std::cout << "PASS: single leader, checkpoint failover, old leader fenced\n";
    std::cout << "PASS: PostgreSQL reactor command ordering, idempotency, cross-node recovery, "
                 "writer fencing and journal persistence\n";
    return 0;
}
int main(int argc, char **argv) {
    try {
        return run_test(argc, argv);
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
