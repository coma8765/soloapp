#include "generated/api.hpp"
#include "logic/config.hpp"
#include "logic/repository.hpp"
#include "logic/worker.hpp"
#include "runtime/http.hpp"
#include "runtime/workers.hpp"
#include "views/tasks.hpp"
#include <curl/curl.h>
#include <sodium.h>
int main() {
    if (sodium_init() < 0 || curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK)
        return 1;
    try {
        using namespace solo::notify;
        auto config = Config::Load();
        Repository repository(SecretFile("DATABASE_URL_FILE"));
        Worker worker(repository, config);
        solo::Workers http;
        auto bind = [&](auto view) -> generated::Handler {
            return [&, view](const drogon::HttpRequestPtr &request, solo::Callback &&done) {
                auto callback = std::move(done);
                if (!http.Add([&, request, view, callback] {
                        try {
                            callback(view(request, repository));
                        } catch (const std::invalid_argument &error) {
                            callback(solo::Error(std::string(error.what()) == "idempotency_conflict"
                                                     ? drogon::k409Conflict
                                                     : drogon::k400BadRequest,
                                                 error.what()));
                        } catch (...) {
                            callback(solo::Error(drogon::k503ServiceUnavailable,
                                                 "temporarily_unavailable"));
                        }
                    }))
                    callback(solo::Error(drogon::k503ServiceUnavailable, "busy"));
            };
        };
        generated::Handlers handlers;
        handlers.submit = bind(views::Submit);
        handlers.status = bind(views::Status);
        handlers.healthz = [](const drogon::HttpRequestPtr &, solo::Callback &&done) {
            done(solo::JsonResponse(drogon::k200OK, generated::Health{"ok"}.ToJson()));
        };
        handlers.ready = bind([](const drogon::HttpRequestPtr &, Repository &r) {
            r.Ready();
            return solo::JsonResponse(drogon::k200OK, generated::Health{"ok"}.ToJson());
        });
        generated::RegisterRoutes(handlers);
        auto address = std::getenv("LISTEN_ADDRESS");
        const char *const port = std::getenv("PORT");
        drogon::app()
            .setLogLevel(trantor::Logger::kWarn)
            .setThreadNum(2)
            .addListener(address ? address : "127.0.0.1", port ? std::stoi(port) : 8080)
            .run();
    } catch (...) {
        return 2;
    }
    curl_global_cleanup();
    return 0;
}
