#pragma once
#include "odb/pool_config.hpp"
#include "repository.hpp"
#include <memory>
#include <odb/pgsql/database.hxx>
#include <odb/transaction.hxx>
namespace solo::auth::logic {
class OdbRepository final : public Repository {
  public:
    explicit OdbRepository(const std::string &connection_info,
                           const solo::db::PoolConfig &pool = {});
    bool CreateUser(const UserRecord &) override;
    std::optional<UserRecord> FindUser(const std::string &) override;
    void CreateSession(const std::string &, const std::string &) override;
    std::optional<std::string> FindSession(const std::string &) override;
    void DeleteSession(const std::string &) override;
    void CheckReady() override;

  private:
    std::unique_ptr<odb::transaction> Begin();
    odb::pgsql::database database_;
};
} // namespace solo::auth::logic
