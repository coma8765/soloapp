#pragma once
#include "gateway.hpp"
#include "repository.hpp"
#include <thread>
namespace solo::notify {
class Worker {
  public:
    Worker(Repository &repository, const Config &config);
    ~Worker();

  private:
    Repository &repository_;
    Config config_;
    Gateway gateway_;
    std::atomic<bool> stop_{false};
    std::thread publisher_, consumer_;
    void PublishLoop();
    void ConsumeLoop();
    void Pause(unsigned ms);
};
} // namespace solo::notify
