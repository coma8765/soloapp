# Soloapp

Учебный стенд отказоустойчивой авторизации: C++/Drogon, PostgreSQL через ODB, nginx auth proxy и два независимых k3s-кластера. HAProxy направляет запросы в доступную площадку; PostgreSQL использует pg_auto_failover с monitor на третьем сервере. Grafana/Prometheus/Loki работают на обеих площадках.

Репозиторий содержит исходники и шаблоны. Адреса работающего стенда, cloud IDs, ключи, локальные отчёты и история provisioning не публикуются. Примеры используют зарезервированные адреса и домен `.invalid`.

## Быстрый старт: код и тесты

Нужны Python 3, Make и Docker. Production-доступ для локальных тестов не требуется.

```sh
python3 -m venv .venv-codegen
.venv-codegen/bin/pip install -r libs/api_codegen/requirements.txt
make check-codegen test-codegen
make build TAG=dev
make test
```

`make auth`, `make whoami` и `make -C services/auth` собирают отдельный сервис. Тесты используют Python3 testsuite, синтетические ключи и изолированную PostgreSQL. ODB 2.4 и Drogon собираются внутри Docker; первый build требует сети и занимает время.

## Структура

```text
services/{auth,whoami}/
  docs/api.yaml               # OpenAPI и политика ручек
  src/{generated,views,logic}/
  deploy/{Dockerfile,k8s,ansible}/
  tests/
services/nginx/               # auth proxy и generated-маршруты
libs/                         # runtime, ODB pool, API codegen, test fixtures
infra/                        # Ansible, сеть, PostgreSQL, ingress, secrets, monitoring
```

В каждом ДЦ по два пода auth, nginx, whoami и web. У каждого сервиса собственные Deployment и Service. RollingUpdate: `maxUnavailable: 0`, `maxSurge: 1`. Реплики и ресурсы переопределяются через `infra/ansible/host_vars/`.

## API

`services/<service>/docs/api.yaml` — обычный YAML. Поле `x-route` на каждой операции задаёт внешнюю публикацию, способ проверки личности, размер тела, таймауты и rate limit. Из схем генерируются C++ DTO/routes, правила nginx и типизированные Dart-клиенты.

```sh
make codegen
make check-codegen
```

| Ручка | Назначение |
|---|---|
| POST /api/v1/auth/v1/register | Регистрация |
| POST /api/v1/auth/v1/login | Выдача Bearer-сессии |
| GET /api/v1/auth/v1/me | Пользователь действующей сессии |
| POST /api/v1/auth/v1/logout | Отзыв сессии |
| GET /api/v1/whoami/v1/user-id | Проверка сессии через auth и передача подписанной личности в whoami |

Регистрация открытая. Персональные роли, ACL и блокировка пользователя не реализованы. Подробности — [формат политики ручек](libs/api_codegen/README.md), [auth](services/auth/docs/README.md), [whoami](services/whoami/docs/README.md).

## Настройка собственного стенда

```sh
cp infra/ansible/inventory.example.yaml infra/ansible/inventory.yaml
cp infra/cloud/resources.example.json infra/cloud/resources.json
# Заполните локальные копии собственными адресами, SSH-пользователями и resource IDs.
ansible-galaxy collection install -r infra/ansible/requirements.yaml
ansible-playbook infra/ansible/apps.yaml --check
```

Обе локальные копии исключены из Git и Docker context. `public_domain` задаёт домен в inventory; штатный SSH-agent используется по умолчанию. Для особого агента настройте `ansible_ssh_common_args` в локальном inventory. Diagnostic SSH helpers читают тот же inventory; альтернативный путь задаётся `SOLOAPP_INVENTORY`.

Шаблоны рассчитаны на YC application node, домашнюю application node и третью edge/monitor node. RFC1918-адреса WireGuard и подсети pod/service — пример фиксированной трёхузловой топологии; при изменении сети согласованно обновите её конфиги. Образы и версии задаются в inventory/defaults.

**Это не provisioning с нуля.** Создание VM, IAM/federation, Lockbox payloads, WireGuard bootstrap, первичная PostgreSQL и сертификаты требуют отдельной подготовки. `site.yaml` обслуживает уже инициализированную инфраструктуру и не создаёт пустую БД при потере данных. [Развёртывание](infra/ansible/README.md), [мониторинг](infra/observability/README.md).

Live-тесты требуют вашего inventory и меняют состояние стенда; аварийные тесты временно изолируют сеть. Они не запускаются в CI. Простой API smoke test:

```sh
SOLOAPP_BASE_URL=https://your-domain.example python3 services/nginx/tests/smoke.py
```

## CI/CD

[GitHub Actions](https://github.com/coma8765/soloapp/actions) проверяет C++ сервисы, codegen, секреты и Flutter web. После зелёного CI для `main` production workflow собирает образы на стенде и последовательно обновляет YC и home, проверяя API после обновления обеих площадок. Ручной повтор — `Deploy production` → `Run workflow`. [Устройство CD и ротация ключей](infra/cd/README.md).

`services/web` содержит форму регистрации/входа и проверку Whoami. Один build публикуется и проверяется на двух собственных S3-площадках до активации релиза. [Хранение версий и rollback](infra/object-storage/README.md).

## Ограничения

- Синхронная репликация в штатном режиме; после потери второй площадки допускается запись на одной копии. Её последующая потеря может уничтожить новые данные.
- 15 секунд — целевой RTO проверяемых сценариев, а не гарантия. При переключении возможны ошибки; безопасные повторы требуют учитывать неопределённый результат записи.
- Независимые backups/PITR не настроены. Два пода на одном сервере не заменяют второй сервер.
- Межплощадочный ingress и PostgreSQL используют mTLS. Внутри одного k3s-кластера HTTP ограничивается NetworkPolicy.
- Grafana имеет отдельную пользовательскую БД на каждой площадке; при failover может потребоваться повторный вход. Доставка метрик/логов в два хранилища не гарантирует идентичную историю.

## Проверка перед публикацией

```sh
# Установите gitleaks локально, например brew install gitleaks.
make public-check
```

Проверяется набор файлов Git с учётом ignore-правил; секреты в диагностике скрыты. Проверяйте именно этот набор, а не архив всей рабочей директории. `.gitignore` не защищает уже отслеживаемые файлы. Процесс и CI описаны в [PUBLICATION.md](PUBLICATION.md).

## Лицензия

Собственный код — [Apache-2.0](LICENSE). Зависимости сохраняют свои лицензии; это не заявление, что весь собранный контейнер лицензирован под Apache-2.0. В частности, ODB runtime имеет отдельные GPL-2.0/commercial условия: перед распространением связанных binaries/images требуется разрешить совместимость лицензий. В репозитории нет публикации бинарных релизов. См. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Private release images

Runtime images are built locally or on GitHub-hosted CI, then retained in the private S3-backed registry on both sites. Production servers only publish, pull and roll ready images. Deployments use digests; `Deploy production` → `rollback_revision` restores a recorded release without rebuilding or supplying image archives. See [registry operations](infra/registry/README.md) and [CI/CD](infra/cd/README.md).

## App API (NestJS)

`services/app-api` проверяет подписанную nginx личность тем же HMAC-контрактом, что и whoami.
`GET /api/v1/app-api/v1/user-id` принимает Bearer-сессию через gateway и возвращает `{"user_id":"…"}`.
Сборка: `make build-app-api`; изолированные тесты: `make test-app-api`.
NestJS заменяет реализацию whoami: один Deployment `whoami`, по два пода на ДЦ.
Совместимый URL `/api/v1/whoami/v1/user-id` сохранён; дополнительный URL app-api ведёт в те же поды.
Настройка ключа, запуск и подготовка площадок: [app-api](services/app-api/README.md).
