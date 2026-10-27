#pragma once
#include "config.hpp"
#include "repository.hpp"
#include "runtime/workers.hpp"
#include <atomic>
namespace solo::notify {
class Gateway {
  public:
    explicit Gateway(const Config &config) : config_(config) {}
    bool Deliver(const Task &task, std::atomic<bool> &cancel);
    void Cancel(const Task &task);

  private:
    Config config_;
    solo::Workers cancellation_workers_;
};
} // namespace solo::notify
