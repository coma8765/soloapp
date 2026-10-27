#include "identity.hpp"
#include "runtime/signing.hpp"
#include <regex>
namespace solo::whoami::logic {
bool VerifyIdentity(const std::string& id, const std::string& timestamp, const std::string& signature, std::time_t now) {
    try {
        static const std::regex id_pattern("[0-9a-f]{32}"), timestamp_pattern("[0-9]{10}");
        if (!std::regex_match(id, id_pattern) || !std::regex_match(timestamp, timestamp_pattern) || signature.size() != 64) return false;
        const auto delta = now - std::stoll(timestamp);
        if (delta < -2 || delta > 10) return false;
        const auto expected = userSignature(id, timestamp);
        return sodium_memcmp(signature.data(), expected.data(), expected.size()) == 0;
    } catch (const std::exception&) { return false; }
}
}
