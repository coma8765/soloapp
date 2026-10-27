#pragma once
#include "logic/auth.hpp"
namespace solo::auth::views {
drogon::HttpResponsePtr internal_verify(const drogon::HttpRequestPtr& request, logic::AuthService& service);
}
