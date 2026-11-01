#include "participants.hpp"
#include <iostream>
#include <limits>
#include <stdexcept>
namespace {
void check(bool ok, const char *message) {
    if (!ok)
        throw std::runtime_error(message);
}
} // namespace
int main() {
    try {
        planet::ParticipantTelemetry telemetry;
        check(telemetry.snapshot(0).isNull(), "unsampled metrics must be unknown");
        check(telemetry.due(0), "first probe missing");
        auto probe = telemetry.probe("server-nonce", 1);
        check(!telemetry.due(2), "overlapping probes");
        Json::Value reply;
        reply["nonce"] = "wrong";
        reply["fps"] = 72;
        check(!telemetry.accept(reply, 1.05), "forged nonce accepted");
        reply["nonce"] = probe["nonce"];
        reply["fps"] = -1;
        check(!telemetry.accept(reply, 1.05), "negative fps accepted");
        reply["fps"] = std::numeric_limits<double>::infinity();
        check(!telemetry.accept(reply, 1.05), "infinite fps accepted");
        reply["fps"] = 1001;
        check(!telemetry.accept(reply, 1.05), "unbounded fps accepted");
        reply["fps"] = 72;
        check(telemetry.accept(reply, 1.05), "valid sample rejected");
        check(!telemetry.accept(reply, 1.06), "probe replay accepted");
        check(telemetry.snapshot(1.06)["ping"].asDouble() == 50, "RTT must use server clock");
        Json::Value players(Json::arrayValue), player;
        player["id"] = 1;
        player["email"] = "member@example.test";
        player["user_id"] = "private-id";
        player["owner"] = "private-node";
        player["telemetry"] = telemetry.snapshot(2);
        players.append(player);
        const auto member = planet::participantsMessage(players, false);
        const auto admin = planet::participantsMessage(players, true);
        check(member["players"][0]["email"] == player["email"], "verified name missing");
        for (const char *field : {"fps", "ping", "telemetry", "user_id", "owner"})
            check(!member["players"][0].isMember(field), "private participant data leaked");
        check(admin["players"][0]["fps"] == 72, "admin cannot read fps");
        check(admin["players"][0]["ping"].asDouble() == 50, "admin cannot read RTT");
        players[0]["telemetry"] = telemetry.snapshot(7);
        check(planet::participantsMessage(players, true)["players"][0]["fps"].isNull(),
              "stale metrics retained");
        telemetry.probe("late", 8);
        reply["nonce"] = "late";
        check(!telemetry.accept(reply, 13.1), "expired probe accepted");
        telemetry.probe("hidden", 14);
        reply["nonce"] = "hidden";
        reply["fps"] = Json::Value();
        check(telemetry.accept(reply, 14.01), "hidden browser cannot report unknown fps");
        check(telemetry.snapshot(14.02)["fps"].isNull(), "unknown fps turned into zero");
        check(planet::participantMetricsAdmin("a@gmail.com"), "admin rejected");
        for (const char *email : {"", "member@example.test", "a@gmail.com.evil", "A@gmail.com"})
            check(!planet::participantMetricsAdmin(email), "non-admin accepted");
        std::cout << "PASS: telemetry nonce/RTT, validation, expiry and admin filtering\n";
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
