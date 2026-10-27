#include "internal_verify.hpp"
#include "runtime/http.hpp"
#include "runtime/signing.hpp"
namespace solo::auth::views {
drogon::HttpResponsePtr internal_verify(const drogon::HttpRequestPtr &request,
                                        logic::AuthService &service) {
    auto identity = service.Verify(request->getHeader("Authorization"));
    auto response = solo::JsonResponse(drogon::k200OK, identity.ToJson());
    const auto timestamp = std::to_string(std::time(nullptr));
    response->addHeader("X-Verified-User-Id", identity.user_id);
    response->addHeader("X-User-Timestamp", timestamp);
    response->addHeader("X-User-Signature", userSignature(identity.user_id, timestamp));
    return response;
}
} // namespace solo::auth::views
