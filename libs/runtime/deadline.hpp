#pragma once
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <thread>
namespace solo {
// Independent of the handler thread: expiry must interrupt its transport, not
// wait for cooperative completion. A stalled whole process is handled by the broker.
class Deadline {
  public:
    Deadline(unsigned milliseconds, std::function<void()> interrupt)
        : thread_([this, milliseconds, interrupt] {
              std::unique_lock<std::mutex> lock(mutex_);
              if (!changed_.wait_for(lock, std::chrono::milliseconds(milliseconds),
                                     [this] { return finished_; })) {
                  expired = true;
                  interrupt();
              }
          }) {}
    ~Deadline() {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            finished_ = true;
        }
        changed_.notify_one();
        thread_.join();
    }
    Deadline(const Deadline &) = delete;
    Deadline &operator=(const Deadline &) = delete;
    std::atomic<bool> expired{false};

  private:
    std::mutex mutex_;
    std::condition_variable changed_;
    bool finished_ = false;
    std::thread thread_;
};
} // namespace solo
