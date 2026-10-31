#pragma once
#include <json/json.h>
#include <memory>
#include <openssl/rand.h>
#include <stdexcept>
#include <string>
namespace planet {
inline std::string encode(const Json::Value &value) {
    Json::StreamWriterBuilder writer;
    writer["indentation"] = "";
    return Json::writeString(writer, value);
}
inline Json::Value decode(const std::string &text) {
    Json::Value value;
    Json::CharReaderBuilder builder;
    std::string error;
    std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
    if (!reader->parse(text.data(), text.data() + text.size(), &value, &error))
        throw std::invalid_argument("invalid_json");
    return value;
}
inline std::string randomId() {
    unsigned char bytes[16];
    if (RAND_bytes(bytes, sizeof(bytes)) != 1)
        throw std::runtime_error("random_failed");
    static const char hex[] = "0123456789abcdef";
    std::string out;
    for (auto c : bytes) {
        out += hex[c >> 4];
        out += hex[c & 15];
    }
    return out;
}
} // namespace planet
