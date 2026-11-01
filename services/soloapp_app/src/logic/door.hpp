#pragma once
#include <json/json.h>
#include <vector>

namespace planet {
// Both physical entrances are views of this one PostgreSQL-owned door.
class DoorAuthority {
  public:
    static Json::Value update(Json::Value &data, const Json::Value &players,
                              const std::vector<Json::Value> &messages, long long now);
    static Json::Value publicState(const Json::Value &data);
};
} // namespace planet
