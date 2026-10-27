#include "generated/api.hpp"
#include "logic/odb_repository.hpp"
#include "runtime/health_http.hpp"
#include "runtime/http.hpp"
#include "runtime/workers.hpp"
#include "views/auth_login.hpp"
#include "views/auth_logout.hpp"
#include "views/auth_me.hpp"
#include "views/auth_register.hpp"
#include "views/health_ready.hpp"
#include "views/healthz.hpp"
#include "views/internal_verify.hpp"
#include "views/ready.hpp"
#include <cstdlib>
#include <fstream>
#include <sodium.h>
#include <sstream>
int main() {
    if (sodium_init() < 0)
        return 1;
    solo::ObserveHttpHealth();
    const char *file = std::getenv("DATABASE_URL_FILE");
    if (!file)
        return 2;
    std::ifstream stream(file);
    std::ostringstream buffer;
    buffer << stream.rdbuf();
    if (buffer.str().empty())
        return 2;
    solo::auth::logic::OdbRepository repository(buffer.str(), solo::db::PoolConfigFromEnv());
    solo::auth::logic::AuthService service(repository);
    solo::Workers workers;
    auto bind = [&](auto view) -> solo::auth::generated::Handler {
        return [&, view](const drogon::HttpRequestPtr &request, solo::Callback &&done) {
            auto callback = std::move(done);
            if (!workers.Add([&, view, request, callback] {
                    try {
                        callback(view(request, service));
                    } catch (const solo::auth::logic::AuthError &error) {
                        callback(solo::Error(static_cast<drogon::HttpStatusCode>(error.status),
                                             error.what()));
                    } catch (const std::invalid_argument &) {
                        callback(solo::Error(drogon::k400BadRequest, "invalid request"));
                    } catch (const std::exception &) {
                        callback(
                            solo::Error(drogon::k503ServiceUnavailable, "temporarily unavailable"));
                    }
                }))
                callback(solo::Error(drogon::k503ServiceUnavailable, "busy"));
        };
    };
    solo::auth::generated::Handlers handlers;
    handlers.healthz = [&](const drogon::HttpRequestPtr &req, solo::Callback &&done) {
        done(solo::auth::views::healthz(req, service));
    };
    handlers.health_ready = [&](const drogon::HttpRequestPtr &req, solo::Callback &&done) {
        done(solo::auth::views::health_ready(req, service));
    };
    handlers.ready = bind(solo::auth::views::ready);
    handlers.auth_register = bind(solo::auth::views::auth_register);
    handlers.auth_login = bind(solo::auth::views::auth_login);
    handlers.auth_me = bind(solo::auth::views::auth_me);
    handlers.auth_logout = bind(solo::auth::views::auth_logout);
    handlers.internal_verify = bind(solo::auth::views::internal_verify);
    solo::auth::generated::RegisterRoutes(handlers);
    const auto address = std::getenv("LISTEN_ADDRESS");
    const char *const port = std::getenv("PORT");
    drogon::app()
        .setLogLevel(trantor::Logger::kWarn)
        .setThreadNum(2)
        .addListener(address ? address : "127.0.0.1", port ? std::stoi(port) : 19082)
        .run();
}
