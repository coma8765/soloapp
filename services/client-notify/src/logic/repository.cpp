#include "repository.hpp"
#include "generated/odb/task-odb.hxx"
#include "odb/primary_pool.hpp"
#include <chrono>
#include <odb/pgsql/exceptions.hxx>
namespace solo::notify {
long long NowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}
Repository::Repository(const std::string &dsn)
    : db_(solo::db::PoolConnectionInfo(dsn, solo::db::PoolConfigFromEnv()),
          std::unique_ptr<odb::pgsql::connection_factory>(
              new solo::db::PrimaryPool(solo::db::PoolConfigFromEnv()))) {}
std::unique_ptr<odb::transaction> Repository::Begin() {
    return solo::db::BeginPrimary(
        db_, [&] { return db_.query_value<model::WritablePrimary>().writable; });
}
Task Repository::Submit(const std::string &key, const std::string &recipient,
                        const std::string &payload) {
    try {
        auto tx = Begin();
        std::unique_ptr<Task> old(db_.find<Task>(key));
        if (old) {
            if (old->recipient != recipient || old->payload != payload)
                throw std::invalid_argument("idempotency_conflict");
            tx->commit();
            return *old;
        }
        Task task{key, recipient, payload, "pending", 0, NowMs(), 0, true, 0};
        db_.persist(task);
        tx->commit();
        return task;
    } catch (const odb::object_already_persistent &) {
        auto old = Get(key);
        if (!old || old->recipient != recipient || old->payload != payload)
            throw std::invalid_argument("idempotency_conflict");
        return *old;
    }
}
std::optional<Task> Repository::Get(const std::string &key) {
    auto tx = Begin();
    std::unique_ptr<Task> row(db_.find<Task>(key));
    std::optional<Task> result;
    if (row)
        result = *row;
    tx->commit();
    return result;
}
std::vector<Task> Repository::Pending() {
    auto tx = Begin();
    using Q = odb::query<Task>;
    auto now = NowMs();
    auto rows = db_.query<Task>((Q::state != "done" && Q::due_ms <= now &&
                                 (Q::needs_publish == true || Q::lease_ms <= now)) +
                                " ORDER BY due_ms LIMIT 32");
    std::vector<Task> result(rows.begin(), rows.end());
    tx->commit();
    return result;
}
void Repository::Published(const Task &snapshot, long long redelivery_ms) {
    try {
        auto tx = Begin();
        std::unique_ptr<Task> stored(db_.load<Task>(snapshot.task_id));
        auto &row = *stored;
        if (row.version == snapshot.version && row.state != "done") {
            row.needs_publish = false;
            row.lease_ms = NowMs() + redelivery_ms;
            db_.update(row);
        }
        tx->commit();
    } catch (const odb::object_changed &) {
    }
}
std::optional<Task> Repository::Claim(const std::string &key, long long ack_ms) {
    try {
        auto tx = Begin();
        std::unique_ptr<Task> stored(db_.load<Task>(key));
        auto &row = *stored;
        auto now = NowMs();
        if (row.state == "done" || row.due_ms > now ||
            (row.state == "inflight" && row.lease_ms > now)) {
            tx->commit();
            return std::nullopt;
        }
        row.state = "inflight";
        row.attempt++;
        row.lease_ms = now + ack_ms;
        row.needs_publish = false;
        db_.update(row);
        tx->commit();
        return row;
    } catch (const odb::object_changed &) {
        return std::nullopt;
    }
}
bool Repository::Finish(const Task &attempt, bool success, long long retry_ms) {
    try {
        auto tx = Begin();
        std::unique_ptr<Task> stored(db_.load<Task>(attempt.task_id));
        auto &row = *stored;
        if (row.state != "inflight" || row.attempt != attempt.attempt || row.lease_ms <= NowMs()) {
            tx->commit();
            return false;
        }
        row.state = success ? "done" : "pending";
        row.needs_publish = !success;
        row.due_ms = NowMs() + retry_ms;
        row.lease_ms = 0;
        db_.update(row);
        tx->commit();
        return true;
    } catch (const odb::object_changed &) {
        return false;
    }
}
void Repository::Ready() {
    auto tx = Begin();
    db_.query<Task>(odb::query<Task>("TRUE LIMIT 1"));
    tx->commit();
}
} // namespace solo::notify
