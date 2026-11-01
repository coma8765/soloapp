#include "reactor.hpp"
#include "json.hpp"
#include <algorithm>
#include <cmath>
#include <ctime>
#include <fstream>
#include <iterator>
#include <limits>

namespace planet {
namespace {
bool bounded(const Json::Value &value, int depth = 0) {
    if (depth > 8)
        return false;
    if (value.isNumeric())
        return std::isfinite(value.asDouble());
    if (value.isString())
        return value.asString().size() <= 2400;
    if (value.isArray() || value.isObject()) {
        if (value.size() > 256)
            return false;
        return std::all_of(value.begin(), value.end(),
                           [depth](const Json::Value &child) { return bounded(child, depth + 1); });
    }
    return value.isBool() || value.isNull();
}
bool oneOf(const Json::Value &value, std::initializer_list<const char *> values) {
    return value.isString() && std::any_of(values.begin(), values.end(),
                                           [&](const char *item) { return value == item; });
}
bool text(const Json::Value &value, size_t maximum, bool required = false) {
    return value.isString() && value.asString().size() <= maximum &&
           (!required || value.asString().find_first_not_of(" \t\r\n") != std::string::npos);
}
void trimHistory(Json::Value &values, unsigned limit) {
    if (values.size() <= limit)
        return;
    Json::Value tail(Json::arrayValue);
    for (unsigned i = values.size() - limit; i < values.size(); ++i)
        tail.append(values[i]);
    values = std::move(tail);
}
std::string wallTime(long long milliseconds) {
    const auto seconds = static_cast<std::time_t>(milliseconds / 1000);
    std::tm utc{};
    gmtime_r(&seconds, &utc);
    char buffer[32];
    std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &utc);
    return buffer;
}
} // namespace

ReactorAuthority::ReactorAuthority(const std::string &path) {
    std::ifstream input(path);
    if (!input)
        throw std::runtime_error("reactor_profile_missing");
    profile_ = decode(std::string(std::istreambuf_iterator<char>(input), {}));
    if (!profile_["controls"].isObject() || !validSnapshot(profile_["initial"]))
        throw std::runtime_error("reactor_profile_invalid");
}

bool ReactorAuthority::validControl(const std::string &name, const Json::Value &value) const {
    const auto &schema = profile_["controls"][name];
    if (!schema.isObject())
        return false;
    if (schema["type"] == "checkbox")
        return value.isBool();
    if (schema["type"] == "select")
        return value.isString() && schema["options"].isMember(value.asString());
    return value.isNumeric() && std::isfinite(value.asDouble()) &&
           value.asDouble() >= schema["min"].asDouble() &&
           value.asDouble() <= schema["max"].asDouble();
}

bool ReactorAuthority::validSnapshot(const Json::Value &state) const {
    if (!state.isObject() || state["modelVersion"] != 4 || !bounded(state) ||
        !state["elapsed"].isNumeric() || state["elapsed"].asDouble() < 0 ||
        !state["controls"].isObject() || !state["rods"].isObject() ||
        !state["equipment"].isObject() || state["precursors"].size() != 6 ||
        state["decayHeatGroups"].size() != 6 || state["loopMasses"].size() != 2 ||
        state["loopEnergies"].size() != 2)
        return false;
    for (const char *name : {"fuelTemperatures", "voidFractions", "geometricLevels"}) {
        const auto &values = state[name];
        if (!values.isArray() || values.size() != 2 ||
            !std::all_of(values.begin(), values.end(),
                         [](const auto &value) { return value.isNumeric(); }))
            return false;
    }
    const auto &cycle = state["cycle"];
    if (!cycle.isObject())
        return false;
    for (const auto &name : profile_["initial"]["cycle"].getMemberNames()) {
        const auto &expected = profile_["initial"]["cycle"][name];
        const auto &actual = cycle[name];
        if (expected.isArray()) {
            if (!actual.isArray() || actual.size() != expected.size() ||
                !std::all_of(actual.begin(), actual.end(),
                             [](const auto &value) { return value.isNumeric(); }))
                return false;
        } else if (!actual.isNumeric())
            return false;
    }
    for (const char *name : {"returnMass", "injectionMass"})
        for (const auto &value : cycle[name])
            if (value.asDouble() < 0)
                return false;
    const auto fields = profile_["initial"].getMemberNames();
    if (!std::all_of(fields.begin(), fields.end(), [&](const auto &name) {
            if (!state.isMember(name))
                return false;
            const auto &expected = profile_["initial"][name];
            const auto &actual = state[name];
            if ((expected.isNumeric() && !actual.isNumeric()) ||
                (expected.isBool() && !actual.isBool()) ||
                (expected.isString() && !actual.isString()) ||
                (expected.isArray() && !actual.isArray()) ||
                (expected.isObject() && !actual.isObject()))
                return false;
            return true;
        }))
        return false;
    for (const char *group : {"rods", "equipment"}) {
        const auto names = profile_["initial"][group].getMemberNames();
        if (std::any_of(names.begin(), names.end(), [&](const auto &name) {
                return !state[group].isMember(name) ||
                       (profile_["initial"][group][name].isNumeric() &&
                        !state[group][name].isNumeric()) ||
                       (profile_["initial"][group][name].isBool() && !state[group][name].isBool());
            }))
            return false;
    }
    const auto names = profile_["controls"].getMemberNames();
    if (!std::all_of(names.begin(), names.end(),
                     [&](const auto &name) { return validControl(name, state["controls"][name]); }))
        return false;
    const std::initializer_list<const char *> measurements = {
        "power",           "pressure",
        "thermalPowerMW",  "electricalPower",
        "fuelTemperature", "graphiteTemperature",
        "iodine",          "xenon"};
    return std::all_of(measurements.begin(), measurements.end(),
                       [&](const char *field) { return state[field].isNumeric(); });
}

std::string ReactorAuthority::command(Json::Value &data, const Json::Value &message,
                                      long long now) const {
    auto &state = data["state"];
    auto &controls = state["controls"];
    const auto &request = message["command"];
    if (!request.isObject())
        return "invalid_command";
    if (request["kind"] == "control") {
        if (!text(request["name"], 80, true))
            return "invalid_control";
        const auto name = request["name"].asString();
        const auto &schema = profile_["controls"][name];
        Json::Value value = request["value"];
        if (request["mode"] == "toggle") {
            if (schema["type"] != "checkbox")
                return "invalid_toggle";
            value = !controls[name].asBool();
        } else if (request["mode"] == "delta") {
            if (schema["type"] == "select") {
                if (!request["delta"].isInt() ||
                    (request["delta"].asInt() != 1 && request["delta"].asInt() != -1))
                    return "invalid_delta";
                std::vector<std::string> options;
                const auto &ordered = profile_["optionOrder"][name];
                std::transform(ordered.begin(), ordered.end(), std::back_inserter(options),
                               [](const auto &option) { return option.asString(); });
                const auto it =
                    std::find(options.begin(), options.end(), controls[name].asString());
                if (it == options.end())
                    return "invalid_control_state";
                const auto index = static_cast<int>(std::distance(options.begin(), it));
                value =
                    options[(index + request["delta"].asInt() + options.size()) % options.size()];
            } else {
                if (schema["type"] != "range" || !request["delta"].isNumeric() ||
                    !std::isfinite(request["delta"].asDouble()) ||
                    std::abs(request["delta"].asDouble()) >
                        schema["max"].asDouble() - schema["min"].asDouble())
                    return "invalid_delta";
                value = std::clamp(controls[name].asDouble() + request["delta"].asDouble(),
                                   schema["min"].asDouble(), schema["max"].asDouble());
            }
        } else if (request["mode"] != "set")
            return "invalid_mode";
        if (!validControl(name, value))
            return "invalid_control_value";
        if (schema["type"] == "range") {
            const double step = schema["step"].asDouble();
            value = std::round(value.asDouble() / step) * step;
        }
        controls[name] = value;
        for (const char *side : {"Left", "Right"}) {
            const std::string aggregate = std::string("pumps") + side;
            if (name == aggregate)
                for (int i = 1; i <= 4; ++i)
                    controls[std::string("mcp") + side + std::to_string(i)] = i <= value.asInt();
            for (int i = 1; i <= 4; ++i)
                if (name == std::string("mcp") + side + std::to_string(i)) {
                    int count = 0;
                    for (int pump = 1; pump <= 4; ++pump)
                        count +=
                            controls[std::string("mcp") + side + std::to_string(pump)].asBool();
                    controls[aggregate] = count;
                }
        }
        return "";
    }
    if (request["kind"] == "action") {
        if (!text(request["action"], 32, true))
            return "invalid_action";
        const auto action = request["action"].asString();
        if (action == "scram") {
            state["scrammed"] = true;
            state["scramReason"] = "АЗ-5 нажата оператором";
            controls["targetPower"] = 0;
            for (const char *name :
                 {"manualRodInsertion", "automaticRodInsertion", "shortenedRodInsertion"})
                controls[name] = 100;
        } else if (action == "clear") {
            if (state["power"].asDouble() > 3 || controls["scenario"] != "normal")
                return "scram_clear_blocked";
            state["scrammed"] = false;
            state["scramReason"] = "";
            controls["targetPower"] = 5;
        } else if (action == "reset")
            state = profile_["initial"];
        else if (action == "acknowledge")
            state["equipment"]["acknowledged"] = true;
        else if (action == "lamp-test")
            state["equipment"]["lampTestUntil"] = state["elapsed"].asDouble() + 3;
        else
            return "invalid_action";
        return "";
    }
    if (request["kind"] == "journal") {
        auto entry = request["entry"];
        if (!entry.isObject() || !bounded(entry) || !text(entry["id"], 96, true) ||
            !text(entry["text"], 2400, true) || !text(entry["equipment"], 360) ||
            !text(entry["sender"], 360) || !text(entry["recipient"], 360) ||
            !text(entry["ref"], 120) || !oneOf(entry["journal"], {"ИУР", "НСБ", "ТУРБИНЫ"}) ||
            !oneOf(entry["kind"], {"наблюдение", "доклад", "распоряжение", "результат",
                                   "исправление", "сдача смены", "приём смены"}) ||
            !oneOf(entry["status"],
                   {"зафиксировано", "ожидается", "принято", "выполнено", "подтверждено"}) ||
            !entry["eventAt"].isNumeric() || entry["eventAt"].asDouble() < 0 ||
            entry["eventAt"].asDouble() > state["elapsed"].asDouble() + 2)
            return "invalid_journal_entry";
        if (data["journal"].size() >= 2000)
            return "journal_full";
        if (std::any_of(data["journal"].begin(), data["journal"].end(),
                        [&](const auto &previous) { return previous["id"] == entry["id"]; }))
            return "journal_id_used";
        const std::string actor = "участник #" + message["from"].asString();
        if (oneOf(entry["kind"], {"результат", "исправление", "приём смены"})) {
            const auto found = std::find_if(data["journal"].begin(), data["journal"].end(),
                                            [&](const Json::Value &original) {
                                                return original["id"] == entry["ref"] &&
                                                       original["journal"] == entry["journal"];
                                            });
            if (found == data["journal"].end())
                return "journal_reference_missing";
            if (entry["kind"] == "результат" && (*found)["kind"] != "распоряжение")
                return "journal_reference_not_order";
            if (entry["kind"] == "приём смены" &&
                ((*found)["kind"] != "сдача смены" || (*found)["actor"] == actor))
                return "handover_requires_other_actor";
        }
        if (entry["kind"] == "распоряжение") {
            if (!text(entry["sender"], 360, true) || !text(entry["recipient"], 360, true))
                return "order_participants_required";
            entry["status"] = "ожидается";
        }
        entry["actor"] = actor;
        entry["recordedAt"] = state["elapsed"];
        entry["wallTime"] = wallTime(now);
        entry["serverSequence"] = data["journal"].size() + 1;
        data["journal"].append(entry);
        return "";
    }
    return "invalid_command";
}

Json::Value ReactorAuthority::update(Json::Value &data, const Json::Value &players,
                                     const std::vector<Json::Value> &messages,
                                     long long now) const {
    if (!data.isObject() || data["schemaVersion"] != 1) {
        data = Json::Value(Json::objectValue);
        data["schemaVersion"] = 1;
        data["state"] = profile_["initial"];
        data["revision"] = Json::UInt64(0);
        data["version"] = Json::UInt64(1);
        data["writer"] = Json::UInt64(0);
        data["writerEpoch"] = Json::UInt64(0);
        data["journal"] = Json::Value(Json::arrayValue);
        data["commands"] = Json::Value(Json::arrayValue);
        data["receipts"] = Json::Value(Json::arrayValue);
    }
    // Upgrade persisted v3 once without discarding the exercise or its audit.
    // Newly modelled inventories start at their teaching defaults; conservation
    // accounting starts at this boundary, not at an invented historical balance.
    if (data["state"]["modelVersion"] == 3) {
        auto upgraded = data["state"];
        upgraded["modelVersion"] = 4;
        upgraded["cycle"] = profile_["initial"]["cycle"];
        double mass = 0, energy = upgraded["graphiteTemperature"].asDouble() * 2890;
        for (unsigned i = 0; i < 2; ++i) {
            upgraded["fuelTemperatures"][i] = upgraded["fuelTemperature"];
            upgraded["voidFractions"][i] = upgraded["voidFraction"];
            upgraded["geometricLevels"][i] = (upgraded["loopMasses"][i].asDouble() - 700000) / 100 +
                                             700 * (upgraded["voidFraction"].asDouble() - 0.12);
            mass += upgraded["loopMasses"][i].asDouble() +
                    upgraded["cycle"]["returnMass"][i].asDouble() +
                    upgraded["cycle"]["injectionMass"][i].asDouble();
            energy += upgraded["loopEnergies"][i].asDouble() +
                      upgraded["cycle"]["returnEnergy"][i].asDouble() +
                      upgraded["cycle"]["injectionMass"][i].asDouble() * 0.17 +
                      upgraded["fuelTemperature"].asDouble() * 30;
        }
        upgraded["cycle"]["initialMass"] = mass;
        upgraded["cycle"]["initialEnergy"] = energy;
        if (!validSnapshot(upgraded))
            throw std::runtime_error("reactor_v3_migration_invalid");
        data["previousModelState"] = data["state"];
        data["state"] = std::move(upgraded);
        data["version"] = Json::UInt64(data["version"].asUInt64() + 1);
        data["writerEpoch"] = Json::UInt64(data["writerEpoch"].asUInt64() + 1);
    }
    unsigned long long writer = 0;
    for (const auto &player : players)
        if (player["reactor"].asBool() && (!writer || player["id"].asUInt64() < writer))
            writer = player["id"].asUInt64();
    if (writer != data["writer"].asUInt64()) {
        data["writer"] = Json::UInt64(writer);
        data["writerEpoch"] = Json::UInt64(data["writerEpoch"].asUInt64() + 1);
        data["version"] = Json::UInt64(data["version"].asUInt64() + 1);
    }
    Json::Value replies(Json::arrayValue);
    for (const auto &message : messages) {
        const auto present =
            std::find_if(players.begin(), players.end(), [&](const Json::Value &p) {
                return p["id"].asUInt64() == message["from"].asUInt64() &&
                       p["user_id"] == message["user_id"] && p["reactor"].asBool();
            });
        if (present == players.end())
            continue;
        if (message["type"] == "reactor_snapshot") {
            if (message["from"].asUInt64() == data["writer"].asUInt64() &&
                message["writerEpoch"].isUInt64() &&
                message["writerEpoch"].asUInt64() == data["writerEpoch"].asUInt64() &&
                message["revision"].isUInt64() &&
                message["revision"].asUInt64() == data["revision"].asUInt64() &&
                validSnapshot(message["state"]) &&
                message["state"]["elapsed"].asDouble() >= data["state"]["elapsed"].asDouble()) {
                data["state"] = message["state"];
                data["version"] = Json::UInt64(data["version"].asUInt64() + 1);
                data["updatedAt"] = Json::Int64(now);
            }
            continue;
        }
        if (message["type"] != "reactor_command" || !text(message["requestId"], 96, true))
            continue;
        const auto old = std::find_if(data["receipts"].begin(), data["receipts"].end(),
                                      [&](const Json::Value &receipt) {
                                          return receipt["user_id"] == message["user_id"] &&
                                                 receipt["requestId"] == message["requestId"];
                                      });
        if (old != data["receipts"].end()) {
            auto reply = *old;
            reply["to"] = message["from"];
            replies.append(reply);
            continue;
        }
        Json::Value reply;
        reply["type"] = "reactor_ack";
        reply["to"] = message["from"];
        reply["user_id"] = message["user_id"];
        reply["requestId"] = message["requestId"];
        // Apply to a candidate: a rejected request must leave all state unchanged.
        auto candidate = data;
        const auto error = command(candidate, message, now);
        reply["accepted"] = error.empty();
        reply["error"] = error;
        if (error.empty()) {
            data = std::move(candidate);
            data["revision"] = Json::UInt64(data["revision"].asUInt64() + 1);
            data["version"] = Json::UInt64(data["version"].asUInt64() + 1);
            data["updatedAt"] = Json::Int64(now);
            Json::Value record = message;
            record["revision"] = data["revision"];
            record["serverAt"] = Json::Int64(now);
            record["elapsed"] = data["state"]["elapsed"];
            if (message["command"]["kind"] == "control")
                record["value"] = data["state"]["controls"][message["command"]["name"].asString()];
            data["commands"].append(record);
            trimHistory(data["commands"], 2000);
        }
        reply["revision"] = data["revision"];
        data["receipts"].append(reply);
        trimHistory(data["receipts"], 2000);
        replies.append(reply);
    }
    return replies;
}

Json::Value ReactorAuthority::publicState(const Json::Value &data) {
    Json::Value result;
    result["type"] = "reactor_state";
    for (const char *field : {"state", "revision", "version", "writer", "writerEpoch", "updatedAt"})
        result[field] = data[field];
    result["journalCount"] = data["journal"].size();
    result["storage"] = "postgresql";
    result["physics"] = "elected-browser";
    return result;
}
} // namespace planet
