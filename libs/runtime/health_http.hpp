#pragma once
#include "health.hpp"
#include "http.hpp"
namespace solo {
inline void ObserveHttpHealth() {
    (void)ProcessHealth(); // Validate configuration before accepting traffic.
    drogon::app().registerPreSendingAdvice([](const drogon::HttpRequestPtr &req,
                                              const drogon::HttpResponsePtr &resp) {
        if (req->path() == "/healthz" || req->path() == "/health/ready" || req->path() == "/ready")
            return;
        if (ProcessHealth().Record(static_cast<int>(resp->statusCode())))
            LOG_WARN << "health circuit: excluding pod after repeated 5xx responses";
    });
}
inline drogon::HttpResponsePtr PodReadiness() {
    Json::Value body;
    const bool ready = ProcessHealth().Ready();
    body["status"] = ready ? "ready" : "cooldown";
    return JsonResponse(ready ? drogon::k200OK : drogon::k503ServiceUnavailable, body);
}
} // namespace solo
