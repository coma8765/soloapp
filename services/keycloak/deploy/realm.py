"""Initialize the project realm using operator-only Lockbox credentials.

Run after the public TLS route is healthy. No credentials are emitted or written to disk.
"""

import importlib.util
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "infra/operations"))
from remote import host_config  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "cloud_api", ROOT / "infra/object-storage/bootstrap.py"
)
cloud_api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud_api)


def main():
    cloud = json.loads(cloud_api.STATE.read_text())

    def secret(name):
        return {
            e["key"]: e.get("textValue", e.get("text_value"))
            for e in cloud_api.yc("lockbox", "payload", "get", cloud["secrets"][name])["entries"]
        }

    operator = secret("keycloak-operator")
    domain = host_config("yc")["public_domain"]
    base = "https://" + domain + "/id"
    body = urllib.parse.urlencode(
        {
            "client_id": "admin-cli",
            "grant_type": "password",
            "username": "bootstrap-admin",
            "password": operator["bootstrap-password"],
        }
    ).encode()
    request = urllib.request.Request(
        base + "/realms/master/protocol/openid-connect/token", data=body
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        token = json.load(response)["access_token"]

    def api(method, path, data=None, missing=False):
        request = urllib.request.Request(
            base + "/admin" + path,
            method=method,
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
            data=json.dumps(data).encode() if data is not None else None,
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read()
                return json.loads(payload) if payload else None
        except urllib.error.HTTPError as error:
            if missing and error.code == 404:
                return None
            raise RuntimeError(
                f"Keycloak admin operation {method} failed with HTTP {error.code}"
            ) from None

    template = jinja2.Environment(undefined=jinja2.StrictUndefined).from_string(
        Path(__file__).with_name("realm.yaml.j2").read_text()
    )
    realm = yaml.safe_load(template.render(public_domain=domain))
    for client in realm["clients"]:
        client["secret"] = secret(client["clientId"] + "-oidc")["client-secret"]
    if api("GET", "/realms/soloapp", missing=True) is None:
        api("POST", "/realms", realm)
    else:
        raise RuntimeError("Realm already exists; refusing to overwrite live identity policy")
    root = "/realms/soloapp"
    for client_name, operator_role in [("headlamp", "operator"), ("grafana", "admin")]:
        clients = api("GET", root + "/clients?clientId=" + client_name)
        client_id = clients[0]["id"]
        roles = api("GET", root + "/clients/" + client_id + "/roles")
        api("POST", root + "/clients/" + client_id + "/scope-mappings/clients/" + client_id, roles)
    api(
        "PUT",
        root + "/authentication/required-actions/webauthn-register-passwordless",
        {
            "alias": "webauthn-register-passwordless",
            "name": "Register Passkey",
            "providerId": "webauthn-register-passwordless",
            "enabled": True,
            "defaultAction": False,
            "priority": 70,
        },
    )
    api(
        "POST",
        root + "/users",
        {
            "username": "ananevn002",
            "enabled": True,
            "credentials": [
                {"type": "password", "value": operator["operator-password"], "temporary": True}
            ],
            "requiredActions": ["UPDATE_PASSWORD", "webauthn-register-passwordless"],
        },
    )
    user = api("GET", root + "/users?username=ananevn002&exact=true")[0]["id"]
    for client_name, role_name in [("headlamp", "operator"), ("grafana", "admin")]:
        client = api("GET", root + "/clients?clientId=" + client_name)[0]["id"]
        role = api("GET", root + "/clients/" + client + "/roles/" + role_name)
        api("POST", root + "/users/" + user + "/role-mappings/clients/" + client, [role])
    print("Realm initialized; ananevn002 must change the temporary password and register a passkey")


if __name__ == "__main__":
    main()
