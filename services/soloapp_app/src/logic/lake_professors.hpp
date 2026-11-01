#pragma once
#include <json/json.h>
#include <vector>

namespace planet {
class LakeProfessorsAuthority {
  public:
    static Json::Value update(Json::Value &data, const Json::Value &players,
                              const std::vector<Json::Value> &messages, long long now);
    static Json::Value publicState(const Json::Value &data, long long now);
};
} // namespace planet
