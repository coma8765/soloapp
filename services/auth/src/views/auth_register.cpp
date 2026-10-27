#include "auth_register.hpp"
#include "runtime/http.hpp"
#include "runtime/signing.hpp"
namespace solo::auth::views {
drogon::HttpResponsePtr auth_register(const drogon::HttpRequestPtr &request,
                                      logic::AuthService &service) {
    const auto body = request->getJsonObject();
    if (!body)
        throw std::invalid_argument("JSON body required");
    return solo::JsonResponse(drogon::k201Created,
                              service.Register(generated::Credentials::FromJson(*body)).ToJson());
}
} // namespace solo::auth::views
