#include "health_ready.hpp"
#include "logic/identity.hpp"
#include "runtime/health_http.hpp"
#include "runtime/signing.hpp"
namespace solo::whoami::views {
void health_ready(const drogon::HttpRequestPtr&, generated::Callback&& callback) {
    try {
        const std::string id(32, '0');
        const auto now = std::time(nullptr);
        const auto timestamp = std::to_string(now);
        if (!logic::VerifyIdentity(id, timestamp, userSignature(id, timestamp), now))
            throw std::runtime_error("identity self-check failed");
        callback(solo::PodReadiness());
    } catch (const std::exception&) {
        callback(solo::Error(drogon::k503ServiceUnavailable, "identity unavailable"));
    }
}
}
