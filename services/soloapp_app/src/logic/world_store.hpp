#pragma once
#include "models/world.hpp"
#include "reactor.hpp"
#include "simulation.hpp"
#include <json/json.h>
#include <odb/pgsql/database.hxx>
#include <string>
#include <vector>
namespace planet {
struct Frame {
    Json::Value players, fish, signals;
    Json::Value reactor, reactorReplies, reactorJournal, reactorCommands;
    Json::Value door, doorReplies;
    bool leader = false;
    unsigned long long epoch = 0;
};
class WorldStore {
  public:
    WorldStore(const std::string &dsn, const std::string &navigation, std::string identity);
    Frame exchange(const Json::Value &local, const std::vector<Json::Value> &signals,
                   const std::vector<Json::Value> &reactorMessages = {});
    const std::string identity;

  private:
    odb::pgsql::database db_;
    Simulation simulation_;
    ReactorAuthority reactor_;
};
} // namespace planet
