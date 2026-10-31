"""Provision project-scoped Keycloak/OIDC secrets and workload identities in Lockbox."""

import json
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "infra" / "object-storage"))
from bootstrap import STATE, yc  # noqa: E402


def main():
    cloud = json.loads(STATE.read_text())

    def save():
        STATE.write_text(json.dumps(cloud, indent=2) + "\n")
        STATE.chmod(0o600)

    def values(name):
        return {
            e["key"]: e.get("textValue", e.get("text_value"))
            for e in yc("lockbox", "payload", "get", cloud["secrets"][name])["entries"]
        }

    def ensure(name, payload):
        if name not in cloud["secrets"]:
            cloud["secrets"][name] = yc(
                "lockbox",
                "secret",
                "create",
                "--name",
                "soloapp-" + name,
                "--folder-id",
                cloud["folder"],
                "--deletion-protection",
                "--payload",
                "-",
                payload=json.dumps([{"key": k, "textValue": v} for k, v in payload.items()]),
            )["id"]
            save()
        return values(name)

    operator = ensure(
        "keycloak-operator",
        {
            "bootstrap-password": secrets.token_hex(32),
            "operator-password": secrets.token_hex(24),
            "database-password": secrets.token_hex(32),
        },
    )
    headlamp = ensure("headlamp-oidc", {"client-secret": secrets.token_hex(32)})
    grafana = ensure("grafana-oidc", {"client-secret": secrets.token_hex(32)})
    del headlamp, grafana
    # Public CA only; Keycloak does not receive the authority's private signing key.
    ca = values("ca")["ca.crt"]
    ensure(
        "keycloak-runtime",
        {
            "ca.crt": ca,
            "bootstrap-password": operator["bootstrap-password"],
            "keycloak.conf": "\n".join(
                [
                    "db=postgres",
                    "db-username=keycloak",
                    "db-password=" + operator["database-password"],
                    "db-url=jdbc:postgresql://10.77.26.11:55432,10.77.26.12:55432/keycloak?targetServerType=primary&sslmode=verify-full&sslrootcert=/run/soloapp-secrets/data/ca.crt&connectTimeout=3&socketTimeout=15&hostRecheckSeconds=2",
                    "db-pool-initial-size=1",
                    "db-pool-min-size=1",
                    "db-pool-max-size=8",
                    "spi-connections-jpa--quarkus--async-commit=false",
                    "http-enabled=true",
                    "http-relative-path=/id",
                    "http-management-relative-path=/",
                    "proxy-headers=xforwarded",
                    "cache=ispn",
                ]
            )
            + "\n",
        },
    )
    for site in ("yc", "home"):
        for service, namespace, subject, secret in [
            ("keycloak", "soloapp", "keycloak", "keycloak-runtime"),
            ("headlamp-oidc", "observability", "headlamp-ui", "headlamp-oidc"),
        ]:
            name = service + "-" + site
            if name not in cloud["identities"]:
                cloud["identities"][name] = yc(
                    "iam",
                    "service-account",
                    "create",
                    "--name",
                    "soloapp-" + name,
                    "--folder-id",
                    cloud["folder"],
                )["id"]
                save()
            account = cloud["identities"][name]
            existing = yc(
                "iam",
                "workload-identity",
                "federated-credential",
                "list",
                "--service-account-id",
                account,
            )
            external = "system:serviceaccount:" + namespace + ":" + subject
            if not any(
                c.get("federation_id", c.get("federationId")) == cloud["federations"][site]
                and c.get("external_subject_id", c.get("externalSubjectId")) == external
                for c in existing
            ):
                yc(
                    "iam",
                    "workload-identity",
                    "federated-credential",
                    "create",
                    "--service-account-id",
                    account,
                    "--federation-id",
                    cloud["federations"][site],
                    "--external-subject-id",
                    external,
                )
            yc(
                "lockbox",
                "secret",
                "add-access-binding",
                cloud["secrets"][secret],
                "--role",
                "lockbox.payloadViewer",
                "--service-account-id",
                account,
            )
        grafana_identity = cloud["identities"][
            "grafana-admin" + ("-home" if site == "home" else "")
        ]
        yc(
            "lockbox",
            "secret",
            "add-access-binding",
            cloud["secrets"]["grafana-oidc"],
            "--role",
            "lockbox.payloadViewer",
            "--service-account-id",
            grafana_identity,
        )
    print(
        "Scoped runtime and OIDC credentials stored in Lockbox; operator credentials remain operator-only"
    )


if __name__ == "__main__":
    main()
