# whoami

- docs/api.yaml — источник API-контракта.
- src/generated/api.hpp — результат общего API codegen.
- src/views — HTTP-адаптеры, по паре .hpp/.cpp на ручку.
- src/logic — предметная логика.
- deploy — Dockerfile и конфигурации развёртывания этого сервиса.
- tests — Python3 testsuite, C++ unit probe и HTTP-проверки.

Общий код импортируется из libs/runtime через CMake target solo-runtime. Генерация API включена в CMake; ручной запуск из корня: `python3 libs/api_codegen/generate.py services/whoami`.

Контейнер запускается в отдельном Kubernetes Deployment через deploy/ansible/tasks.yaml, по 2 реплики на ДЦ. ClusterIP Service доступен только подам nginx согласно NetworkPolicy. Образ, число реплик и ресурсы конфигурируются через deploy/defaults.yaml и infra/ansible/host_vars. Единственный маршрут GET /api/v1/whoami/v1/user-id требует подписанные auth-сервисом заголовки и отклоняет устаревшую/поддельную подпись.

Из каталога сервиса: `make` собирает Docker runtime-образ, `make test` запускает testsuite, `make check-codegen` проверяет API codegen. Из корня доступны `make whoami` и `make test-whoami`. Общие рецепты: `libs/build/service.mk`; тег по умолчанию — `dev`.

## Конфигурация ручек

`api.yaml` задаёт пути, методы, DTO, OpenAPI security и `x-route` (публикация, авторизация, body limit, таймауты, rate limit). Общий контракт и команды описаны в `libs/api_codegen/README.md`. После изменения выполните `make codegen` из корня проекта.
