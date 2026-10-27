#pragma once
#include "pool_config.hpp"
#include <odb/pgsql/connection-factory.hxx>
#include <odb/pgsql/database.hxx>
#include <odb/exceptions.hxx>
#include <odb/transaction.hxx>
#include <chrono>
#include <memory>
#include <stdexcept>
namespace solo::db {
// ODB owns connection limits, waiting and disposal of mark_failed() connections.
// min=0 retains lazily created connections up to the explicit maximum.
class PrimaryPool final : public odb::pgsql::connection_pool_factory {
 public:
    explicit PrimaryPool(const PoolConfig& config)
        : connection_pool_factory(config.max_connections, 0),
          lifetime_(config.max_lifetime_seconds) {}
    odb::pgsql::connection_ptr connect() override {
        for (;;) {
            auto connection = connection_pool_factory::connect();
            const auto& timed = static_cast<const TimedConnection&>(*connection);
            if (Clock::now() - timed.created < lifetime_) return connection;
            // A new checkout after rotation will reread the TLS files via libpq.
            connection->mark_failed();
        }
    }
 protected:
    using Clock = std::chrono::steady_clock;
    struct TimedConnection final : pooled_connection {
        explicit TimedConnection(database_type& database)
            : pooled_connection(database), created(Clock::now()) {}
        const Clock::time_point created;
    };
    pooled_connection_ptr create() override {
        return pooled_connection_ptr(new (odb::details::shared) TimedConnection(*db_));
    }
 private:
    const std::chrono::seconds lifetime_;
};
inline std::string PoolConnectionInfo(const std::string& info, const PoolConfig& config) {
    // connect_timeout only covers new connections. Bound stalled established TCP
    // connections as well, so pooling cannot turn a partition into a minutes-long hang.
    return info + " application_name=soloapp-auth tcp_user_timeout=" +
        std::to_string(config.tcp_user_timeout_ms) +
        " keepalives=1 keepalives_idle=2 keepalives_interval=1 keepalives_count=2";
}
// Only connection acquisition and the read-only primary check may be repeated.
// Business statements and commits are outside this helper and are never replayed.
template<class CheckWritable>
std::unique_ptr<odb::transaction> BeginPrimary(odb::pgsql::database& database, CheckWritable check) {
    for (unsigned attempt = 0; attempt != 2; ++attempt) {
        auto connection = database.connection();
        try {
            auto transaction = std::make_unique<odb::transaction>(connection->begin());
            if (check()) return transaction;
            connection->mark_failed();
            // transaction rolls back before the failed connection returns to the pool.
        } catch (const odb::connection_lost&) {
            connection->mark_failed();
            if (attempt == 1) throw;
        }
    }
    throw std::runtime_error("writable primary unavailable");
}
}
