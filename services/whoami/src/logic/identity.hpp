#pragma once
#include <string>
#include <ctime>
namespace solo::whoami::logic {
bool VerifyIdentity(const std::string& id, const std::string& timestamp, const std::string& signature, std::time_t now);
}
