#include "worker.hpp"
#include "queue.hpp"
#include <condition_variable>
#include <regex>
namespace solo::notify {
Worker::Worker(Repository &repository, const Config &config)
    : repository_(repository), config_(config), gateway_(config),
      publisher_([this] { PublishLoop(); }), consumer_([this] { ConsumeLoop(); }) {}
Worker::~Worker() {
    stop_ = true;
    publisher_.join();
    consumer_.join();
}
void Worker::Pause(unsigned ms) {
    for (unsigned n = 0; n < ms && !stop_; n += 50)
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
}
void Worker::PublishLoop() {
    while (!stop_)
        try {
            Queue queue(config_, false);
            while (!stop_) {
                for (const auto &task : repository_.Pending()) {
                    if (stop_)
                        break;
                    queue.Publish(task.task_id);
                    repository_.Published(task);
                }
                Pause(1000);
            }
        } catch (...) {
            Pause(1000);
        }
}
void Worker::ConsumeLoop() {
    while (!stop_)
        try {
            Queue queue(config_, true);
            while (!stop_) {
                auto delivery = queue.Next();
                if (!delivery)
                    continue;
                std::mutex mutex;
                std::condition_variable done;
                bool finished = false;
                std::atomic<bool> expired{false};
                std::thread watchdog([&] {
                    std::unique_lock<std::mutex> lock(mutex);
                    if (!done.wait_for(lock, std::chrono::milliseconds(config_.ack_ms),
                                       [&] { return finished; })) {
                        expired = true;
                        queue.Interrupt();
                    }
                });
                try {
                    if (!std::regex_match(delivery->key, std::regex("^[a-zA-Z0-9_-]{16,128}$")))
                        throw std::runtime_error("Invalid task key");
                    auto row = repository_.Get(delivery->key);
                    // Unknown entries are never silently acknowledged; infrastructure publisher ACL
                    // restricts the queue to this service. An operator must repair corrupt tasks.
                    if (!row)
                        throw std::runtime_error("Unknown task");
                    if (row->state == "done") {
                        queue.Ack(delivery->tag);
                    } else {
                        if (row->due_ms > NowMs())
                            Pause(static_cast<unsigned>(
                                std::min<long long>(config_.retry_ms, row->due_ms - NowMs())));
                        auto claimed = repository_.Claim(row->task_id, config_.ack_ms);
                        if (!claimed) {
                            Pause(config_.retry_ms);
                            queue.Retry(delivery->tag);
                        } else {
                            bool delivered = false;
                            try {
                                delivered = gateway_.Deliver(*claimed, expired);
                            } catch (...) {
                            }
                            if (!delivered)
                                gateway_.Cancel(*claimed);
                            bool saved = repository_.Finish(*claimed, delivered && !expired,
                                                            config_.retry_ms);
                            if (expired)
                                throw std::runtime_error("ACK deadline expired");
                            if (delivered && saved)
                                queue.Ack(delivery->tag);
                            else {
                                Pause(config_.retry_ms);
                                queue.Retry(delivery->tag);
                            }
                        }
                    }
                } catch (...) {
                    queue.Interrupt();
                }
                {
                    std::lock_guard<std::mutex> lock(mutex);
                    finished = true;
                }
                done.notify_one();
                watchdog.join();
            }
        } catch (...) {
            Pause(1000);
        }
}
} // namespace solo::notify
