# Общий код

- runtime — HTTP-ответы, ограниченный worker pool, HMAC-подпись межсервисного user-id; CMake target `solo-runtime`.
- api_codegen — общий генератор DTO и регистрации маршрутов Drogon по `services/*/docs/api.yaml`; интеграция CMake в `Codegen.cmake`.
- testing — повторно используемые fixtures Python3 testsuite для вызова C++ unit probes и тестового HMAC-ключа.

Предметная логика auth/whoami и ODB-модели остаются в сервисах. Инфраструктурные агенты Lockbox/сертификатов принадлежат своим функциям в infra/.

- build — общие Make-рецепты сборки сервисов, API codegen и запуска testsuite.
