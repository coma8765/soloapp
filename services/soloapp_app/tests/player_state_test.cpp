#include "player_state.hpp"
#include <iostream>
#include <stdexcept>

namespace {
void check(bool ok, const char *message) {
    if (!ok)
        throw std::runtime_error(message);
}
Json::Value pose(const char *map, double x, double y, double z) {
    Json::Value state;
    state["sequence"] = 1;
    state["map"] = map;
    state["position"].append(x);
    state["position"].append(y);
    state["position"].append(z);
    for (double n : {0., 0., 0., 1.})
        state["rotation"].append(n);
    state["pitch"] = 0;
    state["avatarId"] = "scientist";
    state["speed"] = 2;
    return state;
}
} // namespace
int main() {
    try {
        for (const char *map : {"white-room", "rbmk-training-room", "rbmk-physical-system"}) {
            check(planet::validPlayerState(pose(map, 2, 0, 4)), "room pose rejected");
            check(planet::validPlayerState(pose(map, -12, 6, 12)), "room boundary rejected");
            check(!planet::validPlayerState(pose(map, 13, 0, 0)), "room wall bypassed");
            check(!planet::validPlayerState(pose(map, 0, -1, 0)), "room floor bypassed");
            check(!planet::validPlayerState(pose(map, 0, 36, 0)), "planet pose accepted in room");
        }
        check(planet::validPlayerState(pose("planet", 0, 36, 0)), "planet pose rejected");
        check(!planet::validPlayerState(pose("planet", 0, 0, 0)), "room pose accepted on planet");
        check(!planet::validPlayerState(pose("unknown", 0, 36, 0)), "unknown map accepted");
        auto invalid = pose("rbmk-training-room", 0, 0, 0);
        invalid["rotation"][3] = 2;
        check(!planet::validPlayerState(invalid), "invalid rotation accepted");
        invalid = pose("rbmk-training-room", 0, 0, 0);
        invalid["sequence"] = -1;
        check(!planet::validPlayerState(invalid), "invalid sequence accepted");
        invalid = pose("planet", 0, 36, 0);
        invalid.removeMember("map");
        check(planet::validPlayerState(invalid), "legacy planet pose rejected");
        std::cout << "PASS: planet and room presence validation\n";
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
