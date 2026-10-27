#include "healthz.hpp"
#include "runtime/http.hpp"
#include "runtime/signing.hpp"
namespace solo::whoami::views {
void healthz(const drogon::HttpRequestPtr&, generated::Callback&& done) {
    done(solo::JsonResponse(drogon::k200OK, generated::Status{"ok"}.ToJson()));
}
}
