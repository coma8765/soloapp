#pragma once
#include "logic/auth.hpp"
namespace solo::auth::views {
drogon::HttpResponsePtr healthz(const drogon::HttpRequestPtr&, logic::AuthService&);
}
