#pragma once
#include "participants.hpp"
#include "world_store.hpp"
#include <atomic>
#include <drogon/HttpClient.h>
#include <drogon/WebSocketConnection.h>
#include <drogon/drogon.h>
#include <map>
#include <mutex>
#include <set>
#include <thread>
namespace planet {
class Game {
  public:
    Game();
    ~Game();
    void opened(const drogon::WebSocketConnectionPtr &socket);
    void closed(const drogon::WebSocketConnectionPtr &socket);
    void message(const drogon::WebSocketConnectionPtr &socket, const std::string &text);
    bool ready() const;
    bool leader = false;
    unsigned long long epoch = 0;
    std::atomic<unsigned long long> databaseErrors{0};
    size_t connections() const { return sessions_.size(); }

  private:
    struct Session {
        unsigned long long id = 0;
        drogon::WebSocketConnectionPtr socket;
        std::string token, user, email;
        ParticipantTelemetry telemetry;
        double participantsAt = -10;
        bool checking = false, joined = false;
        bool reactor = false;
        unsigned long long reactorVersion = 0, journalSequence = 0, commandRevision = 0;
        unsigned long long doorRevision = 0, professorRevision = 0, workersRevision = 0;
        long long professorSentAt = 0;
        double authAt = 0, window = 0;
        unsigned messages = 0;
        Json::Value state;
    };
    std::map<const drogon::WebSocketConnection *, Session> sessions_;
    std::set<unsigned long long> peers_;
    std::unique_ptr<WorldStore> store_;
    drogon::HttpClientPtr auth_;
    std::thread worker_;
    std::atomic<bool> stop_{false};
    std::atomic<double> lastFrame_{0};
    std::mutex mutex_;
    Json::Value local_{Json::arrayValue};
    std::vector<Json::Value> signals_;
    std::vector<Json::Value> reactorMessages_;
    void verify(const drogon::WebSocketConnectionPtr &socket, const std::string &token);
    void refresh();
    void received(Frame frame);
    static void send(const drogon::WebSocketConnectionPtr &, const Json::Value &);
    void reject(const drogon::WebSocketConnectionPtr &);
};
} // namespace planet
