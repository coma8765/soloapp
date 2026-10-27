#include "ready.hpp"
#include "runtime/http.hpp"
#include "runtime/signing.hpp"
namespace solo::auth::views {
drogon::HttpResponsePtr ready(const drogon::HttpRequestPtr &, logic::AuthService &service) {
    service.Ready();
    return solo::JsonResponse(drogon::k200OK, generated::Status{"ready"}.ToJson());
}
} // namespace solo::auth::views
