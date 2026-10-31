#include "logic/config.hpp"
#include "logic/game.hpp"
#include "runtime/health_http.hpp"
#include "views/api.hpp"
#include <drogon/drogon.h>
#include <iostream>
#include <sodium.h>
int main() {
    try {
        if (sodium_init() < 0)
            return 1;
        solo::ObserveHttpHealth();
        drogon::app()
            .setLogLevel(trantor::Logger::kWarn)
            .setThreadNum(1)
            .setClientMaxWebSocketMessageSize(32768)
            .addListener(planet::env("LISTEN_ADDRESS", "0.0.0.0"),
                         std::stoi(planet::env("PORT", "8080")));
        planet::Game game;
        installApi(game);
        drogon::app().run();
    } catch (...) {
        std::cerr << "soloapp_app startup failed; verify mounted configuration and database"
                  << std::endl;
        return 1;
    }
}
