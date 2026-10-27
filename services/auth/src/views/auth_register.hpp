#pragma once
#include "logic/auth.hpp"
namespace solo::auth::views {
drogon::HttpResponsePtr auth_register(const drogon::HttpRequestPtr& request, logic::AuthService& service);
}
