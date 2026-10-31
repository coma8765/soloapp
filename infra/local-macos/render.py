#!/usr/bin/env python3
"""Render non-secret manifests for the independent local infrastructure."""

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent
CONFIG = yaml.safe_load((ROOT / "config.yaml").read_text())
NS = CONFIG["namespace"]


def obj(kind, name, **fields):
    return {"apiVersion": "v1", "kind": kind, "metadata": {"name": name, "namespace": NS}, **fields}


def workload(
    name, image, ports, *, args=None, env=None, mounts=None, volumes=None, persistent=None
):
    container = {
        "name": name,
        "image": image,
        "imagePullPolicy": "IfNotPresent",
        "ports": [{"name": k, "containerPort": v} for k, v in ports.items()],
        "resources": {
            "requests": {"cpu": "100m", "memory": "128Mi"},
            "limits": {"cpu": "2", "memory": "1Gi"},
        },
    }
    if args:
        container["args"] = args
    if env:
        container["env"] = env
    if mounts:
        container["volumeMounts"] = mounts
    first = next(iter(ports.values()))
    container["readinessProbe"] = {"tcpSocket": {"port": first}, "periodSeconds": 5}
    container["startupProbe"] = {
        "tcpSocket": {"port": first},
        "periodSeconds": 5,
        "failureThreshold": 60,
    }
    spec = {"automountServiceAccountToken": False, "containers": [container]}
    if volumes:
        spec["volumes"] = volumes
    result = obj(
        "StatefulSet" if persistent else "Deployment",
        name,
        spec={
            "replicas": 1,
            "selector": {"matchLabels": {"app": name}},
            "template": {"metadata": {"labels": {"app": name}}, "spec": spec},
        },
    )
    result["apiVersion"] = "apps/v1"
    if persistent:
        result["spec"]["serviceName"] = name
        result["spec"]["volumeClaimTemplates"] = [
            {
                "metadata": {"name": "data"},
                "spec": {
                    "accessModes": ["ReadWriteOnce"],
                    "resources": {"requests": {"storage": persistent}},
                },
            }
        ]
    else:
        result["spec"]["strategy"] = {
            "type": "RollingUpdate",
            "rollingUpdate": {"maxUnavailable": 0, "maxSurge": 1},
        }
    service = obj(
        "Service",
        name,
        spec={
            "selector": {"app": name},
            "ports": [{"name": k, "port": v, "targetPort": v} for k, v in ports.items()],
        },
    )
    return [service, result]


def manifests():
    docs = [
        {
            "apiVersion": "v1",
            "kind": "Namespace",
            "metadata": {"name": NS, "labels": {"soloapp.io/environment": "local-macos"}},
        }
    ]
    docs += workload(
        "postgres",
        CONFIG["images"]["postgres"],
        {"postgres": 5432},
        args=[
            "-c",
            "ssl=on",
            "-c",
            "ssl_cert_file=/run/tls/tls.crt",
            "-c",
            "ssl_key_file=/run/tls/tls.key",
            "-c",
            "ssl_ca_file=/run/tls/ca.crt",
            "-c",
            "hba_file=/run/config/pg_hba.conf",
        ],
        env=[
            {"name": "POSTGRES_PASSWORD_FILE", "value": "/run/credentials/password"},
            {"name": "PGDATA", "value": "/var/lib/postgresql/data/pgdata"},
        ],
        mounts=[
            {"name": "data", "mountPath": "/var/lib/postgresql/data"},
            {"name": "credentials", "mountPath": "/run/credentials", "readOnly": True},
            {"name": "tls", "mountPath": "/run/tls", "readOnly": True},
            {"name": "config", "mountPath": "/run/config", "readOnly": True},
        ],
        volumes=[
            {"name": "credentials", "secret": {"secretName": "postgres-admin"}},
            {"name": "tls", "secret": {"secretName": "postgres-tls", "defaultMode": 288}},
            {"name": "config", "configMap": {"name": "postgres-config"}},
        ],
        persistent="12Gi",
    )
    docs += workload(
        "rabbitmq",
        CONFIG["images"]["rabbitmq"],
        {"amqps": 5671},
        env=[
            {"name": "RABBITMQ_DEFAULT_USER", "value": "soloapp"},
            {
                "name": "RABBITMQ_DEFAULT_PASS",
                "valueFrom": {"secretKeyRef": {"name": "rabbitmq-admin", "key": "password"}},
            },
        ],
        mounts=[
            {"name": "data", "mountPath": "/var/lib/rabbitmq"},
            {
                "name": "config",
                "mountPath": "/etc/rabbitmq/rabbitmq.conf",
                "subPath": "rabbitmq.conf",
                "readOnly": True,
            },
            {"name": "tls", "mountPath": "/run/tls", "readOnly": True},
        ],
        volumes=[
            {"name": "config", "configMap": {"name": "rabbitmq-config"}},
            {"name": "tls", "secret": {"secretName": "rabbitmq-tls", "defaultMode": 288}},
        ],
        persistent="4Gi",
    )
    docs += workload(
        "seaweedfs",
        CONFIG["images"]["seaweedfs"],
        {
            "s3": 8333,
            "filer": 8888,
            "master": 9333,
            "master-grpc": 19333,
            "volume": 8080,
            "volume-grpc": 18080,
            "filer-grpc": 18888,
        },
        args=[
            "server",
            "-dir=/data",
            "-ip=seaweedfs",
            "-ip.bind=0.0.0.0",
            "-filer",
            "-s3",
            "-s3.config=/run/credentials/s3.json",
            "-volume.max=12",
            "-master.volumeSizeLimitMB=1024",
        ],
        mounts=[
            {"name": "data", "mountPath": "/data"},
            {"name": "credentials", "mountPath": "/run/credentials", "readOnly": True},
        ],
        volumes=[{"name": "credentials", "secret": {"secretName": "s3-admin"}}],
        persistent="12Gi",
    )
    docs.append(
        obj(
            "ConfigMap",
            "postgres-config",
            data={
                "pg_hba.conf": "local all all trust\nhostssl all all 0.0.0.0/0 scram-sha-256 clientcert=verify-ca\n"
            },
        )
    )
    docs.append(
        obj(
            "ConfigMap",
            "rabbitmq-config",
            data={
                "rabbitmq.conf": "listeners.tcp = none\nlisteners.ssl.default = 5671\nssl_options.cacertfile = /run/tls/ca.crt\nssl_options.certfile = /run/tls/tls.crt\nssl_options.keyfile = /run/tls/tls.key\nssl_options.verify = verify_peer\nssl_options.fail_if_no_peer_cert = false\nconsumer_timeout = 30000\n"
            },
        )
    )
    for doc in docs:
        if doc["kind"] == "Service" and doc["metadata"]["name"] == "seaweedfs":
            doc["spec"]["publishNotReadyAddresses"] = True
        if doc["kind"] == "StatefulSet" and doc["metadata"]["name"] in ["postgres", "rabbitmq"]:
            doc["spec"]["template"]["spec"]["securityContext"] = {"fsGroup": 999}
    # Default-deny. Only explicitly named application peers can reach storage.
    docs.append(
        {
            "apiVersion": "networking.k8s.io/v1",
            "kind": "NetworkPolicy",
            "metadata": {"name": "default-deny", "namespace": NS},
            "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]},
        }
    )
    docs.append(
        {
            "apiVersion": "networking.k8s.io/v1",
            "kind": "NetworkPolicy",
            "metadata": {"name": "dns", "namespace": NS},
            "spec": {
                "podSelector": {},
                "policyTypes": ["Egress"],
                "egress": [
                    {
                        "to": [
                            {
                                "namespaceSelector": {
                                    "matchLabels": {"kubernetes.io/metadata.name": "kube-system"}
                                },
                                "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}},
                            }
                        ],
                        "ports": [{"protocol": p, "port": 53} for p in ["UDP", "TCP"]],
                    }
                ],
            },
        }
    )
    for name, peers, ports in [
        ("postgres", ["auth", "whoami", "client-gateway", "client-notify", "keycloak"], [5432]),
        ("rabbitmq", ["client-notify"], [5671]),
        (
            "seaweedfs",
            ["web", "registry", "seaweedfs"],
            [8333, 8888, 9333, 19333, 8080, 18080, 18888],
        ),
    ]:
        selector = {"matchExpressions": [{"key": "app", "operator": "In", "values": peers}]}
        docs.append(
            {
                "apiVersion": "networking.k8s.io/v1",
                "kind": "NetworkPolicy",
                "metadata": {"name": name + "-ingress", "namespace": NS},
                "spec": {
                    "podSelector": {"matchLabels": {"app": name}},
                    "policyTypes": ["Ingress"],
                    "ingress": [
                        {"from": [{"podSelector": selector}], "ports": [{"port": p} for p in ports]}
                    ],
                },
            }
        )
        docs.append(
            {
                "apiVersion": "networking.k8s.io/v1",
                "kind": "NetworkPolicy",
                "metadata": {"name": name + "-egress", "namespace": NS},
                "spec": {
                    "podSelector": selector,
                    "policyTypes": ["Egress"],
                    "egress": [
                        {
                            "to": [{"podSelector": {"matchLabels": {"app": name}}}],
                            "ports": [{"port": p} for p in ports],
                        }
                    ],
                },
            }
        )
    return docs


if __name__ == "__main__":
    print(yaml.safe_dump_all(manifests(), sort_keys=False))
