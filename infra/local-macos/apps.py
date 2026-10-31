#!/usr/bin/env python3
"""Bootstrap isolated app databases and render local app workloads."""

import hashlib
import hmac
import json
import sys

import jinja2
import yaml
from credentials import CONTEXT, apply_secret, bundle, issue, run
from render import CONFIG, NS, ROOT, obj, workload

PROJECT = ROOT.parent.parent
BASE = "/run/credentials/"


def password(value, role):
    return hmac.new(
        bytes.fromhex(value["postgres"]), ("database-role:" + role).encode(), hashlib.sha256
    ).hexdigest()


def sql(database, text):
    run(
        "kubectl",
        "--context",
        CONTEXT,
        "-n",
        NS,
        "exec",
        "-i",
        "postgres-0",
        "--",
        "psql",
        "-U",
        "postgres",
        "-d",
        database,
        "-v",
        "ON_ERROR_STOP=1",
        data=text.encode(),
    )


def bootstrap():
    value = bundle()
    for db in ["authdb", "chatdb"]:
        sql(
            "postgres",
            "SELECT 'CREATE DATABASE "
            + db
            + "' WHERE NOT EXISTS(SELECT FROM pg_database WHERE datname='"
            + db
            + "')\\gexec\n",
        )
    roles = ["auth_app", "chat_api_local", "gateway_local", "notify_local"]
    for role in roles:
        sql(
            "postgres",
            f"DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='{role}') THEN CREATE ROLE {role} LOGIN; END IF; END $$; ALTER ROLE {role} PASSWORD '{password(value, role)}';",
        )
    sql("chatdb", (PROJECT / "services/soloapp_app/deploy/schema.sql").read_text())
    sql("authdb", (PROJECT / "services/auth/deploy/schema.sql").read_text())
    sql("chatdb", (PROJECT / "services/client-notify/deploy/schema.sql").read_text())
    sql("chatdb", (PROJECT / "infra/chat-storage/schema.sql").read_text())
    sql(
        "chatdb",
        (PROJECT / "infra/chat-storage/grants.sql")
        .read_text()
        .replace("ARRAY['yc','home']", "ARRAY['local']"),
    )
    for app, role, db in [
        ("auth", "auth_app", "authdb"),
        ("whoami", "chat_api_local", "chatdb"),
        ("client-gateway", "gateway_local", "chatdb"),
        ("client-notify", "notify_local", "chatdb"),
    ]:
        entries = issue(value, role, client=True)
        if app == "client-gateway":
            server = issue(
                value,
                "client-gateway",
                dns=["client-gateway", "client-gateway.soloapp.svc.cluster.local"],
            )
            entries.update({"server.crt": server["tls.crt"], "server.key": server["tls.key"]})
        conn = f"host=postgres dbname={db} user={role} password={password(value, role)} sslmode=verify-full sslrootcert={BASE}ca.crt sslcert={BASE}tls.crt sslkey={BASE}tls.key"
        entries["database-url"] = conn
        entries["userid-hmac"] = value["hmac"]
        entries["api-token"] = value["notify"]
        config = {
            "database": {
                "hosts": ["postgres"],
                "port": 5432,
                "name": db,
                "user": role,
                "password": password(value, role),
                "ca_file": BASE + "ca.crt",
                "cert_file": BASE + "tls.crt",
                "key_file": BASE + "tls.key",
            },
            "notify": {"url": "http://client-notify:8080", "token": value["notify"]},
            "gateway": {
                "url": "https://client-gateway:8443",
                "token": value["gateway"],
                "ca_file": BASE + "ca.crt",
                "cert_file": BASE + ("server.crt" if app == "client-gateway" else "tls.crt"),
                "key_file": BASE + ("server.key" if app == "client-gateway" else "tls.key"),
            },
            "rabbitmq": {
                "host": "rabbitmq",
                "port": 5671,
                "tls": True,
                "user": "soloapp",
                "password": value["rabbitmq"],
                "ca_file": BASE + "ca.crt",
                "queue": "client-notify",
            },
            "delivery_timeout_ms": 10000,
            "ack_timeout_ms": 30000,
            "retry_delay_ms": 1000,
        }
        if app == "auth":
            entries.pop("api-token", None)
        elif app == "whoami":
            entries.pop("api-token", None)
            config = {k: config[k] for k in ["database", "notify"]}
            entries["chat-client.json"] = json.dumps(config)
        elif app == "client-gateway":
            entries.pop("api-token", None)
            entries.pop("userid-hmac", None)
            config = {k: config[k] for k in ["database", "gateway"]}
            entries["chat-client.json"] = json.dumps(config)
        else:
            entries.pop("userid-hmac", None)
            config.pop("database", None)
            config.pop("notify", None)
            entries["notify-config.json"] = json.dumps(config)
        apply_secret(app + "-local", entries)


def manifests():
    docs = list(
        yaml.safe_load_all(
            jinja2.Template(
                (PROJECT / "services/whisper/deploy/k8s/deployment.yaml.j2").read_text()
            ).render(whisper_image="soloapp-local/whisper:dev")
        )
    )
    ports = {"auth": 19082, "whoami": 8080, "client-gateway": 8080, "client-notify": 8080}
    images = {"whoami": "soloapp_app"}
    for app, port in ports.items():
        env = {
            "PORT": str(port),
            "LISTEN_ADDRESS": "0.0.0.0",
            "DATABASE_URL_FILE": BASE + "database-url",
            "HMAC_KEY_FILE": BASE + "userid-hmac",
            "CHAT_CONFIG_FILE": BASE + "chat-client.json",
            "NOTIFY_CONFIG_FILE": BASE + "notify-config.json",
            "NOTIFY_API_TOKEN_FILE": BASE + "api-token",
            "CHAT_ALLOWED_ORIGIN": f"https://{CONFIG['lan']['ip']}"
            + ("" if CONFIG["lan"]["https_port"] == 443 else f":{CONFIG['lan']['https_port']}"),
            "INTERNAL_PORT": "8443",
        }
        app_ports = {"http": port}
        if app == "client-gateway":
            app_ports["internal"] = 8443
        items = workload(
            app,
            "soloapp-local/" + images.get(app, app) + ":dev",
            app_ports,
            env=[{"name": k, "value": v} for k, v in env.items()],
            mounts=[
                {"name": "credentials", "mountPath": "/run/credentials", "readOnly": True},
                {"name": "tmp", "mountPath": "/tmp"},
                {"name": "uploads", "mountPath": "/uploads"},
            ],
            volumes=[
                {
                    "name": "credentials",
                    "secret": {"secretName": app + "-local", "defaultMode": 288},
                },
                {"name": "tmp", "emptyDir": {"medium": "Memory", "sizeLimit": "32Mi"}},
                {"name": "uploads", "emptyDir": {"medium": "Memory", "sizeLimit": "8Mi"}},
            ],
        )
        pod = items[1]["spec"]["template"]["spec"]
        items[1]["spec"]["replicas"] = 2
        pod["securityContext"] = {
            "runAsUser": 10001,
            "runAsGroup": 10001,
            "fsGroup": 10001,
            "runAsNonRoot": True,
        }
        c = pod["containers"][0]
        c["imagePullPolicy"] = "Never"
        c["securityContext"] = {
            "readOnlyRootFilesystem": True,
            "allowPrivilegeEscalation": False,
            "capabilities": {"drop": ["ALL"]},
        }
        c["readinessProbe"] = {
            "httpGet": {"path": "/health/ready", "port": port},
            "periodSeconds": 5,
            "timeoutSeconds": 3,
        }
        c["livenessProbe"] = {
            "httpGet": {"path": "/healthz", "port": port},
            "periodSeconds": 10,
            "timeoutSeconds": 3,
        }
        docs += items
    web_release = CONFIG.get("web_release")
    if web_release:
        docs += workload(
            "web",
            "soloapp-local/web-origin:dev",
            {"http": 8080},
            env=[{"name": "WEB_RELEASE", "value": web_release}, {"name": "PORT", "value": "8080"}],
            mounts=[
                {"name": "reader", "mountPath": "/run/soloapp-secrets/data", "readOnly": True},
                {"name": "cache", "mountPath": "/cache"},
            ],
            volumes=[
                {"name": "reader", "secret": {"secretName": "web-local"}},
                {"name": "cache", "emptyDir": {"sizeLimit": "256Mi"}},
            ],
        )
        docs[-2]["spec"]["ports"][0]["port"] = 80
        docs[-1]["spec"]["template"]["spec"]["securityContext"] = {
            "runAsUser": 10001,
            "runAsGroup": 10001,
            "fsGroup": 10001,
            "runAsNonRoot": True,
        }
    else:
        docs += workload("web", "soloapp-local/web:dev", {"http": 80})
    values = {
        "auth_config": {"port": 19082},
        "whoami_config": {"port": 8080},
        "client_gateway_config": {"port": 8080},
    }
    routes = jinja2.Template(
        (PROJECT / "services/nginx/deploy/generated/routes.conf.j2").read_text()
    ).render(**values)
    maps = (PROJECT / "services/nginx/deploy/generated/maps.conf.j2").read_text()
    nginx = jinja2.Template((PROJECT / "services/nginx/deploy/local.conf.j2").read_text()).render(
        routes=routes, maps=maps
    )
    docs.append(obj("ConfigMap", "nginx-local", data={"nginx.conf": nginx}))
    docs += workload(
        "nginx",
        CONFIG["images"]["nginx"],
        {"https": 8443},
        mounts=[
            {
                "name": "config",
                "mountPath": "/etc/nginx/nginx.conf",
                "subPath": "nginx.conf",
                "readOnly": True,
            },
            {"name": "credentials", "mountPath": "/run/credentials", "readOnly": True},
        ],
        volumes=[
            {"name": "config", "configMap": {"name": "nginx-local"}},
            {"name": "credentials", "secret": {"secretName": "lan-tls"}},
        ],
    )
    for target, sources, port in [
        ("auth", ["nginx", "whoami"], 19082),
        ("whoami", ["nginx"], 8080),
        ("web", ["nginx"], 8080 if web_release else 80),
        ("client-gateway", ["nginx"], 8080),
        ("client-gateway", ["client-notify"], 8443),
        ("client-notify", ["whoami"], 8080),
    ]:
        name = target + "-" + str(port)
        docs += [
            {
                "apiVersion": "networking.k8s.io/v1",
                "kind": "NetworkPolicy",
                "metadata": {"name": name, "namespace": NS},
                "spec": {
                    "podSelector": {"matchLabels": {"app": target}},
                    "policyTypes": ["Ingress"],
                    "ingress": [
                        {
                            "from": [
                                {
                                    "podSelector": {
                                        "matchExpressions": [
                                            {"key": "app", "operator": "In", "values": sources}
                                        ]
                                    }
                                }
                            ],
                            "ports": [{"port": port}],
                        }
                    ],
                },
            },
            {
                "apiVersion": "networking.k8s.io/v1",
                "kind": "NetworkPolicy",
                "metadata": {"name": name + "-clients", "namespace": NS},
                "spec": {
                    "podSelector": {
                        "matchExpressions": [{"key": "app", "operator": "In", "values": sources}]
                    },
                    "policyTypes": ["Egress"],
                    "egress": [
                        {
                            "to": [{"podSelector": {"matchLabels": {"app": target}}}],
                            "ports": [{"port": port}],
                        }
                    ],
                },
            },
        ]
    # Port-forward tunnel terminates at kubelet; storage APIs are not exposed.
    return docs


if __name__ == "__main__":
    if sys.argv[1:] == ["bootstrap"]:
        bootstrap()
    else:
        print(yaml.safe_dump_all(manifests(), sort_keys=False))
