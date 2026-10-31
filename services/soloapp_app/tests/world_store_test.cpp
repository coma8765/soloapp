#include "world_store.hpp"
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <thread>
int run_test(int argc, char **argv) {
    if (argc != 3)
        return 2;
    planet::WorldStore first(argv[1], argv[2], "test-first");
    planet::WorldStore second(argv[1], argv[2], "test-second");
    const Json::Value empty(Json::arrayValue);
    auto initial = first.exchange(empty, {});
    auto follower = second.exchange(empty, {});
    if (!initial.leader || follower.leader || initial.epoch != follower.epoch ||
        initial.fish != follower.fish)
        throw std::runtime_error("leader election failed");
    std::this_thread::sleep_for(std::chrono::milliseconds(3200));
    auto promoted = second.exchange(empty, {});
    if (!promoted.leader || promoted.epoch <= initial.epoch ||
        promoted.fish["sequence"].asUInt64() <= initial.fish["sequence"].asUInt64())
        throw std::runtime_error("checkpoint failover failed");
    auto stale = first.exchange(empty, {});
    if (stale.leader || stale.epoch != promoted.epoch || stale.fish != promoted.fish)
        throw std::runtime_error("old leader not fenced");
    std::cout << "PASS: single leader, checkpoint failover, old leader fenced\n";
    return 0;
}
int main(int argc, char **argv) {
    try {
        return run_test(argc, argv);
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
