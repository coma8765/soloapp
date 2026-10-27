#include "auth_login.hpp"
#include "runtime/http.hpp"
#include "runtime/signing.hpp"
namespace solo::auth::views {
drogon::HttpResponsePtr auth_login(const drogon::HttpRequestPtr& request, logic::AuthService& service) {
    const auto body = request->getJsonObject();
    if (!body) throw std::invalid_argument("JSON body required");
    return solo::JsonResponse(drogon::k200OK, service.Login(generated::Credentials::FromJson(*body)).ToJson());
}
}
