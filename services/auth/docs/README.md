# auth

- docs/api.yaml — источник API-контракта.
- src/generated/api.hpp — результат общего API codegen.
- src/views — HTTP-адаптеры, по паре .hpp/.cpp на ручку.
- src/logic — предметная логика.
- deploy — Dockerfile и конфигурации развёртывания этого сервиса.
- tests — Python3 testsuite, C++ unit probe и HTTP-проверки.

Общий код импортируется из libs/runtime через CMake target solo-runtime. Генерация API включена в CMake; ручной запуск из корня: `python3 libs/api_codegen/generate.py services/auth`.

ODB-модели: src/models/entities.hpp; сгенерированный доступ к PostgreSQL: src/generated/odb. OdbRepository реализует интерфейс Repository, unit-тесты используют in-memory double, интеграционные тесты — настоящую временную PostgreSQL. Production DDL хранится в deploy/schema.sql и применяется только отдельной осознанной миграцией.

Из каталога сервиса: `make` собирает Docker runtime-образ, `make test` запускает testsuite, `make check-codegen` проверяет API codegen. Из корня доступны `make auth` и `make test-auth`. Общие рецепты: `libs/build/service.mk`; тег по умолчанию — `dev`.


## Пул PostgreSQL

`libs/odb/primary_pool.hpp` расширяет пул ODB: соединения создаются лениво и
переиспользуются; одновременно не больше `db_pool.max_connections` на pod.
Значения по умолчанию задаются в `services/auth/deploy/defaults.yaml`:

```yaml
db_pool:
  max_connections: 4
  max_lifetime_seconds: 300
  tcp_user_timeout_ms: 2000
```

Ansible передаёт их как `DB_POOL_MAX_CONNECTIONS`,
`DB_POOL_MAX_LIFETIME_SECONDS`, `DB_TCP_USER_TIMEOUT_MS`. Настройки можно
переопределять в конфигурации площадки через `service_overrides.auth.db_pool` в `infra/ansible/host_vars/<yc|home>.yaml`.
При двух pod на ДЦ штатный максимум — 16 соединений. Во время rolling update
есть дополнительные pod, в том числе terminating: они могут удерживать
соединения до завершения процесса. Для текущей схемы закладывается запас до
32 соединений auth на время перекрытия старых и новых pod двух площадок. Четыре соединения
соответствуют четырём рабочим потокам auth; увеличение без изменения числа
потоков само по себе не увеличивает параллелизм.

Перед каждой бизнес-транзакцией ODB-generated view проверяет, что сервер
не находится в recovery и транзакция допускает запись. Непригодное соединение
исключается из пула; разрешена одна повторная попытка получения соединения и
проверки primary. Бизнес-запросы и commit автоматически не повторяются:
при обрыве связи результат записи может быть неизвестен.

Истёкшее соединение заменяется при следующем получении из пула; активные
транзакции по таймеру не прерываются. Новое подключение читает актуальные TLS-файлы
из RAM-хранилища секретов. TCP user timeout и keepalive ограничивают зависание
уже установленных соединений; время переключения всей системы также зависит
от обнаружения отказа PostgreSQL и маршрутизации.

`tests/test_pool.py` проверяет повторное использование, предел параллельных
соединений, восстановление после pg_terminate_backend, обновление по сроку
жизни и исключение read-only соединения. Запуск: `make -C services/auth test`.

## Конфигурация ручек

`api.yaml` задаёт пути, методы, DTO, OpenAPI security и `x-route` (публикация, авторизация, body limit, таймауты, rate limit). Общий контракт и команды описаны в `libs/api_codegen/README.md`. После изменения выполните `make codegen` из корня проекта.
