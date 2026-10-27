#include "tasks.hpp"
#include "logic/config.hpp"
#include "runtime/http.hpp"
#include <sodium.h>
namespace solo::notify::views {
namespace {
bool Authorized(const drogon::HttpRequestPtr &request) {
    auto expected = "Bearer " + SecretFile("NOTIFY_API_TOKEN_FILE");
    auto actual = request->getHeader("authorization");
    return actual.size() == expected.size() &&
           sodium_memcmp(actual.data(), expected.data(), expected.size()) == 0;
}
Json::Value Body(const drogon::HttpRequestPtr &request) {
    auto body = request->getJsonObject();
    if (!body)
        throw std::invalid_argument("JSON body required");
    return *body;
}
drogon::HttpResponsePtr Response(const Task &t, drogon::HttpStatusCode code) {
    return solo::JsonResponse(
        code,
        generated::TaskStatus{t.task_id, t.state, static_cast<std::int64_t>(t.attempt)}.ToJson());
}
} // namespace
drogon::HttpResponsePtr Submit(const drogon::HttpRequestPtr &request, Repository &repository) {
    if (!Authorized(request))
        return solo::Error(drogon::k401Unauthorized, "unauthorized");
    auto input = generated::DeliveryTask::FromJson(Body(request));
    return Response(repository.Submit(input.task_id, input.recipient, input.payload),
                    drogon::k202Accepted);
}
drogon::HttpResponsePtr Status(const drogon::HttpRequestPtr &request, Repository &repository) {
    if (!Authorized(request))
        return solo::Error(drogon::k401Unauthorized, "unauthorized");
    auto input = generated::TaskKey::FromJson(Body(request));
    auto row = repository.Get(input.task_id);
    return row ? Response(*row, drogon::k200OK) : solo::Error(drogon::k404NotFound, "not_found");
}
} // namespace solo::notify::views
