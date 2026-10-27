# Redis Sentinel / общий чат

Две Redis 7.2.17 (YC/home), три Sentinel (YC/home/edge), quorum 2. Падение одной площадки оставляет два голоса. Это primary/replica с Sentinel, **не Redis Cluster**. Сервисы получают master через все три Sentinel; Redis не выставляется во внешний балансер.

`defaults.yaml`: порты, pinned image, память, down-after 5 секунд, failover-timeout 15 секунд. Последний параметр не гарантирует RTO: нужно время обнаружения, выборов и переподключения клиента. AOF everysec + асинхронная репликация допускают потерю последних подтверждённых сообщений при аварии. `min_replicas_to_write: 0` позволяет писать с одной копией; при сетевом разделении возможны расходящиеся записи старого primary. Чат не подходит для платежей или единственного журнала бизнес-событий.

Данные /var/lib/soloapp-redis/data; TLS и пароли в Lockbox и tmpfs `/run`. `bootstrap.py` выдаёт node identity чтение только нового Redis secret; существующие whoami identities получают chat/discovery credentials через их прежние секреты. ACL chat разрешает только `soloapp:chat:*`, stream/dedup/rate commands, запрещает CONFIG/FLUSHALL/репликацию/служебный PubSub Sentinel. Sentinel discovery не может запускать failover. TLS проверяет CA, шифрование WireGuard — дополнительный уровень. Redis слушает только WireGuard IP и loopback; plaintext port отключён.

`manage.py` использует штатный Docker image без сборки на сервере, конфиг с паролями находится только в RAM. На диск сохраняются whitelist строк топологии (роль, epoch, known peers), чтобы restart не возвращал первоначальный master. AOF и история содержат сообщения пользователей. Срок хранения истории ограничен количеством (500 записей, выдача последних 100), не временем; dedup записи живут сутки. Образ BSD Redis 7.2 сохраняет upstream-лицензию.

```sh
.venv-codegen/bin/python infra/redis/bootstrap.py
ansible-playbook infra/redis/deploy.yaml
ansible-playbook infra/network/isolate.yaml
```

Сначала Redis, затем app-api, nginx и web через обычный CI/CD. Все сборки выполняются локально или в GitHub Actions. Redis/Sentinel работают как systemd-supervised контейнеры с host networking, независимо от управления двумя k3s; прикладные контейнеры остаются в pod network.

Ротация ACL: создать новые согласованные версии Lockbox, дождаться refresh, затем последовательно выполнить deploy с restart по одной площадке. Сначала добавить второй пароль/переходные credentials для безостановочной ротации; одномоментная смена единственного пароля потребует переподключения. Сертификаты node обновляет общий issuer; после смены TLS файлов Redis/Sentinel необходимо перезапустить последовательно по площадкам. Не перезаписывать живую топологию bootstrap-конфигом.
