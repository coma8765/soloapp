#include "generated/api.hpp"
#include "runtime/health_http.hpp"
#include "views/health_ready.hpp"
#include "views/user_id.hpp"
#include "views/healthz.hpp"
#include <sodium.h>
#include <cstdlib>
int main() {
    if (sodium_init() < 0) return 1;
    solo::ObserveHttpHealth();
    solo::whoami::generated::Handlers handlers; handlers.user_id = solo::whoami::views::user_id;
    handlers.healthz = solo::whoami::views::healthz;
    handlers.health_ready = solo::whoami::views::health_ready;
    solo::whoami::generated::RegisterRoutes(handlers);
    const auto port = std::getenv("PORT");
    const auto address = std::getenv("LISTEN_ADDRESS");
    drogon::app().setLogLevel(trantor::Logger::kWarn).setThreadNum(2)
        .addListener(address ? address : "0.0.0.0", port ? std::stoi(port) : 8080).run();
}
