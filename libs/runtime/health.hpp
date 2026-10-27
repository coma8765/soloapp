#pragma once
#include <chrono>
#include <cstdlib>
#include <deque>
#include <mutex>
#include <stdexcept>
#include <string>
namespace solo {
// Per-process, bounded sliding window. Probe responses never feed this circuit.
class HealthCircuit {
 public:
    using Clock = std::chrono::steady_clock;
    using Time = Clock::time_point;
    HealthCircuit(unsigned threshold, std::chrono::seconds window, std::chrono::seconds cooldown)
        : threshold_(threshold), window_(window), cooldown_(cooldown) {
        if (!threshold || window.count() <= 0 || cooldown.count() <= 0)
            throw std::invalid_argument("health settings must be positive");
    }
    bool Record(int status, Time now = Clock::now()) {
        if (status < 500 || status > 599) return false;
        std::lock_guard<std::mutex> lock(mutex_);
        if (now < excluded_until_) return false;
        while (!errors_.empty() && now - errors_.front() >= window_) errors_.pop_front();
        errors_.push_back(now);
        if (errors_.size() < threshold_) return false;
        errors_.clear();
        excluded_until_ = now + cooldown_;
        return true;
    }
    bool Ready(Time now = Clock::now()) const {
        std::lock_guard<std::mutex> lock(mutex_);
        return now >= excluded_until_;
    }
 private:
    const unsigned threshold_;
    const std::chrono::seconds window_, cooldown_;
    mutable std::mutex mutex_;
    std::deque<Time> errors_;
    Time excluded_until_ = Time::min();
};
inline int HealthSetting(const char* name, int fallback) {
    const char* value = std::getenv(name);
    if (!value) return fallback;
    std::size_t end = 0;
    int result = std::stoi(value, &end);
    if (end != std::string(value).size() || result <= 0 || result > 3600)
        throw std::invalid_argument(std::string("invalid health setting: ") + name);
    return result;
}
inline HealthCircuit& ProcessHealth() {
    static HealthCircuit health(HealthSetting("HEALTH_ERROR_THRESHOLD", 3),
        std::chrono::seconds(HealthSetting("HEALTH_WINDOW_SECONDS", 10)),
        std::chrono::seconds(HealthSetting("HEALTH_COOLDOWN_SECONDS", 15)));
    return health;
}
}
