#include "auth_me.hpp"
#include "runtime/http.hpp"
#include "runtime/signing.hpp"
namespace solo::auth::views {
drogon::HttpResponsePtr auth_me(const drogon::HttpRequestPtr &request,
                                logic::AuthService &service) {
    return solo::JsonResponse(drogon::k200OK,
                              service.Profile(request->getHeader("Authorization")).ToJson());
}
} // namespace solo::auth::views
