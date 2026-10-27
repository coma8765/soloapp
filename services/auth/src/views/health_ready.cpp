#include "health_ready.hpp"
#include "runtime/health_http.hpp"
namespace solo::auth::views {
drogon::HttpResponsePtr health_ready(const drogon::HttpRequestPtr &, logic::AuthService &) {
    return solo::PodReadiness();
}
} // namespace solo::auth::views
