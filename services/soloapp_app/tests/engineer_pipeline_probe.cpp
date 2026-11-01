// A disposable HTTP probe for tests/engineer_pipeline.py; no database or user audio.
#include "logic/professor.hpp"
#include <fstream>
#include <iostream>
#include <iterator>
#include <thread>
int main(int argc, char **argv) {
    if (argc != 2)
        return 2;
    std::ifstream input(argv[1], std::ios::binary);
    const std::string audio((std::istreambuf_iterator<char>(input)), {});
    drogon::app().getLoop()->queueInLoop([audio] {
        planet::engineerReply(audio, [](const auto &response) {
            Json::Value out;
            out["status"] = static_cast<int>(response->statusCode());
            if (const auto body = response->getJsonObject())
                out["body"] = *body;
            std::cout << Json::writeString(Json::StreamWriterBuilder(), out) << std::endl;
            drogon::app().quit();
        });
    });
    drogon::app().run();
}
