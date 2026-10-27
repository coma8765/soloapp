# Переключение

Профиль по умолчанию — 15 секунд, допустимые значения 15..300. Это целевой RTO, требующий проверки для реальной нагрузки.

```sh
python3 infra/ha/profile.py --target-seconds 15
ansible-playbook infra/ha/failover.yaml -e failover_target_seconds=15 --check
ansible-playbook infra/ha/failover.yaml -e failover_target_seconds=15
python3 infra/ha/tests/e2e_failover.py --target-seconds 15
```

Playbook сначала увеличивает защитное ожидание monitor при необходимости, затем применяет WAL/keeper timeout на обеих нодах, проверяет их и только после этого устанавливает окончательное ожидание monitor. HAProxy и NLB получают согласованный профиль. Ошибка настройки keeper останавливает изменение guard.

Тесты в tests/ — живые аварийные проверки, не unit tests. Они временно изолируют проектный WireGuard и восстанавливают правила в finally и независимым systemd timer. Тесты сервисов находятся в services/*/tests и используют отдельную БД.
