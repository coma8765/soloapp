# Independent RabbitMQ clusters

`deploy.yaml` maintains two stock RabbitMQ nodes on each existing application host.
Each DC has its own cookie, password, cluster and two-member quorum queue. There is
no inter-DC RabbitMQ cluster or automatic queue mirroring. Both nodes currently
share one physical host; this does not provide local host redundancy.

A local queue needs both members. Losing either local node can stop that queue.
Delivery continues through the other DC because PostgreSQL stores every accepted
task before publication. Each site's client-notify reconciler republishes overdue,
unfinished tasks to its own queue. Shared database leases fence concurrent consumers.
With a 30-second lease and one-second reconciliation, a task held by a dead worker
becomes eligible after lease expiry; PG failover, connection recovery and load add time.

TLS AMQP listeners bind only WireGuard addresses (5671/5673); distribution and EPMD
bind loopback. Queue messages contain task IDs, not user payloads. Broker persistence
is `/var/lib/soloapp-rabbitmq/{1,2}`. Passwords/cookies come from scoped Lockbox secrets
into RAM. Node certificates are refreshed by the existing certificate issuer.

Run from the repository root:

```sh
python3 infra/chat-storage/bootstrap.py
ansible-playbook infra/rabbitmq/deploy.yaml
ansible-playbook infra/chat-storage/deploy.yaml
ansible-playbook infra/network/isolate.yaml
```

Bootstrap requires the operator's existing YC identity, PyYAML and cryptography.
It creates only delivery-stack identities/secrets and per-secret access bindings.
It does not print or persist secret payloads locally.

## Fair retries

RabbitMQ 4.4 native quorum delayed retry is enabled for all returns with a fixed
`retry_delay_ms` (default 1000 ms). Returned messages wait off the ready queue,
so an offline recipient does not repeatedly occupy its head. No dead-letter drop
or finite retry limit is used. `ansible-playbook infra/rabbitmq/policy.yaml` applies
the policy live without restarting either broker; `deploy.yaml` preserves it on
future starts. See [RabbitMQ delayed retry](https://www.rabbitmq.com/docs/quorum-queues#delayed-retry).
