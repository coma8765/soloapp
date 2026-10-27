#pragma once
#include "logic/auth.hpp"
namespace solo::auth::views {
drogon::HttpResponsePtr health_ready(const drogon::HttpRequestPtr&, logic::AuthService&);
}
