#include "professor.hpp"
#include "config.hpp"
#include <atomic>
#include <drogon/HttpClient.h>
#include <drogon/utils/Utilities.h>

namespace planet {
namespace {
std::atomic<int> active{0};
struct Turn : std::enable_shared_from_this<Turn> {
    solo::Callback callback;
    Json::Value result;
    explicit Turn(solo::Callback cb) : callback(std::move(cb)) {}
    ~Turn() { --active; }
    void finish(drogon::HttpStatusCode status, const Json::Value &body) {
        auto response = solo::JsonResponse(status, body);
        response->addHeader("Cache-Control", "no-store");
        if (status == drogon::k429TooManyRequests)
            response->addHeader("Retry-After", "2");
        auto cb = std::move(callback);
        cb(response);
    }
    void fail(const std::string &code) {
        Json::Value body;
        body["error"] = code;
        finish(drogon::k503ServiceUnavailable, body);
    }
    template <typename F>
    void send(const std::string &url, const std::string &path, const std::string &body,
              const std::string &contentType, double timeout, F next) {
        auto client = drogon::HttpClient::newHttpClient(url);
        auto req = drogon::HttpRequest::newHttpRequest();
        req->setMethod(drogon::Post);
        req->setPath(path);
        req->setContentTypeString(contentType);
        req->setBody(body);
        client->sendRequest(
            req,
            [self = shared_from_this(), client, next](auto status, const auto &response) {
                next(self, status == drogon::ReqResult::Ok ? response : nullptr);
            },
            timeout);
    }
    static std::string json(const Json::Value &value) {
        return Json::writeString(Json::StreamWriterBuilder(), value);
    }
    void transcribe(const std::string &audio) {
        send(env("WHISPER_URL", "http://whisper.soloapp.svc.cluster.local:8178"), "/transcribe",
             audio, "audio/wav", 90, [](const auto &self, const auto &response) {
                 if (response && response->statusCode() == drogon::k400BadRequest) {
                     Json::Value error;
                     error["error"] = "invalid_wav";
                     self->finish(drogon::k400BadRequest, error);
                     return;
                 }
                 if (response && response->statusCode() == drogon::k429TooManyRequests) {
                     Json::Value error;
                     error["error"] = "professor_busy";
                     self->finish(drogon::k429TooManyRequests, error);
                     return;
                 }
                 auto value = response ? response->getJsonObject() : nullptr;
                 if (!response || response->statusCode() != drogon::k200OK || !value ||
                     !(*value)["words"].isArray()) {
                     self->fail("professor_transcription_unavailable");
                     return;
                 }
                 std::string text;
                 for (const auto &word : (*value)["words"]) {
                     if (word["word"].isString())
                         text += word["word"].asString() + " ";
                 }
                 self->result["transcript"] = text;
                 self->result["answer"] = "";
                 self->result["audio_base64"] = "";
                 self->result["audio_mime"] = "audio/wav";
                 if (text.find_first_not_of(" \n\r\t") == std::string::npos) {
                     self->finish(drogon::k200OK, self->result);
                     return;
                 }
                 if (text.size() > 6000) {
                     self->fail("professor_transcript_too_long");
                     return;
                 }
                 self->generate(text);
             });
    }
    void generate(const std::string &text) {
        Json::Value request;
        request["model"] = "llama-3.2-1b-instruct";
        request["stream"] = false;
        request["cache_prompt"] = false;
        request["max_tokens"] = 128;
        request["temperature"] = 0.3;
        Json::Value system, user;
        system["role"] = "system";
        system["content"] =
            "Ты доброжелательный виртуальный профессор в учебной игре. Отвечай на русском кратко: "
            "1–3 предложения, до 500 символов. Если не знаешь, скажи об этом. Не выдавай себя за "
            "человека. Отвечай только на вопрос пользователя.";
        user["role"] = "user";
        user["content"] = text;
        request["messages"].append(system);
        request["messages"].append(user);
        send(env("LLAMA_URL", "http://llama.soloapp.svc.cluster.local:8180"),
             "/v1/chat/completions", json(request), "application/json", 45,
             [](const auto &self, const auto &response) {
                 if (response && response->statusCode() == drogon::k429TooManyRequests) {
                     Json::Value error;
                     error["error"] = "professor_busy";
                     self->finish(drogon::k429TooManyRequests, error);
                     return;
                 }
                 auto value = response ? response->getJsonObject() : nullptr;
                 if (!response || response->statusCode() != drogon::k200OK || !value ||
                     !(*value)["choices"].isArray() || (*value)["choices"].empty() ||
                     !(*value)["choices"][0]["message"]["content"].isString()) {
                     self->fail("professor_model_unavailable");
                     return;
                 }
                 auto answer = (*value)["choices"][0]["message"]["content"].asString();
                 if (answer.empty() || answer.size() > 4000) {
                     self->fail("professor_invalid_answer");
                     return;
                 }
                 self->result["answer"] = answer;
                 self->speak(answer);
             });
    }
    void speak(const std::string &text) {
        Json::Value request;
        request["text"] = text;
        send(env("TTS_URL", "http://tts.soloapp.svc.cluster.local:8179"), "/synthesize",
             json(request), "application/json", 20, [](const auto &self, const auto &response) {
                 if (response && response->statusCode() == drogon::k200OK &&
                     response->body().size() >= 44 && response->body().size() <= 4 * 1024 * 1024 &&
                     response->body().substr(0, 4) == "RIFF") {
                     self->result["audio_base64"] =
                         drogon::utils::base64Encode(std::string(response->body()));
                 } else {
                     self->result["audio_error"] = "professor_voice_unavailable";
                 }
                 self->finish(drogon::k200OK, self->result);
             });
    }
};
} // namespace
void professorReply(const std::string &audio, solo::Callback callback) {
    if (active.fetch_add(1) >= 1) {
        --active;
        auto response = solo::Error(drogon::k429TooManyRequests, "professor_busy");
        response->addHeader("Retry-After", "2");
        callback(response);
        return;
    }
    auto turn = std::make_shared<Turn>(std::move(callback));
    turn->transcribe(audio);
}
} // namespace planet
