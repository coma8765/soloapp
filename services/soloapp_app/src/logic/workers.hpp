#pragma once
#include "participants.hpp"
#include <vector>

namespace planet {
// The world row lock serializes changes across both game replicas. Keep the
// setting outside the simulator snapshot so resets and browser writers preserve it.
class WorkersAuthority {
  public:
    static Json::Value update(Json::Value &data, const Json::Value &players,
                              const std::vector<Json::Value> &messages) {
        if (!data.isObject()) {
            data["revision"] = Json::UInt64(1);
            data["count"] = 7;
            data["receipts"] = Json::Value(Json::arrayValue);
        }
        Json::Value replies(Json::arrayValue);
        for (const auto &m : messages) {
            if (m["type"] != "workers_set" || !m["requestId"].isString() ||
                m["requestId"].asString().empty() || m["requestId"].asString().size() > 96)
                continue;
            const auto player = std::find_if(players.begin(), players.end(), [&](const auto &p) {
                return p["id"].asUInt64() == m["from"].asUInt64() && p["user_id"] == m["user_id"];
            });
            if (player == players.end())
                continue;
            Json::Value reply;
            reply["type"] = "workers_ack";
            reply["to"] = m["from"];
            reply["requestId"] = m["requestId"];
            if (!participantMetricsAdmin((*player).get("email", "").asString())) {
                reply["accepted"] = false;
                reply["error"] = "forbidden";
                replies.append(reply);
                continue;
            }
            const auto old =
                std::find_if(data["receipts"].begin(), data["receipts"].end(),
                             [&](const auto &r) { return r["requestId"] == m["requestId"]; });
            if (old != data["receipts"].end()) {
                reply = *old;
                reply["to"] = m["from"];
                replies.append(reply);
                continue;
            }
            std::string error;
            if (!m["count"].isInt() || m["count"].asInt() < 1 || m["count"].asInt() > 10)
                error = "invalid_count";
            else if (!m["revision"].isUInt64() ||
                     m["revision"].asUInt64() != data["revision"].asUInt64())
                error = "stale_workers";
            else if (m["count"] != data["count"]) {
                data["count"] = m["count"];
                data["revision"] = Json::UInt64(data["revision"].asUInt64() + 1);
            }
            reply["accepted"] = error.empty();
            reply["error"] = error;
            reply["revision"] = data["revision"];
            data["receipts"].append(reply);
            if (data["receipts"].size() > 128) {
                Json::Value removed;
                data["receipts"].removeIndex(0, &removed);
            }
            replies.append(reply);
        }
        return replies;
    }
    static Json::Value publicState(const Json::Value &data) {
        Json::Value result;
        result["type"] = "workers_state";
        result["storage"] = "postgresql";
        result["revision"] = data["revision"];
        result["count"] = data["count"];
        return result;
    }
};
} // namespace planet
