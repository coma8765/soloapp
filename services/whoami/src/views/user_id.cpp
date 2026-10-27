#include "user_id.hpp"
#include "logic/identity.hpp"
#include "runtime/http.hpp"
namespace solo::whoami::views {
void user_id(const drogon::HttpRequestPtr& request, generated::Callback&& callback) {
    const auto& id = request->getHeader("X-Verified-User-Id");
    if (!logic::VerifyIdentity(id, request->getHeader("X-User-Timestamp"), request->getHeader("X-User-Signature"), std::time(nullptr))) {
        callback(solo::JsonResponse(drogon::k401Unauthorized, generated::Error{"unauthorized"}.ToJson())); return;
    }
    callback(solo::JsonResponse(drogon::k200OK, generated::UserId{id}.ToJson()));
}
}
