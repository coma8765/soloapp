add_library(solo-runtime INTERFACE)
target_include_directories(solo-runtime INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/..)
target_link_libraries(solo-runtime INTERFACE Drogon::Drogon PkgConfig::SODIUM)
