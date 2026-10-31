#!/usr/bin/env python3
"""Keep local bootstrap credentials in macOS Keychain; stream to Kubernetes."""

import base64
import datetime as dt
import hashlib
import hmac
import ipaddress
import json
import secrets
import shlex
import subprocess
from pathlib import Path

import yaml
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

ROOT = Path(__file__).resolve().parent
CONFIG = yaml.safe_load((ROOT / "config.yaml").read_text())
CONTEXT = "colima-" + CONFIG["profile"]
ACCOUNT = "soloapp-local-bootstrap"
SERVICE = "soloapp.local.infrastructure"


def run(*args, data=None):
    return subprocess.run(args, input=data, capture_output=True, check=True, cwd="/tmp").stdout


def bundle():
    p = subprocess.run(
        ["security", "find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"],
        capture_output=True,
    )
    if p.returncode == 0:
        return json.loads(base64.b64decode(p.stdout.strip()))
    if p.returncode != 44:
        raise RuntimeError("Cannot access Keychain; refusing to overwrite credentials")
    key = ec.generate_private_key(ec.SECP256R1())
    now = dt.datetime.now(dt.timezone.utc)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Soloapp Local CA")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), True)
        .add_extension(
            x509.KeyUsage(False, False, False, False, False, True, True, None, None), True
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), False)
        .sign(key, hashes.SHA256())
    )
    value = {
        k: secrets.token_hex(32)
        for k in ["postgres", "rabbitmq", "s3_secret", "hmac", "notify", "gateway"]
    }
    value["s3_access"] = secrets.token_hex(16)
    value["ca_key"] = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    value["ca_cert"] = cert.public_bytes(serialization.Encoding.PEM).decode()
    encoded = base64.b64encode(json.dumps(value).encode()).decode()
    command = (
        " ".join(
            shlex.quote(s)
            for s in ["add-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w", encoded]
        )
        + "\n"
    )
    run("security", "-i", data=command.encode())
    # Confirm persistence before deploying anything dependent on it.
    stored = run("security", "find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w")
    if stored.strip() != encoded.encode():
        raise RuntimeError("Keychain verification failed")
    return value


def web_reader(value):
    return {
        "bucket": "soloapp-web",
        "access_key": hmac.new(
            bytes.fromhex(value["s3_secret"]), b"web-reader-access", hashlib.sha256
        ).hexdigest()[:32],
        "secret_key": hmac.new(
            bytes.fromhex(value["s3_secret"]), b"web-reader-secret", hashlib.sha256
        ).hexdigest(),
        "endpoints": ["http://seaweedfs:8333"],
    }


def storage_credentials(value):
    reader = web_reader(value)
    apply_secret(
        "s3-admin",
        {
            "s3.json": json.dumps(
                {
                    "identities": [
                        {
                            "name": "local-admin",
                            "credentials": [
                                {"accessKey": value["s3_access"], "secretKey": value["s3_secret"]}
                            ],
                            "actions": ["Admin", "Read", "Write", "List", "Tagging"],
                        },
                        {
                            "name": "web-reader",
                            "credentials": [
                                {
                                    "accessKey": reader["access_key"],
                                    "secretKey": reader["secret_key"],
                                }
                            ],
                            "actions": ["Read:soloapp-web"],
                        },
                    ]
                }
            )
        },
    )
    apply_secret("web-local", {"reader.json": json.dumps(reader)})


def issue(value, name, dns=(), ips=(), client=False):
    ca = x509.load_pem_x509_certificate(value["ca_cert"].encode())
    key = ec.generate_private_key(ec.SECP256R1())
    now = dt.datetime.now(dt.timezone.utc)
    builder = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)]))
        .issuer_name(ca.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), True)
        .add_extension(
            x509.KeyUsage(True, False, False, False, False, False, False, None, None), True
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca.public_key()), False)
        .add_extension(
            x509.ExtendedKeyUsage(
                [ExtendedKeyUsageOID.CLIENT_AUTH if client else ExtendedKeyUsageOID.SERVER_AUTH]
            ),
            False,
        )
    )
    names = [x509.DNSName(d) for d in dns] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
    if names:
        builder = builder.add_extension(x509.SubjectAlternativeName(names), False)
    cert = builder.sign(
        serialization.load_pem_private_key(value["ca_key"].encode(), None), hashes.SHA256()
    )
    return {
        "ca.crt": value["ca_cert"],
        "tls.crt": cert.public_bytes(serialization.Encoding.PEM).decode(),
        "tls.key": key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode(),
    }


def apply_secret(name, entries):
    data = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": name, "namespace": CONFIG["namespace"]},
        "type": "Opaque",
        "data": {k: base64.b64encode(v.encode()).decode() for k, v in entries.items()},
    }
    # No last-applied annotation containing another copy of secret material.
    run(
        "kubectl",
        "--context",
        CONTEXT,
        "apply",
        "--server-side",
        "--field-manager=soloapp-local",
        "-f",
        "-",
        data=json.dumps(data).encode(),
    )


if __name__ == "__main__":
    server = run(
        "kubectl",
        "--context",
        CONTEXT,
        "config",
        "view",
        "--minify",
        "-o",
        "jsonpath={.clusters[0].cluster.server}",
    ).decode()
    status = run(
        "colima",
        "ssh",
        "--profile",
        CONFIG["profile"],
        "--",
        "sudo",
        "k3s",
        "secrets-encrypt",
        "status",
        "--server",
        server,
    ).decode()
    if "Enabled" not in status:
        raise SystemExit("Enable k3s secrets encryption before deploying credentials")
    value = bundle()
    run(
        "kubectl",
        "--context",
        CONTEXT,
        "apply",
        "-f",
        "-",
        data=yaml.safe_dump(
            {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": CONFIG["namespace"]}}
        ).encode(),
    )
    apply_secret("postgres-admin", {"password": value["postgres"]})
    apply_secret("rabbitmq-admin", {"password": value["rabbitmq"]})
    storage_credentials(value)
    apply_secret(
        "lan-tls",
        issue(value, "soloapp-local", ips=[CONFIG["lan"]["ip"], "127.0.0.1"], dns=["localhost"]),
    )
    apply_secret(
        "postgres-tls",
        issue(value, "postgres", dns=["postgres", "postgres.soloapp.svc.cluster.local"]),
    )
    apply_secret(
        "rabbitmq-tls",
        issue(value, "rabbitmq", dns=["rabbitmq", "rabbitmq.soloapp.svc.cluster.local"]),
    )
    output = ROOT.parent.parent / "outputs" / "soloapp-local-ca.crt"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(value["ca_cert"])
    print(
        "Local credentials stored in Keychain and encrypted Kubernetes Secrets; public CA:", output
    )
