#pragma once
#include "config.hpp"
#include <amqp.h>
#include <atomic>
#include <mutex>
#include <optional>
namespace solo::notify {
struct Delivery {
    std::string key;
    uint64_t tag;
};
class Queue {
  public:
    explicit Queue(const Config &config, bool consumer);
    ~Queue();
    Queue(const Queue &) = delete;
    Queue &operator=(const Queue &) = delete;
    void Publish(const std::string &key);
    std::optional<Delivery> Next();
    void Ack(uint64_t tag);
    void Retry(uint64_t tag);
    void Interrupt();

  private:
    amqp_connection_state_t connection_ = nullptr;
    std::mutex socket_mutex_;
    int socket_ = -1;
    std::string queue_;
    void Check(amqp_rpc_reply_t reply);
};
} // namespace solo::notify
