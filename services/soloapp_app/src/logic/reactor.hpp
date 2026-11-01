#pragma once
#include <json/json.h>
#include <string>
#include <vector>
namespace planet {
// PostgreSQL owns command order, writer fencing and durable snapshots. The
// elected browser still computes the reduced physics; this is not a C++ solver.
class ReactorAuthority {
  public:
    explicit ReactorAuthority(const std::string &profile);
    Json::Value update(Json::Value &data, const Json::Value &players,
                       const std::vector<Json::Value> &messages, long long now) const;
    static Json::Value publicState(const Json::Value &data);

  private:
    Json::Value profile_;
    bool validControl(const std::string &name, const Json::Value &value) const;
    bool validSnapshot(const Json::Value &state) const;
    std::string command(Json::Value &data, const Json::Value &message, long long now,
                        const std::string &actor) const;
};
} // namespace planet
