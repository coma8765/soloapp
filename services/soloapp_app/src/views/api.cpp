#include "api.hpp"
#include "generated/routes.hpp"
#include "logic/config.hpp"
#include "runtime/http.hpp"
#include "runtime/signing.hpp"
#include <drogon/WebSocketController.h>
#include <regex>
namespace {
planet::Game *current = nullptr;
}
class PlanetSocket : public drogon::WebSocketController<PlanetSocket> {
  public:
    WS_PATH_LIST_BEGIN
    WS_PATH_ADD(planet::routes::signal, drogon::Get);
    WS_PATH_LIST_END
    void handleNewConnection(const drogon::HttpRequestPtr &req,
                             const drogon::WebSocketConnectionPtr &socket) override {
        const auto allowed = planet::env("CHAT_ALLOWED_ORIGIN", "");
        if (allowed.empty() || req->getHeader("origin") != allowed) {
            socket->shutdown(drogon::CloseCode::kViolation, "Origin denied");
            return;
        }
        current->opened(socket);
    }
    void handleConnectionClosed(const drogon::WebSocketConnectionPtr &socket) override {
        current->closed(socket);
    }
    void handleNewMessage(const drogon::WebSocketConnectionPtr &socket, std::string &&text,
                          const drogon::WebSocketMessageType &type) override {
        if (type == drogon::WebSocketMessageType::Text)
            current->message(socket, text);
    }
};
void installApi(planet::Game &game) {
    current = &game;
    for (const char *path : {planet::routes::healthz, planet::routes::health_ready}) {
        const bool readiness = std::string(path) == planet::routes::health_ready;
        drogon::app().registerHandler(
            path,
            [&game, readiness](const drogon::HttpRequestPtr &, solo::Callback &&cb) {
                Json::Value body;
                body["status"] = (!readiness || game.ready()) ? "ok" : "unavailable";
                cb(solo::JsonResponse((!readiness || game.ready()) ? drogon::k200OK
                                                                   : drogon::k503ServiceUnavailable,
                                      body));
            },
            {drogon::Get});
    }
    auto identity = [](const drogon::HttpRequestPtr &req, solo::Callback &&cb) {
        const auto id = req->getHeader("x-verified-user-id"),
                   timestamp = req->getHeader("x-user-timestamp"),
                   signature = req->getHeader("x-user-signature");
        try {
            if (!std::regex_match(id, std::regex("^[0-9a-f]{32}$")) ||
                !std::regex_match(timestamp, std::regex("^[0-9]{10}$")) || signature.size() != 64 ||
                std::llabs(std::time(nullptr) - std::stoll(timestamp)) > 30)
                throw std::invalid_argument("unauthorized");
            auto expected = userSignature(id, timestamp);
            if (sodium_memcmp(expected.data(), signature.data(), 64) != 0)
                throw std::invalid_argument("unauthorized");
            Json::Value body;
            body["user_id"] = id;
            cb(solo::JsonResponse(drogon::k200OK, body));
        } catch (...) {
            cb(solo::Error(drogon::k401Unauthorized, "unauthorized"));
        }
    };
    drogon::app().registerHandler(planet::routes::user_id, identity, {drogon::Get});
    drogon::app().registerHandler("/api/v1/app-api/v1/user-id", identity, {drogon::Get});
    drogon::app().registerHandler("/api/v1/whoami/v1/user-id", identity, {drogon::Get});
    drogon::app().registerHandler("/user-id", identity, {drogon::Get});
    drogon::app().registerHandler(
        "/metrics",
        [&game](const drogon::HttpRequestPtr &, solo::Callback &&cb) {
            drogon::app().getLoop()->queueInLoop([&game, cb = std::move(cb)] {
                auto r = drogon::HttpResponse::newHttpResponse();
                r->addHeader("Content-Type", "text/plain; version=0.0.4");
                r->setBody("soloapp_world_leader " + std::to_string(game.leader && game.ready()) +
                           "\nsoloapp_world_epoch " + std::to_string(game.epoch) +
                           "\nsoloapp_world_connections " + std::to_string(game.connections()) +
                           "\nsoloapp_world_database_errors_total " +
                           std::to_string(game.databaseErrors.load()) + "\n");
                cb(r);
            });
        },
        {drogon::Get});
}
