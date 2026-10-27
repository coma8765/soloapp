#pragma once
#include <drogon/drogon.h>
namespace solo {
using Callback = std::function<void(const drogon::HttpResponsePtr&)>;
inline drogon::HttpResponsePtr JsonResponse(drogon::HttpStatusCode status, const Json::Value& body) {
    auto response = drogon::HttpResponse::newHttpJsonResponse(body);
    response->setStatusCode(status);
    response->addHeader("Cache-Control", "no-store");
    return response;
}
inline drogon::HttpResponsePtr Error(drogon::HttpStatusCode status, const std::string& message) {
    Json::Value body; body["error"] = message; return JsonResponse(status, body);
}
}
