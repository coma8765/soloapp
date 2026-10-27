#!/usr/bin/env python3
import datetime
import ipaddress
import json
import os
import time
from importlib.machinery import SourceFileLoader

fetch = SourceFileLoader("secret_fetch", "/usr/local/bin/secret-fetch.py").load_module()
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

cfg = json.loads(os.environ["ISSUER_CONFIG"])
token = fetch.iam()
headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
r = fetch.request(
    "https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/" + cfg["ca"] + "/payload",
    headers=headers,
)
d = {v["key"]: v["textValue"] for v in r["entries"]}
ca = x509.load_pem_x509_certificate(d["ca.crt"].encode())
cakey = serialization.load_pem_private_key(d["ca.key"].encode(), None)
for item in cfg["certificates"]:
    base = "https://lockbox.api.cloud.yandex.net/lockbox/v1/secrets/" + item["secret"]
    metadata = fetch.request(base, headers=headers)
    created = datetime.datetime.fromisoformat(
        metadata["currentVersion"]["createdAt"].replace("Z", "+00:00")
    )
    if not os.environ.get("FORCE_ROTATE") and datetime.datetime.now(
        datetime.timezone.utc
    ) - created < datetime.timedelta(days=7):
        continue
    k = ec.generate_private_key(ec.SECP256R1())
    now = datetime.datetime.now(datetime.timezone.utc)
    cn = item["cn"]
    b = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)]))
        .issuer_name(ca.subject)
        .public_key(k.public_key())
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
    )
    names = [x509.DNSName(cn)] + [x509.DNSName(name) for name in item.get("dns", [])]
    if item.get("ip"):
        names += [
            x509.IPAddress(ipaddress.ip_address(item["ip"])),
            x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
        ]
    b = b.add_extension(x509.SubjectAlternativeName(names), False)
    cert = b.sign(cakey, hashes.SHA256())
    values = {
        "tls.crt": cert.public_bytes(serialization.Encoding.PEM).decode(),
        "tls.key": k.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode(),
        "ca.crt": d["ca.crt"],
    }
    body = {
        "baseVersionId": metadata["currentVersion"]["id"],
        "description": "Automated 30-day mTLS certificate",
        "payloadEntries": [{"key": a, "textValue": b} for a, b in values.items()],
    }
    op = fetch.request(base + ":addVersion", json.dumps(body).encode(), headers)
    while not op.get("done"):
        time.sleep(1)
        op = fetch.request(
            "https://operation.api.cloud.yandex.net/operations/" + op["id"], headers=headers
        )
    if op.get("error"):
        raise RuntimeError("Certificate version could not be stored")
    print("Rotated " + cn, flush=True)
print("Certificate rotation check complete")
