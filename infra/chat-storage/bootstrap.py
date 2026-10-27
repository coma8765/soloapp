#!/usr/bin/env python3
"""Provision only this delivery stack's Lockbox secrets and workload identities."""

import datetime
import json
import secrets
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infra/object-storage"))
from bootstrap import STATE, yc


def main():
    state = json.loads(STATE.read_text())

    def save():
        STATE.write_text(json.dumps(state, indent=2) + "\n")
        STATE.chmod(0o600)

    def values(name):
        return {
            e["key"]: e.get("textValue", e.get("text_value"))
            for e in yc("lockbox", "payload", "get", state["secrets"][name])["entries"]
        }

    def payload(data):
        return json.dumps([{"key": k, "textValue": v} for k, v in data.items()])

    def ensure_secret(name, data):
        if name not in state["secrets"]:
            state["secrets"][name] = yc(
                "lockbox",
                "secret",
                "create",
                "--name",
                "soloapp-" + name,
                "--deletion-protection",
                "--payload",
                "-",
                payload=payload(data),
            )["id"]
            save()
        return state["secrets"][name]

    def update(name, data):
        if values(name) != data:
            yc(
                "lockbox",
                "secret",
                "add-version",
                state["secrets"][name],
                "--payload",
                "-",
                payload=payload(data),
            )

    def grant(name, account, role="lockbox.payloadViewer"):
        yc(
            "lockbox",
            "secret",
            "add-access-binding",
            state["secrets"][name],
            "--role",
            role,
            "--service-account-id",
            state["identities"][account],
        )

    def identity(name, subject, site):
        if name not in state["identities"]:
            state["identities"][name] = yc(
                "iam", "service-account", "create", "--name", "soloapp-" + name
            )["id"]
            save()
        flag = "binding-" + name
        if not state.get(flag):
            yc(
                "iam",
                "workload-identity",
                "federated-credential",
                "create",
                "--service-account-id",
                state["identities"][name],
                "--federation-id",
                state["federations"][site],
                "--external-subject-id",
                "system:serviceaccount:soloapp:" + subject,
            )
            state[flag] = True
            save()

    ensure_secret(
        "delivery-control",
        {"notify_api": secrets.token_hex(32), "gateway_token": secrets.token_hex(32)},
    )
    control = values("delivery-control")
    ca_values = values("ca")
    ca = x509.load_pem_x509_certificate(ca_values["ca.crt"].encode())
    ca_key = serialization.load_pem_private_key(ca_values["ca.key"].encode(), None)
    state.setdefault("extra_certificates", [])

    def certificate(name, cn, dns):
        if name not in state["secrets"]:
            key = ec.generate_private_key(ec.SECP256R1())
            now = datetime.datetime.now(datetime.timezone.utc)
            cert = (
                x509.CertificateBuilder()
                .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)]))
                .issuer_name(ca.subject)
                .public_key(key.public_key())
                .serial_number(x509.random_serial_number())
                .not_valid_before(now - datetime.timedelta(minutes=5))
                .not_valid_after(now + datetime.timedelta(days=30))
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), True)
                .add_extension(
                    x509.ExtendedKeyUsage(
                        [ExtendedKeyUsageOID.CLIENT_AUTH, ExtendedKeyUsageOID.SERVER_AUTH]
                    ),
                    False,
                )
                .add_extension(
                    x509.SubjectAlternativeName([x509.DNSName(n) for n in [cn, *dns]]), False
                )
                .sign(ca_key, hashes.SHA256())
            )
            ensure_secret(
                name,
                {
                    "ca.crt": ca_values["ca.crt"],
                    "tls.crt": cert.public_bytes(serialization.Encoding.PEM).decode(),
                    "tls.key": key.private_bytes(
                        serialization.Encoding.PEM,
                        serialization.PrivateFormat.PKCS8,
                        serialization.NoEncryption(),
                    ).decode(),
                },
            )
        entry = {"cn": cn, "secret": state["secrets"][name], "dns": dns, "ip": None}
        if entry not in state["extra_certificates"]:
            state["extra_certificates"].append(entry)
            save()
        grant(name, "cert-issuer", "lockbox.editor")

    directory = "/run/soloapp-secrets/data/"
    hosts = ["10.77.26.11", "10.77.26.12"]
    for site, ip in zip(("yc", "home"), hosts, strict=True):
        broker = "rabbitmq-" + site
        ensure_secret(
            broker,
            {
                "credentials.json": json.dumps(
                    {"cookie": secrets.token_hex(32), "password": secrets.token_hex(32)}
                )
            },
        )
        grant(broker, "node-" + site)
        broker_credentials = json.loads(values(broker)["credentials.json"])
        for service, role in (
            ("chat-api", "chat_api"),
            ("client-gateway", "gateway"),
            ("client-notify", "notify"),
        ):
            cert_name = service + "-tls-" + site
            certificate(
                cert_name,
                role + "_" + site,
                ["client-gateway.soloapp.svc.cluster.local"] if service == "client-gateway" else [],
            )
            name = ("whoami-" if service == "chat-api" else service + "-") + site
            if service != "chat-api":
                identity(name, service + "-secrets", site)
            grant(cert_name, name)
            database = {
                "hosts": hosts,
                "port": 55432,
                "name": "chatdb",
                "user": role + "_" + site,
                "ca_file": directory + "ca.crt",
                "cert_file": directory + "tls.crt",
                "key_file": directory + "tls.key",
                "pool_max": 4,
            }
            if service == "client-notify":
                dsn = (
                    f"host={','.join(hosts)} port=55432 dbname=chatdb user={role}_{site} sslmode=verify-full "
                    f"sslrootcert={directory}ca.crt sslcert={directory}tls.crt sslkey={directory}tls.key "
                    "target_session_attrs=read-write connect_timeout=2 options='-c statement_timeout=4000 -c lock_timeout=2000'"
                )
                config = {
                    "rabbitmq": {
                        "host": ip,
                        "port": 5671,
                        "tls": True,
                        "user": "notify",
                        "password": broker_credentials["password"],
                        "ca_file": directory + "ca.crt",
                        "queue": "client-notify",
                    },
                    "gateway": {
                        "url": "https://client-gateway.soloapp.svc.cluster.local:8443",
                        "token": control["gateway_token"],
                        "ca_file": directory + "ca.crt",
                        "cert_file": directory + "tls.crt",
                        "key_file": directory + "tls.key",
                    },
                    "delivery_timeout_ms": 10000,
                    "ack_timeout_ms": 30000,
                    "retry_delay_ms": 1000,
                }
                data = {
                    "database-url": dsn,
                    "api-token": control["notify_api"],
                    "notify-config.json": json.dumps(config),
                }
            else:
                config = {"database": database}
                if service == "chat-api":
                    config["notify"] = {
                        "url": "http://client-notify.soloapp.svc.cluster.local:8080",
                        "token": control["notify_api"],
                    }
                    data = values(name)
                else:
                    config["gateway"] = {
                        "token": control["gateway_token"],
                        "ca_file": directory + "ca.crt",
                        "cert_file": directory + "tls.crt",
                        "key_file": directory + "tls.key",
                    }
                    data = {}
                data["chat-client.json"] = json.dumps(config)
            ensure_secret(name, data)
            update(name, data)
            grant(name, name)
    print(
        "Delivery credentials stored in Lockbox; scoped identities and certificate rotation grants configured"
    )


if __name__ == "__main__":
    main()
