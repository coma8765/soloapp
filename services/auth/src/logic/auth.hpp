#pragma once
#include "generated/api.hpp"
#include "repository.hpp"
#include <stdexcept>
namespace solo::auth::logic {
struct AuthError : std::runtime_error {
    int status;
    AuthError(int status, const std::string &message)
        : std::runtime_error(message), status(status) {}
};
std::string NormalizeUsername(const std::string &username);
std::string ParseBearer(const std::string &header);
std::string TokenDigest(const std::string &token);
class AuthService {
  public:
    explicit AuthService(Repository &repository);
    generated::UserId Register(generated::Credentials credentials);
    generated::Session Login(generated::Credentials credentials);
    generated::UserId Verify(const std::string &authorization);
    generated::Profile Profile(const std::string &authorization);
    void Logout(const std::string &authorization);
    void Ready();

  private:
    Repository &repository_;
    std::string dummy_hash_;
};
} // namespace solo::auth::logic
