#pragma once
#include "generated/api.hpp"
#include "logic/repository.hpp"
namespace solo::notify::views {
drogon::HttpResponsePtr Submit(const drogon::HttpRequestPtr &, Repository &);
drogon::HttpResponsePtr Status(const drogon::HttpRequestPtr &, Repository &);
} // namespace solo::notify::views
