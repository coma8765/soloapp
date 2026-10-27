#pragma once
#include <odb/core.hxx>
#include <string>
namespace solo {
namespace notify {
namespace model {
#pragma db object optimistic table("notify_tasks")
struct Task {
#pragma db id type("TEXT")
    std::string task_id;
#pragma db type("TEXT")
    std::string recipient;
#pragma db type("TEXT")
    std::string payload;
#pragma db type("TEXT")
    std::string state;
    unsigned long long attempt;
    long long due_ms;
    long long lease_ms;
    bool needs_publish;
#pragma db version
    unsigned long long version;
};
#pragma db view query(                                                                             \
    "SELECT NOT pg_is_in_recovery() AND current_setting('transaction_read_only') = 'off'")
struct WritablePrimary {
    bool writable;
};
} // namespace model
} // namespace notify
} // namespace solo
