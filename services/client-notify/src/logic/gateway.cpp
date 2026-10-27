#include "gateway.hpp"
#include <curl/curl.h>
#include <json/json.h>
#include <memory>
#include <sstream>
namespace solo::notify {
namespace {
size_t Receive(char *data, size_t size, size_t count, void *context) {
    auto &text = *static_cast<std::string *>(context);
    auto n = size * count;
    if (text.size() + n > 65536)
        return 0;
    text.append(data, n);
    return n;
}
int Progress(void *context, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
    return static_cast<std::atomic<bool> *>(context)->load() ? 1 : 0;
}
std::pair<long, std::string> Request(const Config &c, const Task &task, bool cancel,
                                     std::atomic<bool> &abort) {
    std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> curl(curl_easy_init(), curl_easy_cleanup);
    if (!curl)
        return {0, {}};
    Json::Value body;
    body["task_id"] = task.task_id;
    body["attempt"] = Json::UInt64(task.attempt);
    body["deadline_ms"] = Json::Int64(NowMs() + c.delivery_ms);
    if (!cancel) {
        body["recipient"] = task.recipient;
        body["payload"] = task.payload;
    }
    Json::StreamWriterBuilder writer;
    writer["indentation"] = "";
    auto encoded = Json::writeString(writer, body);
    auto url = c.gateway_url + (cancel ? "/internal/delivery/cancel" : "/internal/delivery");
    curl_slist *headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, ("Authorization: Bearer " + c.gateway_token).c_str());
    headers = curl_slist_append(headers, ("Idempotency-Key: " + task.task_id).c_str());
    std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)> owned(headers, curl_slist_free_all);
    auto *h = curl.get();
    std::string response;
    curl_easy_setopt(h, CURLOPT_URL, url.c_str());
    curl_easy_setopt(h, CURLOPT_POST, 1L);
    curl_easy_setopt(h, CURLOPT_POSTFIELDS, encoded.c_str());
    curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE, static_cast<long>(encoded.size()));
    curl_easy_setopt(h, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(h, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(h, CURLOPT_CONNECTTIMEOUT_MS, 1000L);
    curl_easy_setopt(h, CURLOPT_TIMEOUT_MS, cancel ? 1000L : static_cast<long>(c.delivery_ms));
    curl_easy_setopt(h, CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(h, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(h, CURLOPT_SSL_VERIFYHOST, 2L);
    if (!c.gateway_ca.empty())
        curl_easy_setopt(h, CURLOPT_CAINFO, c.gateway_ca.c_str());
    if (!c.gateway_cert.empty())
        curl_easy_setopt(h, CURLOPT_SSLCERT, c.gateway_cert.c_str());
    if (!c.gateway_key.empty())
        curl_easy_setopt(h, CURLOPT_SSLKEY, c.gateway_key.c_str());
    curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, Receive);
    curl_easy_setopt(h, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(h, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(h, CURLOPT_XFERINFOFUNCTION, Progress);
    curl_easy_setopt(h, CURLOPT_XFERINFODATA, &abort);
    if (curl_easy_perform(h) != CURLE_OK)
        return {0, {}};
    long status = 0;
    curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &status);
    return {status, response};
}
} // namespace
bool Gateway::Deliver(const Task &task, std::atomic<bool> &cancel) {
    auto [status, text] = Request(config_, task, false, cancel);
    if (status != 200 || cancel)
        return false;
    Json::Value response;
    Json::CharReaderBuilder builder;
    std::istringstream input(text);
    std::string errors;
    return Json::parseFromStream(builder, input, &response, &errors) &&
           response["task_id"].asString() == task.task_id && response["attempt"].isUInt64() &&
           response["attempt"].asUInt64() == task.attempt &&
           response["status"].asString() == "delivered";
}
void Gateway::Cancel(const Task &task) {
    // Best effort, bounded and detached from the delivery retry path. Correctness
    // requires gateway expiry/fencing; cancellation packets themselves may be lost.
    cancellation_workers_.Add([config = config_, task] {
        std::atomic<bool> abort{false};
        try {
            Request(config, task, true, abort);
        } catch (...) {
        }
    });
}
} // namespace solo::notify
