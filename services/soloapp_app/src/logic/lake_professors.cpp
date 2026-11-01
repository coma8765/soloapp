#include "lake_professors.hpp"
#include <algorithm>
#include <cmath>

namespace planet {
namespace {
bool text(const Json::Value &v, size_t limit) {
    return v.isString() && !v.asString().empty() && v.asString().size() <= limit;
}
bool visiting(const Json::Value &p, unsigned lake) {
    const auto &s = p["state"];
    return s.get("map", "planet") == "planet" && s["professorTarget"].isUInt() &&
           s["professorTarget"].asUInt() == lake && s["position"].isArray() &&
           s["position"].size() == 3 &&
           std::all_of(s["position"].begin(), s["position"].end(),
                       [](const auto &v) { return v.isNumeric() && std::isfinite(v.asDouble()); });
}
} // namespace
Json::Value LakeProfessorsAuthority::update(Json::Value &data, const Json::Value &players,
                                            const std::vector<Json::Value> &messages,
                                            long long now) {
    if (!data["lakes"].isArray() || data["lakes"].size() != 4) {
        data = Json::Value(Json::objectValue);
        data["revision"] = Json::UInt64(1);
        for (unsigned id = 0; id < 4; ++id) {
            Json::Value s;
            s["id"] = id;
            s["owner"] = s["focus"] = Json::UInt64(0);
            s["turn"] = s["text"] = s["answer"] = "";
            s["phase"] = "idle";
            s["until"] = s["startedAt"] = Json::Int64(0);
            s["position"] = Json::Value();
            data["lakes"].append(s);
        }
    }
    const auto before = data["lakes"];
    for (auto &s : data["lakes"]) {
        const auto owner = std::find_if(players.begin(), players.end(), [&](const auto &p) {
            return p["id"].asUInt64() == s["owner"].asUInt64() && visiting(p, s["id"].asUInt());
        });
        if (now >= s["until"].asInt64() || (s["phase"] == "thinking" && owner == players.end()))
            s["phase"] = "idle";
    }
    Json::Value replies(Json::arrayValue);
    for (const auto &m : messages) {
        if (m["type"] != "professor_command" || !text(m["requestId"], 96) || !text(m["turn"], 96) ||
            !m["lake"].isUInt() || m["lake"].asUInt() >= 4)
            continue;
        Json::Value reply;
        reply["type"] = "professor_ack";
        reply["to"] = m["from"];
        reply["requestId"] = m["requestId"];
        auto &s = data["lakes"][m["lake"].asUInt()];
        const auto player = std::find_if(players.begin(), players.end(), [&](const auto &p) {
            return p["id"].asUInt64() == m["from"].asUInt64() && p["user_id"] == m["user_id"];
        });
        const bool own = s["owner"].asUInt64() == m["from"].asUInt64() && s["turn"] == m["turn"];
        std::string error;
        if (player == players.end() || !visiting(*player, m["lake"].asUInt()))
            error = "not_visiting";
        else if (m["action"] == "begin") {
            if (!own && s["phase"] != "idle")
                error = "busy";
            else if (own && s["phase"] == "idle")
                error = "stale_turn";
            else if (!own) {
                s["owner"] = m["from"];
                s["turn"] = m["turn"];
                s["phase"] = "thinking";
                s["startedAt"] = Json::Int64(now);
                s["until"] = Json::Int64(now + 180000);
            }
        } else if (!own)
            error = "stale_turn";
        else if (m["action"] == "result") {
            if (!text(m["text"], 4096) || !text(m["answer"], 4000))
                error = "invalid_result";
            else if (s["phase"] == "thinking") {
                s["text"] = m["text"];
                s["answer"] = m["answer"];
                s["phase"] = "answer";
                s["startedAt"] = Json::Int64(now);
                const auto &answer = m["answer"].asString();
                const auto words = std::count(answer.begin(), answer.end(), ' ') + 1;
                s["until"] = Json::Int64(now + std::min<long long>(90000, 4000 + words * 500));
            } else if (s["phase"] != "answer")
                error = "stale_turn";
        } else if (m["action"] == "cancel") {
            if (s["phase"] == "thinking")
                s["phase"] = "idle";
        } else
            error = "invalid_action";
        reply["accepted"] = error.empty();
        reply["error"] = error;
        replies.append(reply);
    }
    for (auto &s : data["lakes"]) {
        const Json::Value *focus = nullptr;
        // Keep a stable visitor while idle; the current speaker takes precedence.
        const auto preferred = s["phase"] == "idle" ? s["focus"].asUInt64() : s["owner"].asUInt64();
        for (const auto &p : players) {
            if (!visiting(p, s["id"].asUInt()))
                continue;
            if (!focus || ((*focus)["id"].asUInt64() != preferred &&
                           (p["id"].asUInt64() == preferred ||
                            p["id"].asUInt64() < (*focus)["id"].asUInt64())))
                focus = &p;
        }
        s["focus"] = focus ? (*focus)["id"] : Json::Value(Json::UInt64(0));
        s["position"] = focus ? (*focus)["state"]["position"] : Json::Value();
    }
    if (data["lakes"] != before)
        data["revision"] = Json::UInt64(data["revision"].asUInt64() + 1);
    return replies;
}
Json::Value LakeProfessorsAuthority::publicState(const Json::Value &data, long long now) {
    auto result = data;
    result["type"] = "professor_state";
    result["storage"] = "postgresql";
    result["serverTime"] = Json::Int64(now);
    return result;
}
} // namespace planet
