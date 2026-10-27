# Общая инфраструктура

Каждая функциональность владеет своими tasks/, templates/, files/, k8s/ и документацией. Точка входа: `ansible/site.yaml`; сборка и доставка образов: `build/build.yaml`. Сервисы владеют собственными deployment-файлами в `services/<name>/deploy`.

- network — WireGuard и firewall/metadata isolation.
- kubernetes — независимые k3s, namespace, применение манифестов.
- postgres — pg_auto_failover и certificate-only HBA.
- ingress — HAProxy и mTLS к площадкам.
- secrets — общий агент доставки Lockbox в RAM.
- certificates — внутренний issuer и ACME.
- ha — профиль переключения и аварийные интеграционные тесты.
- cloud — идентификаторы YC/Lockbox/NLB, без payload секретов.
- build — сборка отдельных образов и доставка в Docker/containerd.
- operations — вспомогательный SSH-инструмент диагностики.

Исторические `migrations/` исключены из публичной репозитории; они не являются текущим способом deploy.
