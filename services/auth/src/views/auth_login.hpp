#pragma once
#include "logic/auth.hpp"
namespace solo::auth::views {
drogon::HttpResponsePtr auth_login(const drogon::HttpRequestPtr& request, logic::AuthService& service);
}
