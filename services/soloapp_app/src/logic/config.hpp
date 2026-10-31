#pragma once
#include "json.hpp"
#include <cstdlib>
#include <fstream>
#include <sstream>
namespace planet {
inline std::string env(const char *name, const std::string &fallback) {
    auto p = std::getenv(name);
    return p ? p : fallback;
}
inline std::string read(const std::string &path) {
    std::ifstream f(path);
    if (!f)
        throw std::runtime_error("configuration_unavailable");
    return {std::istreambuf_iterator<char>(f), {}};
}
inline std::string quote(const std::string &value) {
    std::string out = "'";
    for (char c : value) {
        if (c == '\'' || c == '\\')
            out += '\\';
        out += c;
    }
    return out + "'";
}
inline std::string databaseConfig() {
    if (std::getenv("DATABASE_URL_FILE"))
        return read(std::getenv("DATABASE_URL_FILE"));
    auto c = decode(
        read(env("CHAT_CONFIG_FILE", "/run/soloapp-secrets/data/chat-client.json")))["database"];
    std::string hosts;
    for (const auto &h : c["hosts"]) {
        if (!hosts.empty())
            hosts += ",";
        hosts += h.asString();
    }
    if (hosts.empty() || c["ca_file"].asString().empty() || c["cert_file"].asString().empty())
        throw std::runtime_error("database_identity_missing");
    return "host=" + quote(hosts) + " port=" + std::to_string(c["port"].asInt()) +
           " dbname=" + quote(c["name"].asString()) + " user=" + quote(c["user"].asString()) +
           " password=" + quote(c["password"].asString()) +
           " sslmode=verify-full sslrootcert=" + quote(c["ca_file"].asString()) +
           " sslcert=" + quote(c["cert_file"].asString()) +
           " sslkey=" + quote(c["key_file"].asString()) +
           " target_session_attrs=read-write connect_timeout=2";
}
} // namespace planet
