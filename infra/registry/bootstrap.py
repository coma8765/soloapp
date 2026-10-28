#!/usr/bin/env python3
"""Operator-only provisioning. Private material goes directly into Lockbox."""

import datetime
import ipaddress
import json
import secrets
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "object-storage"))
from bootstrap import STATE, yc

NOW = datetime.datetime.now(datetime.timezone.utc)


def pem(key):
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()


def certificate(name, issuer=None, ip=None, client=False):
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer[1].subject if issuer else subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(NOW - datetime.timedelta(minutes=5))
        .not_valid_after(NOW + datetime.timedelta(days=90 if issuer else 3650))
        .add_extension(
            x509.BasicConstraints(ca=issuer is None, path_length=0 if issuer is None else None),
            critical=True,
        )
    )
    if issuer:
        builder = builder.add_extension(
            x509.ExtendedKeyUsage(
                [ExtendedKeyUsageOID.CLIENT_AUTH if client else ExtendedKeyUsageOID.SERVER_AUTH]
            ),
            critical=False,
        )
    if ip:
        builder = builder.add_extension(
            x509.SubjectAlternativeName(
                [
                    x509.IPAddress(ipaddress.ip_address(ip)),
                    x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
                    x509.DNSName("localhost"),
                ]
            ),
            critical=False,
        )
    cert = builder.sign(issuer[0] if issuer else key, hashes.SHA256())
    return key, cert


def certpem(pair):
    return pair[1].public_bytes(serialization.Encoding.PEM).decode()


def main():
    cloud = json.loads(STATE.read_text())
    if "registry-yc" in cloud["secrets"]:
        raise SystemExit("Already provisioned; refusing to replace live keys")
    server_ca, pull_ca, push_ca = [
        certificate("soloapp-registry-" + name) for name in ("server-ca", "pull-ca", "push-ca")
    ]

    def save(name, entries):
        payload = json.dumps(
            [
                {"key": key, "textValue": value if isinstance(value, str) else json.dumps(value)}
                for key, value in entries.items()
            ]
        )
        cloud["secrets"][name] = yc(
            "lockbox",
            "secret",
            "create",
            "--name",
            "soloapp-" + name,
            "--deletion-protection",
            "--payload",
            "-",
            payload=payload,
        )["id"]
        STATE.write_text(json.dumps(cloud, indent=2) + "\n")
        STATE.chmod(0o600)

    if "registry-ca" in cloud["secrets"]:
        values = {
            e["key"]: e.get("textValue", e.get("text_value"))
            for e in yc("lockbox", "payload", "get", cloud["secrets"]["registry-ca"])["entries"]
        }
        server_ca, pull_ca, push_ca = [
            (
                serialization.load_pem_private_key(values[n + ".key"].encode(), None),
                x509.load_pem_x509_certificate(values[n + ".crt"].encode()),
            )
            for n in ("server", "pull", "push")
        ]
    else:
        save(
            "registry-ca",
            {
                name + ".key": pem(pair[0])
                for name, pair in [("server", server_ca), ("pull", pull_ca), ("push", push_ca)]
            }
            | {
                name + ".crt": certpem(pair)
                for name, pair in [("server", server_ca), ("pull", pull_ca), ("push", push_ca)]
            },
        )
    for site, ip in [("yc", "10.77.26.11"), ("home", "10.77.26.12")]:
        server = certificate(site, server_ca, ip=ip)
        pull = certificate("k3s-" + site, pull_ca, client=True)
        push = certificate("cd-" + site, push_ca, client=True)
        files = {
            "server.crt": certpem(server),
            "server.key": pem(server[0]),
            "ca.crt": certpem(server_ca),
            "pull-ca.crt": certpem(pull_ca),
            "push-ca.crt": certpem(push_ca),
            "pull.crt": certpem(pull),
            "pull.key": pem(pull[0]),
            "push.crt": certpem(push),
            "push.key": pem(push[0]),
        }
        for mode, port in [("read", 5043), ("write", 5044)]:
            cfg = {
                "version": 0.1,
                "log": {"level": "warn"},
                "storage": {
                    "filesystem": {"rootdirectory": "/var/lib/registry"},
                    "redirect": {"disable": True},
                    "delete": {"enabled": False},
                    "maintenance": {
                        "readonly": {"enabled": mode == "read"},
                        "uploadpurging": {"enabled": False},
                    },
                },
                "http": {
                    "addr": ":" + str(port),
                    "relativeurls": True,
                    "secret": secrets.token_hex(32),
                    "tls": {
                        "certificate": "/tls/server.crt",
                        "key": "/tls/server.key",
                        "clientcas": ["/tls/" + ("pull" if mode == "read" else "push") + "-ca.crt"],
                        "minimumtls": "tls1.2",
                    },
                },
            }
            files[mode + ".json"] = cfg
        save("registry-" + site, files)
        yc(
            "lockbox",
            "secret",
            "add-access-binding",
            cloud["secrets"]["registry-" + site],
            "--role",
            "lockbox.payloadViewer",
            "--service-account-id",
            cloud["identities"]["node-" + site],
        )
    print("Registry secrets provisioned in Lockbox; certificates valid for 90 days")


if __name__ == "__main__":
    main()
