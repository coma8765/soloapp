#pragma once
#include <cstdlib>
#include <stdexcept>
#include <string>
namespace solo::db {
struct PoolConfig {
    unsigned max_connections = 4;
    unsigned max_lifetime_seconds = 300;
    unsigned tcp_user_timeout_ms = 2000;
};
inline unsigned PoolSetting(const char* name, unsigned fallback, unsigned maximum) {
    const char* value = std::getenv(name);
    if (!value) return fallback;
    const std::string text(value);
    if (text.empty() || text.find_first_not_of("0123456789") != std::string::npos)
        throw std::invalid_argument(std::string("invalid pool setting: ") + name);
    const auto result = std::stoul(text);
    if (!result || result > maximum)
        throw std::invalid_argument(std::string("invalid pool setting: ") + name);
    return static_cast<unsigned>(result);
}
inline PoolConfig PoolConfigFromEnv() {
    return {PoolSetting("DB_POOL_MAX_CONNECTIONS", 4, 16),
            PoolSetting("DB_POOL_MAX_LIFETIME_SECONDS", 300, 3600),
            PoolSetting("DB_TCP_USER_TIMEOUT_MS", 2000, 10000)};
}
}
