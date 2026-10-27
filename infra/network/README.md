# Изоляция pod

`ansible-playbook infra/network/isolate.yaml` последовательно включает default-deny **Ingress и Egress** для всех pod в `default`, `soloapp`, `observability`. Даже новый pod без `app` не получает доступ к DNS, соседям или интернету. `kube-system` управляет CNI, DNS и storage и не изолируется этим playbook. Новый namespace нужно явно добавить в `namespaces` перед размещением приложений; это не глобальный admission controller.

Матрица разрешений находится в `connections.yaml.j2`: пары source/target + порт автоматически создают обе стороны NetworkPolicy. Адреса узлов и порты подставляются из inventory. Добавление Redis не разрешает всем приложениям ходить к нему: Redis и Sentinel разрешены только `soloapp/whoami` (Nest app-api); Redis ACL дополнительно ограничивает ключи/команды. Auth обращается к PG, web — к S3, nginx — к явно перечисленным backend и Grafana gateway. Alloy получает только необходимые probe/scrape/API/logging направления.

Внешний TCP/443 явно разрешён перечисленным workload для IAM/Lockbox, OAuth, YC API и Telegram relay. Это разрешение **на публичные IPv4**, а не фильтр по домену: NetworkPolicy не поддерживает FQDN. RFC1918, pod/service сети и metadata исключены. Произвольный HTTP, другие порты и трафик новых workload остаются закрыты. DNS разрешён только CoreDNS; IPv6 egress не разрешён. При необходимости строгого списка внешних доменов нужен отдельный egress proxy или CNI с FQDN policy.

Существующие service-owned ingress policy остаются аддитивными. NetworkPolicy управляет L3/L4 pod-трафиком, не заменяет mTLS, Redis ACL, HTTP-auth, RBAC или host firewall. Трафик самого узла, kubelet probes и hostNetwork не являются границей изоляции этой политики. Права менять labels/NetworkPolicy выдаются только доверенному deployment/operator; создание pod с метками существующего сервиса также выдаёт его сетевую роль.

Проверка на узле: `sudo python3 probe.py` (скрипт из `tests/`). Он создаёт pod без ключей и Service endpoint, проверяет запрет egress и доступ после явного назначения роли, затем удаляет pod. Перед проверкой фильтров нужны новые TCP-соединения: существующий conntrack может сохранять established-сеансы.

Откат **только новых политик**: `kubectl delete networkpolicy -A -l soloapp.io/network-policy=isolation`. Это снимает default-deny и возвращает прежние ограничения; выполнять только при аварийном откате, затем восстановить playbook. Playbook удаляет отозванные разрешения с меткой `soloapp.io/network-policy=isolation`; чужие service-owned policy не удаляются.
