#include "odb/primary_pool.hpp"
#include "generated/odb/entities-odb.hxx"
#include <libpq-fe.h>
#include <cstdlib>
#include <iostream>
int main() {
    try {
        solo::db::PoolConfig config;
        config.max_connections = 1;
        odb::pgsql::database db(solo::db::PoolConnectionInfo(std::getenv("PGPOOL_TEST_DSN"), config),
            std::unique_ptr<odb::pgsql::connection_factory>(new solo::db::PrimaryPool(config)));
        int previous_pid;
        {
            auto connection = db.connection();
            previous_pid = PQbackendPID(connection->handle());
            odb::transaction transaction(connection->begin());
            db.execute("SET default_transaction_read_only = on");
            transaction.commit();
        }
        auto transaction = solo::db::BeginPrimary(db, [&] {
            return db.query_value<solo::auth::model::WritablePrimary>().writable;
        });
        auto& connection = static_cast<odb::pgsql::connection&>(transaction->connection());
        if (PQbackendPID(connection.handle()) == previous_pid) return 2;
        if (!db.query_value<solo::auth::model::WritablePrimary>().writable) return 3;
        transaction->commit();
        std::cout << "replaced-read-only-connection" << std::endl;
    } catch (const std::exception&) { return 1; }
}
