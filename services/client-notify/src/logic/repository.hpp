#pragma once
#include "models/task.hpp"
#include "odb/pool_config.hpp"
#include <memory>
#include <odb/pgsql/database.hxx>
#include <odb/transaction.hxx>
#include <optional>
#include <vector>
namespace solo::notify {
using Task = model::Task;
long long NowMs();
class Repository {
  public:
    explicit Repository(const std::string &dsn);
    Task Submit(const std::string &key, const std::string &recipient, const std::string &payload);
    std::optional<Task> Get(const std::string &key);
    std::vector<Task> Pending();
    void Published(const Task &snapshot, long long redelivery_ms);
    std::optional<Task> Claim(const std::string &key, long long ack_ms);
    bool Finish(const Task &attempt, bool success, long long retry_ms);
    void Ready();

  private:
    odb::pgsql::database db_;
    std::unique_ptr<odb::transaction> Begin();
};
} // namespace solo::notify
