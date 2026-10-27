#include "generated/odb/task-odb.hxx"
#include "logic/config.hpp"
#include "logic/repository.hpp"
#include "runtime/deadline.hpp"
#include <iostream>
#include <json/json.h>
#include <thread>
int main(int argc, char **argv) {
    using namespace solo::notify;
    Json::Value out;
    if (argc > 1 && std::string(argv[1]) == "deadline") {
        auto started = std::chrono::steady_clock::now();
        std::atomic<long long> fired{-1};
        {
            solo::Deadline deadline(30000, [&] {
                fired = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::steady_clock::now() - started)
                            .count();
            });
            std::this_thread::sleep_for(std::chrono::milliseconds(31000));
            out["expired"] = deadline.expired.load();
            out["elapsed_ms"] = Json::Int64(fired.load());
        }
        std::atomic<bool> unexpected{false};
        {
            solo::Deadline completed(100, [&] { unexpected = true; });
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        out["early_completion_cancelled_timer"] = !unexpected.load();
    } else {
        auto dsn = SecretFile("DATABASE_URL_FILE");
        Repository repository(dsn);
        auto task = repository.Submit("repository-fencing-unit", "test", "data");
        auto first = repository.Claim(task.task_id, 30000);
        auto duplicate = repository.Claim(task.task_id, 30000);
        out["one_owner"] = first.has_value() && !duplicate.has_value();
        odb::pgsql::database db(dsn);
        {
            odb::transaction tx(db.begin());
            std::unique_ptr<Task> row(db.load<Task>(task.task_id));
            row->lease_ms = NowMs() - 1;
            db.update(*row);
            tx.commit();
        }
        auto next = repository.Claim(task.task_id, 30000);
        out["stale_completion_rejected"] = !repository.Finish(*first, true, 1000);
        out["new_attempt_completed"] = repository.Finish(*next, true, 1000);
        out["monotonic_attempt"] = next->attempt > first->attempt;
        out["completed_not_claimed"] = !repository.Claim(task.task_id, 30000).has_value();
    }
    std::cout << out << std::endl;
}
