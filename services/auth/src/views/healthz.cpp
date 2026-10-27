#include "healthz.hpp"
#include "runtime/http.hpp"
#include "runtime/signing.hpp"
namespace solo::auth::views {
drogon::HttpResponsePtr healthz(const drogon::HttpRequestPtr&, logic::AuthService&) {
    return solo::JsonResponse(drogon::k200OK, generated::Status{"ok"}.ToJson());
}
}
