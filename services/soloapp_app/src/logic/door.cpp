#include "door.hpp"
#include <algorithm>

namespace planet {
Json::Value DoorAuthority::update(Json::Value &data, const Json::Value &players,
                                  const std::vector<Json::Value> &messages, long long now) {
    if (!data.isObject()) {
        data["revision"] = Json::UInt64(1);
        data["open"] = false;
        data["openedAt"] = Json::Int64(0);
        data["closeAt"] = Json::Int64(0);
        data["closedAt"] = Json::Int64(0);
        data["receipts"] = Json::Value(Json::arrayValue);
    }
    const auto close = [&] {
        data["open"] = false;
        data["closedAt"] = Json::Int64(now);
        data["closeAt"] = Json::Int64(0);
        data["revision"] = Json::UInt64(data["revision"].asUInt64() + 1);
    };
    // Database time makes closing independent of browsers and of the elected writer.
    if (data["open"].asBool() && now >= data["closeAt"].asInt64())
        close();
    Json::Value replies(Json::arrayValue);
    for (const auto &m : messages) {
        if (m["type"] != "door_request" || !m["requestId"].isString() ||
            m["requestId"].asString().empty() || m["requestId"].asString().size() > 96)
            continue;
        const auto player = std::find_if(players.begin(), players.end(), [&](const auto &p) {
            return p["id"].asUInt64() == m["from"].asUInt64() && p["user_id"] == m["user_id"];
        });
        if (player == players.end())
            continue;
        const auto old =
            std::find_if(data["receipts"].begin(), data["receipts"].end(), [&](const auto &r) {
                return r["user_id"] == m["user_id"] && r["requestId"] == m["requestId"];
            });
        if (old != data["receipts"].end()) {
            auto reply = *old;
            reply["to"] = m["from"];
            replies.append(reply);
            continue;
        }
        Json::Value reply;
        reply["type"] = "door_ack";
        reply["to"] = m["from"];
        reply["user_id"] = m["user_id"];
        reply["requestId"] = m["requestId"];
        reply["action"] = m["action"];
        std::string error;
        const auto map = (*player)["state"].get("map", "planet");
        if ((m["side"] != "planet" && m["side"] != "rbmk-training-room") || m["side"] != map)
            error = "wrong_side";
        else if (!m["revision"].isUInt64() ||
                 m["revision"].asUInt64() != data["revision"].asUInt64())
            error = "stale_door";
        else if (m["action"] == "open") {
            if (!data["open"].asBool() && now - data["closedAt"].asInt64() < 500)
                error = "door_closing";
            else if (!data["open"].asBool()) {
                data["open"] = true;
                data["openedAt"] = Json::Int64(now);
                data["closeAt"] = Json::Int64(now + 8000);
                data["revision"] = Json::UInt64(data["revision"].asUInt64() + 1);
            }
        } else if (m["action"] == "pass") {
            if (!data["open"].asBool())
                error = "door_closed";
            else if (now - data["openedAt"].asInt64() < 500)
                error = "door_opening";
            else {
                close();
                reply["destination"] = m["side"] == "planet" ? "rbmk-training-room" : "planet";
            }
        } else
            error = "invalid_action";
        reply["accepted"] = error.empty();
        reply["error"] = error;
        reply["revision"] = data["revision"];
        data["receipts"].append(reply);
        if (data["receipts"].size() > 512) {
            Json::Value tail(Json::arrayValue);
            for (unsigned i = data["receipts"].size() - 512; i < data["receipts"].size(); ++i)
                tail.append(data["receipts"][i]);
            data["receipts"] = std::move(tail);
        }
        replies.append(reply);
    }
    return replies;
}

Json::Value DoorAuthority::publicState(const Json::Value &data) {
    Json::Value result;
    result["type"] = "door_state";
    result["storage"] = "postgresql";
    for (const char *name : {"revision", "open", "openedAt", "closeAt"})
        result[name] = data[name];
    return result;
}
} // namespace planet
