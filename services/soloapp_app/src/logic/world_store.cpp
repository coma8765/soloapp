#include "world_store.hpp"
#include "door.hpp"
#include "generated/odb/world-odb.hxx"
#include "json.hpp"
#include "lake_professors.hpp"
#include "odb/primary_pool.hpp"
#include "workers.hpp"
#include <algorithm>
#include <filesystem>
#include <memory>
#include <set>
namespace planet {
WorldStore::WorldStore(const std::string &dsn, const std::string &navigation, std::string id)
    : identity(std::move(id)), db_(solo::db::PoolConnectionInfo(dsn, solo::db::PoolConfigFromEnv()),
                                   std::unique_ptr<odb::pgsql::connection_factory>(
                                       new solo::db::PrimaryPool(solo::db::PoolConfigFromEnv()))),
      simulation_(navigation),
      reactor_((std::filesystem::path(navigation).parent_path() / "rbmk-profile.json").string()) {}
Frame WorldStore::exchange(const Json::Value &local, const std::vector<Json::Value> &signals,
                           const std::vector<Json::Value> &reactorMessages) {
    auto tx = solo::db::BeginPrimary(db_, [&] { return db_.query_value<Primary>().writable; });
    db_.execute("SET LOCAL statement_timeout=2000");
    db_.execute("SET LOCAL lock_timeout=1000");
    // The same DB row fences lease changes, admission, and checkpoint publication.
    auto rows = db_.query<World>("id=1 FOR UPDATE");
    auto it = rows.begin();
    if (it == rows.end())
        throw std::runtime_error("world_not_initialized");
    World world = *it;
    const auto now = db_.query_value<DatabaseTime>().now;
    using P = odb::query<Portal>;
    using S = odb::query<Signal>;
    db_.erase_query<Portal>(P::pulse_ms < now - 5000);
    db_.erase_query<Signal>(S::expires_ms < now);
    Frame frame;
    frame.players = Json::Value(Json::arrayValue);
    frame.signals = Json::Value(Json::arrayValue);
    std::set<unsigned long long> ids;
    for (const auto &portal : db_.query<Portal>(P::id != identity)) {
        for (auto player : decode(portal.players)) {
            ids.insert(player["id"].asUInt64());
            player["owner"] = portal.id;
            // Sample age uses each process's steady clock plus elapsed DB time
            // since the remote portal heartbeat, never wall-clock skew across sites.
            auto &sample = player["telemetry"];
            if (sample["age_ms"].isNumeric())
                sample["age_ms"] =
                    sample["age_ms"].asDouble() + std::max(0LL, now - portal.pulse_ms);
            frame.players.append(player);
        }
    }
    Json::Value admitted(Json::arrayValue);
    for (auto player : local) {
        if (frame.players.size() >= 8 || !ids.insert(player["id"].asUInt64()).second)
            continue;
        player["owner"] = identity;
        admitted.append(player);
        frame.players.append(player);
    }
    Portal mine{identity, now, encode(admitted)};
    std::unique_ptr<Portal> previous(db_.find<Portal>(identity));
    if (previous)
        db_.update(mine);
    else
        db_.persist(mine);
    for (const auto &message : signals) {
        // JSON round-tripping through PostgreSQL can change uintValue to intValue.
        // Route by the numeric peer ID, not Json::Value's internal number type.
        auto player =
            std::find_if(frame.players.begin(), frame.players.end(), [&](const Json::Value &p) {
                return p["id"].isUInt64() && message["to"].isUInt64() &&
                       p["id"].asUInt64() == message["to"].asUInt64();
            });
        if (player != frame.players.end()) {
            Signal signal{randomId(), (*player)["owner"].asString(), now + 10000, encode(message)};
            db_.persist(signal);
        }
    }
    std::vector<std::string> delivered;
    for (const auto &signal : db_.query<Signal>(S::target == identity)) {
        frame.signals.append(decode(signal.payload));
        delivered.push_back(signal.id);
    }
    for (const auto &id : delivered)
        db_.erase<Signal>(id);
    if (world.lease_ms <= now && world.owner != identity) {
        world.owner = identity;
        ++world.epoch;
    }
    frame.leader = world.owner == identity;
    frame.epoch = world.epoch;
    auto checkpoint = decode(world.checkpoint);
    auto reactor = decode(world.reactor);
    frame.reactorReplies = reactor_.update(reactor, frame.players, reactorMessages, now);
    frame.doorReplies = DoorAuthority::update(reactor["door"], frame.players, reactorMessages, now);
    frame.door = DoorAuthority::publicState(reactor["door"]);
    frame.professorReplies =
        LakeProfessorsAuthority::update(reactor["professors"], frame.players, reactorMessages, now);
    frame.professors = LakeProfessorsAuthority::publicState(reactor["professors"], now);
    frame.workersReplies =
        WorkersAuthority::update(reactor["workers"], frame.players, reactorMessages);
    frame.workers = WorkersAuthority::publicState(reactor["workers"]);
    frame.reactor = reactor_.publicState(reactor);
    // One database clock for room NPCs, including late joiners across replicas.
    frame.reactor["serverTime"] = Json::Int64(now);
    frame.reactorJournal = reactor["journal"];
    frame.reactorCommands = reactor["commands"];
    if (frame.leader) {
        // Always restore the last committed state. A failed/ambiguous commit must
        // never publish speculative local simulation on the next transaction.
        if (!checkpoint.empty())
            simulation_.restore(checkpoint);
        std::vector<Vec3> positions;
        for (const auto &player : frame.players) {
            const auto &p = player["state"]["position"];
            if (player["state"].get("map", "planet") == "planet" && p.isArray() && p.size() == 3)
                positions.push_back({p[0].asDouble(), p[1].asDouble(), p[2].asDouble()});
        }
        // Use database time rather than worker iterations: WAN latency must not
        // slow the world. Bound catch-up after downtime to avoid huge jumps.
        double remaining =
            world.advanced_ms == 0 ? 0.1 : std::clamp((now - world.advanced_ms) / 1000.0, 0.0, 1.0);
        while (remaining > 0.000001) {
            const double step = std::min(remaining, 0.05);
            simulation_.step(step, positions);
            remaining -= step;
        }
        world.advanced_ms = now;
        checkpoint = simulation_.checkpoint();
        world.snapshot = encode(simulation_.snapshot());
        world.lease_ms = now + 3000;
    }
    // A separate column survives old fish-only writers during a rolling
    // deployment. Commands, journal entries and snapshots share this commit.
    world.checkpoint = encode(checkpoint);
    const auto reactorJson = encode(reactor);
    if (frame.leader || reactorJson != world.reactor) {
        world.reactor = reactorJson;
        db_.update(world);
    }
    frame.fish = decode(world.snapshot);
    // Return only committed state, never a snapshot from a failed transaction.
    tx->commit();
    return frame;
}
} // namespace planet
