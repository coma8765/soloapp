#pragma once
#include <boost/date_time/posix_time/posix_time_types.hpp>
#include <odb/core.hxx>
#include <string>
// Keep the existing timestamptz schema. Convert ODB's timezone-free ptime in UTC.
#pragma db map type("TIMESTAMPTZ") as("TIMESTAMP") to("((?) AT TIME ZONE 'UTC')")                  \
    from("((?) AT TIME ZONE 'UTC')")
namespace solo {
namespace auth {
namespace model {
#pragma db object table("users")
struct User {
#pragma db id type("TEXT")
    std::string user_id;
#pragma db type("TEXT") unique
    std::string username;
#pragma db type("TEXT")
    std::string password_hash;
};
#pragma db object table("sessions")
struct Session {
#pragma db id type("TEXT")
    std::string token_hash;
#pragma db type("TEXT")
    std::string user_id;
#pragma db type("TIMESTAMPTZ")
    boost::posix_time::ptime expires_at;
};
// Generated ODB view: validate pooled connections before any business operation.
#pragma db view query(                                                                             \
    "SELECT NOT pg_is_in_recovery() AND current_setting('transaction_read_only') = 'off'")
struct WritablePrimary {
    bool writable;
};
} // namespace model
} // namespace auth
} // namespace solo
