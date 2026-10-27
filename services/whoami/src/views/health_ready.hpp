#pragma once
#include "generated/api.hpp"
namespace solo::whoami::views {
void health_ready(const drogon::HttpRequestPtr&, generated::Callback&& callback);
}
