#pragma once
#include <string>
namespace solo::notify {
struct Config {
    std::string rabbit_host, rabbit_user, rabbit_password, rabbit_ca, queue;
    int rabbit_port = 5671;
    bool rabbit_tls = true;
    std::string gateway_url, gateway_ca, gateway_cert, gateway_key, gateway_token;
    unsigned delivery_ms = 10000, ack_ms = 30000, retry_ms = 1000;
    static Config Load();
};
std::string SecretFile(const char *variable);
} // namespace solo::notify
