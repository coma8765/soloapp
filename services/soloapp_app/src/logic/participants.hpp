#pragma once
#include <algorithm>
#include <cmath>
#include <json/json.h>
#include <string>
namespace planet {
inline bool participantMetricsAdmin(const std::string &verifiedEmail) {
    return verifiedEmail == "a@gmail.com";
}
// RTT is measured by this server using an unpredictable one-use probe.
// FPS is necessarily a browser-reported sample, not an authorization input.
class ParticipantTelemetry {
  public:
    bool due(double now) const { return now - probeAt_ >= (nonce_.empty() ? 1.0 : 5.0); }
    Json::Value probe(const std::string &nonce, double now) {
        nonce_ = nonce;
        probeAt_ = now;
        Json::Value message;
        message["type"] = "telemetry_probe";
        message["nonce"] = nonce;
        return message;
    }
    bool accept(const Json::Value &message, double now) {
        const auto &fps = message["fps"];
        if (nonce_.empty() || !message["nonce"].isString() || message["nonce"] != nonce_ ||
            now < probeAt_ || now - probeAt_ > 5 ||
            !(fps.isNull() || (fps.isNumeric() && std::isfinite(fps.asDouble()) &&
                               fps.asDouble() >= 0 && fps.asDouble() <= 1000)))
            return false;
        nonce_.clear();
        sampleAt_ = now;
        fps_ = fps;
        ping_ = std::round((now - probeAt_) * 1000);
        return true;
    }
    Json::Value snapshot(double now) const {
        Json::Value result;
        if (sampleAt_ < 0)
            return result;
        result["fps"] = fps_;
        result["ping"] = ping_;
        result["age_ms"] = std::max(0.0, (now - sampleAt_) * 1000);
        return result;
    }

  private:
    std::string nonce_;
    double probeAt_ = -10, sampleAt_ = -1, ping_ = 0;
    Json::Value fps_;
};
inline Json::Value participantsMessage(const Json::Value &players, bool admin) {
    Json::Value result;
    result["type"] = "participants";
    result["admin"] = admin;
    result["players"] = Json::Value(Json::arrayValue);
    for (const auto &player : players) {
        Json::Value publicPlayer;
        publicPlayer["id"] = player["id"];
        publicPlayer["email"] = player.get("email", "");
        if (admin) {
            const auto &sample = player["telemetry"];
            const bool fresh = sample["age_ms"].isNumeric() && sample["age_ms"].asDouble() >= 0 &&
                               sample["age_ms"].asDouble() < 5000;
            publicPlayer["fps"] = fresh ? sample["fps"] : Json::Value();
            publicPlayer["ping"] = fresh ? sample["ping"] : Json::Value();
        }
        result["players"].append(publicPlayer);
    }
    return result;
}
} // namespace planet
