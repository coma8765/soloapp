#pragma once
#include <condition_variable>
#include <functional>
#include <mutex>
#include <queue>
#include <thread>
#include <vector>
namespace solo {
class Workers {
  public:
    Workers() {
        for (int i = 0; i != 4; ++i)
            threads_.emplace_back([this] {
                for (;;) {
                    std::function<void()> task;
                    {
                        std::unique_lock<std::mutex> lock(mutex_);
                        ready_.wait(lock, [this] { return stopped_ || !tasks_.empty(); });
                        if (stopped_ && tasks_.empty())
                            return;
                        task = std::move(tasks_.front());
                        tasks_.pop();
                    }
                    task();
                }
            });
    }
    bool Add(std::function<void()> task) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (stopped_ || tasks_.size() >= 32)
            return false;
        tasks_.push(std::move(task));
        ready_.notify_one();
        return true;
    }
    ~Workers() {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            stopped_ = true;
        }
        ready_.notify_all();
        for (auto &thread : threads_)
            thread.join();
    }

  private:
    std::mutex mutex_;
    std::condition_variable ready_;
    std::queue<std::function<void()>> tasks_;
    std::vector<std::thread> threads_;
    bool stopped_ = false;
};
} // namespace solo
