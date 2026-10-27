# Политика HTTP-ручек

Источник маршрутов C++ и публикации прикладного API — `services/<service>/docs/api.yaml`.
Файл использует обычный YAML с отступами и комментариями. Загрузка через безопасный PyYAML loader; повторяющиеся ключи и Python-теги запрещены.
Каждая операция содержит `operationId`, стандартное OpenAPI `security` и обязательный `x-route`.

```yaml
/api/v1/whoami/v1/user-id:
  get:
    operationId: user_id
    security:
      - bearerAuth: []
    x-route:
      exposure: public
      auth: signed-user
      max_body_bytes: 8192
      timeouts:
        connect_seconds: 2
        read_seconds: 15
      rate_limit: null
```

| Поле | Значение |
|---|---|
| path + HTTP method | Путь и допустимый метод; неизвестный путь получает 404, другой метод — 405 |
| exposure | `public` публикует точный путь в nginx; `internal` оставляет только внутри сервисной сети |
| auth: none | Авторизация на gateway не требуется; клиентские заголовки личности и Authorization удаляются |
| auth: bearer | Bearer передаётся сервису, который проверяет его в обработчике; это режим auth/me, auth/logout и внутреннего verifier |
| auth: signed-user | nginx выполняет внутреннюю проверку сессии, передаёт подписанные user-id/timestamp и удаляет исходный Bearer; whoami проверяет подпись |
| max_body_bytes | 1..1048576; ограничивается nginx и сгенерированной C++ обёрткой каждой операции |
| timeouts.connect_seconds | 1..300; таймаут установления соединения nginx с сервисом |
| timeouts.read_seconds | 1..300; таймаут между чтениями ответа upstream, не общий дедлайн операции и не SQL timeout |
| rate_limit | `null` либо `{group: auth, requests_per_second: 5, burst: 10}`; превышение даёт 429 |

Одинаковая `group` делит один лимит запросов по IP внутри одного nginx-пода. Это не глобальная квота: у каждого пода собственное состояние. Скорость группы должна совпадать во всех операциях; burst может отличаться. `burst: 0` отключает очередь всплеска. Внешний HAProxy также имеет общий `timeout server 20s`: увеличение nginx read timeout не отменяет этот внешний предел. Таймауты и rate limit действуют на публичном gateway; внутренние клиенты ограничены NetworkPolicy и проверками самого сервиса.

`security: []` обязательно для `auth: none`; для остальных — `security: [{bearerAuth: []}]`.
Схема описывает внешний Bearer-контракт whoami, хотя внутренний вызов использует подписанные заголовки.
`bearer` не реализует произвольный авторизатор автоматически: новый сервис с таким режимом обязан проверять сессию сам. Для сервиса за существующим auth_request выбирайте `signed-user` и проверяйте подписанную личность.
Права по ролям и блокировки пользователя не добавлены: это отдельная политика auth/бизнес-логики.

Генератор отклоняет неизвестные ключи, небезопасные пути, конфликты OpenAPI security и общей rate-группы. Поддерживаются буквальные пути без параметров и методы GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS. Методы одного пути обязаны иметь одну gateway-политику; разные политики отклоняются, а не объединяются в более разрешительную. HEAD нужно объявить явно.
`/internal/*`, `/_verify`, `/healthz` и `/grafana*` зарезервированы для инфраструктуры. `/internal/verify` не публикуется; nginx использует закрытый `/_verify`.

Служебный `/healthz` nginx, его локальный health listener и проксирование внешнего приложения Grafana остаются в nginx deploy-шаблоне. Пользовательские ручки, включая публичный auth `/ready`, генерируются из схем сервисов. Переименование путей kubelet/Alloy health-проб требует согласованного изменения инфраструктурных проб.

## Генерация и применение

```sh
make codegen          # C++ DTO/routes и nginx fragments
make check-codegen    # обнаружить забытые/устаревшие generated-файлы
make test-codegen     # проверки политики, доступа, инъекций и лимитов
make test             # testsuite обоих C++ сервисов
make build TAG=<release>
# Доставить новые образы в containerd каждого кластера и обновить image в inventory.
ansible-playbook infra/ansible/apps.yaml
```

После изменения только gateway-параметров (auth/exposure/timeouts/rate) достаточно `make codegen` и `ansible-playbook infra/ansible/apps.yaml --tags nginx`. Изменения пути, метода, DTO или лимита тела требуют также пересборки и раскатки соответствующего C++ сервиса. Для безопасного добавления ручки сначала разверните реализацию, затем gateway.

Результаты: `src/generated/api.hpp` каждого сервиса и `services/nginx/deploy/generated/{maps,routes}.conf.j2`. Их нельзя редактировать вручную. `libs/api_codegen/route_policy.py` содержит общую проверку; `generate.py` и `generate_nginx.py` используют её. CMake учитывает зависимость от валидатора. Ansible останавливается при устаревших gateway-файлах и проверяет итоговый `nginx -t` в существующем поде до изменения ресурсов. ConfigMap получает новый хеш, после чего выполняется RollingUpdate по одному ДЦ.

Проверка опубликованного API: `SOLOAPP_BASE_URL=https://your-domain.example python3 services/nginx/tests/smoke.py` (создаёт одного синтетического пользователя и отзывает его сессию; значения токенов не печатаются).

Локальная зависимость codegen: `python3 -m venv .venv-codegen && .venv-codegen/bin/pip install -r libs/api_codegen/requirements.txt`. Make использует эту среду, если она существует; можно также указать `PYTHON=/path/to/python`. В Docker-зависимости сборки и testsuite включён PyYAML.

Dart-клиенты для web генерируются из тех же YAML командой `make codegen-web`. `x-backend-aliases` сохраняет прежние адреса только внутри backend для rolling-совместимости со старыми pod nginx. Эти aliases не публикуются gateway и не попадают в Dart-клиент. Бизнес API использует `/api/v1/<service>/v1/...`; служебные `/healthz`, `/health/ready`, `/ready` и Grafana сохраняют отдельные адреса.
