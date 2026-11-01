#include "engineer.hpp"
#include <cstdlib>
#include <iostream>
void require(bool condition, const char *message) {
    if (!condition) {
        std::cerr << message << std::endl;
        std::exit(1);
    }
}
int main() {
    using namespace planet::engineer;
    require(keywords("Для чего нужны стержни СУЗ?") == "стержни суз",
            "Question filler pollutes search");
    require(keywords("Что такое ОЗР и АЗ-5?") == "озр аз-5", "Lost abbreviations");
    require(keywords("Расскажи, пожалуйста") == "", "Empty question should not trigger model");
    Json::Value rows(Json::arrayValue), row;
    row["document_id"] = "rbmk1000:test";
    row["metadata"]["corpus"] = "rbmk1000-vr-research";
    row["source_text"] = "Нельзя смешивать типы реакторов";
    row["score"] = 1.0;
    rows.append(row);
    require(selectSources(rows).empty(), "Foreign reactor corpus leaked");
    require(selectSources(rows, "rbmk1000-vr-research").size() == 1,
            "Explicit corpus selection failed");
    row["metadata"]["corpus"] = corpus;
    rows.append(row);
    require(selectSources(rows).empty(), "Mismatched corpus/document prefix leaked");
    row["document_id"] = "vver1200:V16:survey";
    rows.append(row);
    row["document_id"] = "vver1200:V17:survey";
    rows.append(row);
    require(selectSources(rows).empty(), "Cross-design survey leaked into VVER answer");
    bool invalidCorpus = false;
    try {
        selectSources(rows, "unknown");
    } catch (const std::invalid_argument &) {
        invalidCorpus = true;
    }
    require(invalidCorpus, "Unknown corpus accepted");
    row["document_id"] = "vver1200:V01";
    row["metadata"]["corpus"] = corpus;
    row["metadata"]["source_url"] = "https://example.org/source";
    row["page_from"] = 12;
    row["source_text"] = "Стержни поглощают нейтроны.";
    rows.append(row);
    rows.append(row);
    auto found = selectSources(rows);
    require(found.size() == 1, "Duplicate evidence was not removed");
    require(found[0]["page_from"] == 12, "Lost page attribution");
    require(found[0]["source_url"] == "https://example.org/source", "Lost source attribution");
    row["score"] = 0;
    row["source_text"] = "Нерелевантно";
    rows.append(row);
    require(selectSources(rows).size() == 1, "Zero score accepted");
    for (int i = 0; i < 6; ++i) {
        row["score"] = 1;
        row["source_text"] = "Другой текст " + std::to_string(i);
        rows.append(row);
    }
    require(selectSources(rows).size() == 3, "Context bound missing");
    bool rejected = false;
    try {
        selectSources(Json::Value(Json::objectValue));
    } catch (const std::invalid_argument &) {
        rejected = true;
    }
    require(rejected, "Invalid search response became an empty result");
    require(bounded("АБВ", 3) == "А", "UTF-8 truncation splits a character");
    const auto request = rewriteRequest("model", "Вопрос", found);
    require(request["model"] == "model" && request["stream"] == false, "Wrong Ollama request");
    require(request["messages"][0]["role"] == "system" && request["messages"][1]["role"] == "user",
            "Evidence role changed");
    require(request["messages"][1]["content"].asString().find("source_url") == std::string::npos,
            "Provenance leaked into paraphrasing context");
    require(std::string(fallback) == "Будьте серъёзнее или задавайте более осознанные вопросы",
            "Fallback changed");
    std::cout << "Engineer corpus isolation, provenance, bounds, UTF-8 and model request: OK\n";
}
