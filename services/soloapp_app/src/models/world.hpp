#pragma once
#include <odb/core.hxx>
#include <string>
namespace planet {
#pragma db object table("planet_world")
struct World {
#pragma db id
    unsigned long long id = 1;
    std::string owner;
    long long lease_ms = 0;
    long long advanced_ms = 0;
    unsigned long long epoch = 0;
    std::string checkpoint = "{}";
    std::string snapshot = "{}";
};
#pragma db object table("planet_portals")
struct Portal {
#pragma db id
    std::string id;
    long long pulse_ms = 0;
    std::string players = "[]";
};
#pragma db object table("planet_signals")
struct Signal {
#pragma db id
    std::string id;
    std::string target;
    long long expires_ms = 0;
    std::string payload;
};
#pragma db view query("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint")
struct DatabaseTime {
    long long now;
};
#pragma db view query(                                                                             \
    "SELECT NOT pg_is_in_recovery() AND current_setting('transaction_read_only') = 'off'")
struct Primary {
    bool writable;
};
} // namespace planet
