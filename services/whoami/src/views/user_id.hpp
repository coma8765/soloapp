#pragma once
#include "generated/api.hpp"
namespace solo::whoami::views {
void user_id(const drogon::HttpRequestPtr& request, generated::Callback&& callback);
}
