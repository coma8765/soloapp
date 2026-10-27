#pragma once
#include <optional>
#include <string>
namespace solo::auth::logic {
struct UserRecord {
    std::string user_id, username, password_hash;
};
class Repository {
  public:
    virtual ~Repository() = default;
    virtual bool CreateUser(const UserRecord &) = 0;
    virtual std::optional<UserRecord> FindUser(const std::string &username) = 0;
    virtual void CreateSession(const std::string &token_hash, const std::string &user_id) = 0;
    virtual std::optional<std::string> FindSession(const std::string &token_hash) = 0;
    virtual void DeleteSession(const std::string &token_hash) = 0;
    virtual void CheckReady() = 0;
};
} // namespace solo::auth::logic
