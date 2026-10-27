#pragma once
#include "generated/api.hpp"
namespace solo::whoami::views {
void healthz(const drogon::HttpRequestPtr&, generated::Callback&&);
}
