#include "logic/auth.hpp"
#include "runtime/health.hpp"
#include <iostream>
#include <map>
#include <sodium.h>
namespace logic = solo::auth::logic;
class MemoryRepository : public logic::Repository {
  public:
    std::map<std::string, logic::UserRecord> users;
    std::map<std::string, std::string> sessions;
    bool CreateUser(const logic::UserRecord &u) override {
        return users.emplace(u.username, u).second;
    }
    std::optional<logic::UserRecord> FindUser(const std::string &name) override {
        auto i = users.find(name);
        if (i == users.end())
            return {};
        return i->second;
    }
    void CreateSession(const std::string &hash, const std::string &id) override {
        sessions[hash] = id;
    }
    std::optional<std::string> FindSession(const std::string &hash) override {
        auto i = sessions.find(hash);
        if (i == sessions.end())
            return {};
        return i->second;
    }
    void DeleteSession(const std::string &hash) override { sessions.erase(hash); }
    void CheckReady() override {}
};
int main() {
    if (sodium_init() < 0)
        return 1;
    Json::Value input, output;
    std::cin >> input;
    try {
        auto command = input["command"].asString();
        if (command == "health") {
            solo::HealthCircuit health(3, std::chrono::seconds(10), std::chrono::seconds(15));
            const auto start = solo::HealthCircuit::Time{};
            for (const auto &event : input["events"]) {
                const auto now = start + std::chrono::milliseconds(event["ms"].asInt());
                Json::Value state;
                state["tripped"] = health.Record(event["code"].asInt(), now);
                state["ready"] = health.Ready(now);
                output["states"].append(state);
            }
            output["ready"] =
                health.Ready(start + std::chrono::milliseconds(input["check_ms"].asInt()));
        } else if (command == "credentials") {
            auto c = solo::auth::generated::Credentials::FromJson(input["body"]);
            output["username"] = logic::NormalizeUsername(c.username);
        } else if (command == "bearer")
            output["token"] = logic::ParseBearer(input["header"].asString());
        else if (command == "digest")
            output["digest"] = logic::TokenDigest(input["token"].asString());
        else if (command == "flow") {
            MemoryRepository repository;
            logic::AuthService service(repository);
            auto credentials = solo::auth::generated::Credentials::FromJson(input["body"]);
            const auto id = service.Register(credentials).user_id;
            const auto session = service.Login(credentials);
            output["identity_matches"] =
                service.Verify("Bearer " + session.access_token).user_id == id;
            output["only_digest_stored"] =
                repository.sessions.count(logic::TokenDigest(session.access_token)) == 1 &&
                repository.sessions.count(session.access_token) == 0;
            output["password_is_argon2"] =
                repository.users.begin()->second.password_hash.find("$argon2id$") == 0;
            try {
                service.Register(credentials);
                output["duplicate_status"] = 200;
            } catch (const logic::AuthError &e) {
                output["duplicate_status"] = e.status;
            }
            credentials.password = "wrong-password-123";
            try {
                service.Login(credentials);
                output["wrong_password_status"] = 200;
            } catch (const logic::AuthError &e) {
                output["wrong_password_status"] = e.status;
            }
            service.Logout("Bearer " + session.access_token);
            try {
                service.Verify("Bearer " + session.access_token);
                output["revoked_status"] = 200;
            } catch (const logic::AuthError &e) {
                output["revoked_status"] = e.status;
            }
        } else
            return 2;
        output["status"] = 200;
    } catch (const logic::AuthError &e) {
        output["status"] = e.status;
    } catch (const std::invalid_argument &) {
        output["status"] = 400;
    }
    std::cout << output << std::endl;
}
