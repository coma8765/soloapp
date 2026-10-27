# Развёртывание сервисов

В каждом независимом кластере по три Deployment: `auth`, `nginx`, `whoami`. По умолчанию каждый содержит 2 пода. Контейнер загрузки секретов — sidecar соответствующего приложения, а не отдельный сетевой сервис.

Приоритет конфигурации: `infra/kubernetes/defaults.yaml` → `services/<service>/deploy/defaults.yaml` → `infra/ansible/host_vars/<yc|home>.yaml`. Словари объединяются рекурсивно: изменение replicas не сбрасывает image/resources. Площадка может переопределить `replicas`, `image`, `image_pull_policy`, `resources` и параметры rolling update. Образы загружаются в containerd обоих кластеров; для registry задайте подходящую pull policy и доступ к registry.

```yaml
# infra/ansible/host_vars/home.yaml
service_overrides:
  auth:
    replicas: 2
  nginx:
    replicas: 2
  whoami:
    replicas: 2
    resources:
      limits:
        memory: 128Mi
```

```sh
ansible-playbook infra/ansible/apps.yaml --check
ansible-playbook infra/ansible/apps.yaml
ansible-playbook infra/ansible/apps.yaml --limit home --tags whoami
```

Обновление последовательно по ДЦ, внутри ДЦ — whoami, auth, nginx. `maxUnavailable: 0`, `maxSurge: 1`, `minReadySeconds: 5`; во время обновления одного Deployment временно до трёх подов. На узле нужны свободные ресурсы для дополнительного пода. PDB допускает одну добровольную эвакуацию и не управляет RollingUpdate. PreStop удерживает обслуживающие контейнеры на время удаления endpoint и завершения запросов; nginx завершает workers gracefully. ConfigMap nginx именуется по хешу содержимого, поэтому предыдущий ReplicaSet сохраняет свою конфигурацию.

`auth` и `whoami` доступны через ClusterIP; вход nginx — NodePort 31980 только на приватном адресе с firewall до DNAT и обязательным клиентским сертификатом. NetworkPolicy допускает обращения к auth/whoami только из nginx. Внутренний HTTP внутри одноузлового кластера не шифруется; mTLS сохранён на входе ingress→nginx и при доступе к PostgreSQL. Все ключи в Lockbox; projected identity и tmpfs отдельные для каждого Deployment. Nginx не имеет DB/HMAC ключей.

`infra/ansible/site.yaml` обслуживает уже инициализированную инфраструктуру. Не создаёт новую БД/VM/IAM bootstrap. Для первоначального перехода со старой схемы использованы `infra/kubernetes/migrate-pod-network.yaml`, затем `infra/ingress/cutover.yaml`, затем `infra/kubernetes/retire-host-network.yaml`. Обычные обновления выполняются через apps.yaml. После изменения NodePort выполните network tasks до обновления Service, затем обновите ingress; для смены порта без паузы нужна отдельная staged migration.

Два пода на одном сервере защищают обновление/перезапуск процесса, но отказ сервера теряет всю площадку. Второй независимый ДЦ обеспечивает переживание этого отказа. Нулевая пауза проверяется на rolling update исправных сервисов, а failover PostgreSQL имеет отдельный целевой RTO 15 секунд.

Прикладные маршруты nginx генерируются из `services/{auth,whoami}/docs/api.yaml`. Перед раскаткой запускайте `make codegen`; Ansible проверяет актуальность и nginx -t. Формат параметров ручек: `libs/api_codegen/README.md`.
