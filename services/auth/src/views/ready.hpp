#pragma once
#include "logic/auth.hpp"
namespace solo::auth::views {
drogon::HttpResponsePtr ready(const drogon::HttpRequestPtr&, logic::AuthService& service);
}
