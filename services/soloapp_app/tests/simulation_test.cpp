#include "simulation.hpp"
#include <algorithm>
#include <iostream>
#include <stdexcept>

int run_test(int argc, char **argv) {
    if (argc != 2)
        return 1;
    Simulation baseline(argv[1]), reactive(argv[1]);
    const Vec3 player = reactive.fishes()[0].position;
    for (int i = 0; i < 40; ++i) {
        baseline.step(0.05, {});
        reactive.step(0.05, {player});
    }
    if (reactive.fishes()[0].alarm < 0.5 ||
        (reactive.fishes()[0].position - baseline.fishes()[0].position).length() < 0.5 ||
        (reactive.fishes()[0].position - player).length() < 1.0) {
        throw std::runtime_error("Fish did not flee from the player");
    }
    for (int i = 0; i < 2400; ++i) {
        reactive.step(0.05, {});
        if (std::any_of(reactive.fishes().begin(), reactive.fishes().end(), [&](const Fish &fish) {
                return fish.position.length() >= reactive.waterRadius - 0.3 ||
                       fish.position.length() <= reactive.bed(fish.lake, fish.x, fish.y) + 0.3;
            }))
            throw std::runtime_error("Fish left navigable water");
    }
    if (reactive.fishes()[0].alarm != 0)
        throw std::runtime_error("Fish did not calm down");
    Simulation restored(argv[1]);
    restored.restore(reactive.checkpoint());
    if (restored.checkpoint() != reactive.checkpoint()) {
        throw std::runtime_error("Checkpoint round-trip changed world state");
    }
    for (int i = 0; i < 100; ++i) {
        reactive.step(0.05, {player});
        restored.step(0.05, {player});
    }
    if (restored.snapshot() != reactive.snapshot()) {
        throw std::runtime_error("Restored world diverged after failover");
    }
    auto invalid = reactive.checkpoint();
    invalid["version"] = 999;
    bool rejected = false;
    try {
        restored.restore(invalid);
    } catch (const std::exception &) {
        rejected = true;
    }
    if (!rejected)
        throw std::runtime_error("Invalid checkpoint accepted");
    std::cout << "PASS: flee, recover, stay between surface and lake bed\n";
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
