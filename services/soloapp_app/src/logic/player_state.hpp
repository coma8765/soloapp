#pragma once
#include <algorithm>
#include <cmath>
#include <json/json.h>
#include <numeric>

namespace planet {
inline bool validPlayerState(const Json::Value &v) {
    if (!v.isObject() || !v["sequence"].isUInt64() ||
        v["sequence"].asUInt64() > 9007199254740991ULL || !v["position"].isArray() ||
        v["position"].size() != 3 || !v["rotation"].isArray() || v["rotation"].size() != 4 ||
        !v["pitch"].isNumeric())
        return false;
    const auto finite = [](const Json::Value &n) {
        return n.isNumeric() && std::isfinite(n.asDouble());
    };
    if (!std::all_of(v["position"].begin(), v["position"].end(), finite) ||
        !std::all_of(v["rotation"].begin(), v["rotation"].end(), finite) || !finite(v["pitch"]) ||
        std::abs(v["pitch"].asDouble()) > std::acos(-1.0) / 2)
        return false;
    if ((v.isMember("avatarId") && (!v["avatarId"].isString() ||
                                    (v["avatarId"] != "scientist" && v["avatarId"] != "male" &&
                                     v["avatarId"] != "female" && v["avatarId"] != "uraraka"))) ||
        (v.isMember("speed") &&
         (!finite(v["speed"]) || v["speed"].asDouble() < 0 || v["speed"].asDouble() > 20)) ||
        (v.isMember("map") && !v["map"].isString()))
        return false;
    const auto norm = std::accumulate(
        v["rotation"].begin(), v["rotation"].end(), 0.0,
        [](double sum, const auto &q) { return sum + q.asDouble() * q.asDouble(); });
    if (std::abs(std::sqrt(norm) - 1) >= 0.05)
        return false;
    const auto map = v.get("map", "planet").asString();
    const double x = v["position"][0].asDouble(), y = v["position"][1].asDouble(),
                 z = v["position"][2].asDouble();
    if (map == "white-room" || map == "rbmk-training-room" || map == "rbmk-physical-system")
        return std::abs(x) <= 12 && std::abs(z) <= 12 && y >= 0 && y <= 6;
    const auto radius = std::sqrt(x * x + y * y + z * z);
    return map == "planet" && radius >= 25 && radius <= 50;
}
} // namespace planet
