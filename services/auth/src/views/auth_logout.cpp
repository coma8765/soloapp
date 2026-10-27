#include "auth_logout.hpp"
#include "runtime/http.hpp"
#include "runtime/signing.hpp"
namespace solo::auth::views {
drogon::HttpResponsePtr auth_logout(const drogon::HttpRequestPtr &request,
                                    logic::AuthService &service) {
    service.Logout(request->getHeader("Authorization"));
    auto response = drogon::HttpResponse::newHttpResponse();
    response->setStatusCode(drogon::k204NoContent);
    response->addHeader("Cache-Control", "no-store");
    return response;
}
} // namespace solo::auth::views
