#include "config.hpp"
#include <cstdlib>
#include <fstream>
#include <json/json.h>
#include <sstream>
#include <stdexcept>
namespace solo::notify {
std::string SecretFile(const char *variable) {
    const char *name = std::getenv(variable);
    if (!name)
        throw std::runtime_error("Missing secret file");
    std::ifstream file(name);
    std::ostringstream text;
    text << file.rdbuf();
    if (!file || text.str().empty())
        throw std::runtime_error("Missing secret file");
    auto value = text.str();
    while (!value.empty() && (value.back() == '\n' || value.back() == '\r'))
        value.pop_back();
    return value;
}
Config Config::Load() {
    auto text = SecretFile("NOTIFY_CONFIG_FILE");
    Json::Value j;
    Json::CharReaderBuilder builder;
    std::istringstream in(text);
    std::string errors;
    if (!Json::parseFromStream(builder, in, &j, &errors))
        throw std::runtime_error("Invalid config");
    Config c;
    auto r = j["rabbitmq"];
    auto g = j["gateway"];
    c.rabbit_host = r["host"].asString();
    c.rabbit_user = r["user"].asString();
    c.rabbit_password = r["password"].asString();
    c.rabbit_ca = r["ca_file"].asString();
    c.queue = r.get("queue", "client-notify").asString();
    c.rabbit_port = r.get("port", 5671).asInt();
    c.rabbit_tls = r.get("tls", true).asBool();
    c.gateway_url = g["url"].asString();
    c.gateway_ca = g["ca_file"].asString();
    c.gateway_cert = g["cert_file"].asString();
    c.gateway_key = g["key_file"].asString();
    c.gateway_token = g["token"].asString();
    c.delivery_ms = j.get("delivery_timeout_ms", 10000).asUInt();
    c.ack_ms = j.get("ack_timeout_ms", 30000).asUInt();
    c.retry_ms = j.get("retry_delay_ms", 1000).asUInt();
    if (c.rabbit_host.empty() || c.rabbit_user.empty() || c.rabbit_password.empty() ||
        c.gateway_url.empty() || c.gateway_token.empty() || c.queue.empty() || c.delivery_ms < 1 ||
        c.ack_ms <= c.delivery_ms + 1000 || c.ack_ms > 300000 || c.retry_ms < 100 ||
        c.retry_ms > 10000)
        throw std::runtime_error("Invalid config bounds");
    const bool test = std::getenv("NOTIFY_TEST_ALLOW_PLAINTEXT") != nullptr;
    if (!test && (!c.rabbit_tls || c.rabbit_ca.empty() || c.gateway_url.rfind("https://", 0) != 0 ||
                  c.gateway_ca.empty() || c.gateway_cert.empty() || c.gateway_key.empty()))
        throw std::runtime_error("Verified TLS required");
    return c;
}
} // namespace solo::notify
