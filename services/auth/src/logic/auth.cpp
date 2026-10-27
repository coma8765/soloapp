#include "auth.hpp"
#include <sodium.h>
#include <algorithm>
#include <cctype>
#include <vector>
namespace solo::auth::logic {
namespace {
std::string Hex(const unsigned char* data, std::size_t size) {
    std::string result(size * 2 + 1, '\0');
    sodium_bin2hex(result.data(), result.size(), data, size); result.resize(size * 2); return result;
}
std::string RandomHex(std::size_t size) {
    std::vector<unsigned char> data(size); randombytes_buf(data.data(), size); return Hex(data.data(), size);
}
std::string HashPassword(const std::string& password) {
    char result[crypto_pwhash_STRBYTES];
    if (crypto_pwhash_str(result, password.data(), password.size(), crypto_pwhash_OPSLIMIT_INTERACTIVE, crypto_pwhash_MEMLIMIT_INTERACTIVE)) throw std::runtime_error("hashing failed");
    return result;
}
struct WipePassword {
    std::string& password;
    ~WipePassword() { sodium_memzero(password.data(), password.size()); }
};
}
std::string NormalizeUsername(const std::string& username) {
    auto result = username;
    std::transform(result.begin(), result.end(), result.begin(), [](unsigned char c) { return std::tolower(c); });
    return result;
}
std::string ParseBearer(const std::string& header) {
    if (header.size() != 71 || header.compare(0, 7, "Bearer ") != 0) throw AuthError(401, "invalid session");
    auto token = header.substr(7);
    if (!std::all_of(token.begin(), token.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); })) throw AuthError(401, "invalid session");
    return token;
}
std::string TokenDigest(const std::string& token) {
    unsigned char hash[crypto_hash_sha256_BYTES];
    crypto_hash_sha256(hash, reinterpret_cast<const unsigned char*>(token.data()), token.size()); return Hex(hash, sizeof(hash));
}
AuthService::AuthService(Repository& repository) : repository_(repository), dummy_hash_(HashPassword(RandomHex(24))) {}
generated::UserId AuthService::Register(generated::Credentials credentials) {
    WipePassword wipe{credentials.password};
    UserRecord user{RandomHex(16), NormalizeUsername(credentials.username), HashPassword(credentials.password)};
    if (!repository_.CreateUser(user)) throw AuthError(409, "username unavailable");
    return {user.user_id};
}
generated::Session AuthService::Login(generated::Credentials credentials) {
    WipePassword wipe{credentials.password};
    auto user = repository_.FindUser(NormalizeUsername(credentials.username));
    const auto& hash = user ? user->password_hash : dummy_hash_;
    const bool matches = crypto_pwhash_str_verify(hash.c_str(), credentials.password.data(), credentials.password.size()) == 0;
    if (!user || !matches) throw AuthError(401, "invalid credentials");
    const auto token = RandomHex(32);
    repository_.CreateSession(TokenDigest(token), user->user_id);
    return {user->user_id, token, "Bearer", 86400};
}
generated::UserId AuthService::Verify(const std::string& authorization) {
    auto id = repository_.FindSession(TokenDigest(ParseBearer(authorization)));
    if (!id) throw AuthError(401, "invalid session");
    return {*id};
}
void AuthService::Logout(const std::string& authorization) { repository_.DeleteSession(TokenDigest(ParseBearer(authorization))); }
void AuthService::Ready() { repository_.CheckReady(); }
}
