solo_api(client-notify)
find_program(ODB_COMPILER odb REQUIRED)
find_library(ODB_LIBRARY odb REQUIRED)
find_library(ODB_PGSQL_LIBRARY odb-pgsql REQUIRED)
find_package(CURL REQUIRED)
pkg_check_modules(RABBITMQ REQUIRED IMPORTED_TARGET librabbitmq)
set(ODB_DIR ${CMAKE_CURRENT_SOURCE_DIR}/src/generated/odb)
add_custom_command(OUTPUT ${ODB_DIR}/task-odb.cxx ${ODB_DIR}/task-odb.hxx ${ODB_DIR}/task-odb.ixx
 COMMAND ${CMAKE_COMMAND} -E make_directory ${ODB_DIR}
 COMMAND ${ODB_COMPILER} --std c++11 --database pgsql --generate-query --output-dir ${ODB_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/src/models/task.hpp
 DEPENDS src/models/task.hpp VERBATIM)
add_library(notify-odb src/logic/repository.cpp ${ODB_DIR}/task-odb.cxx)
target_include_directories(notify-odb PUBLIC src src/models ${PROJECT_SOURCE_DIR}/libs PRIVATE /usr/include/postgresql)
target_link_libraries(notify-odb PUBLIC ${ODB_LIBRARY} ${ODB_PGSQL_LIBRARY})
add_executable(client-notify-service src/main.cpp src/views/tasks.cpp src/logic/config.cpp src/logic/queue.cpp src/logic/gateway.cpp src/logic/worker.cpp)
add_dependencies(client-notify-service client-notify-api)
target_link_libraries(client-notify-service PRIVATE solo-runtime notify-odb CURL::libcurl PkgConfig::RABBITMQ)
install(TARGETS client-notify-service RUNTIME DESTINATION bin)

if(SOLO_BUILD_TESTS)
 add_executable(client-notify-unit-probe tests/unit_probe.cpp src/logic/config.cpp src/logic/queue.cpp)
 target_include_directories(client-notify-unit-probe PRIVATE /usr/include/postgresql)
 target_link_libraries(client-notify-unit-probe PRIVATE notify-odb solo-runtime PkgConfig::RABBITMQ)
endif()
