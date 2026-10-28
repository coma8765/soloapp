"""OIDC has explicit role boundaries and no client secret in ConfigMaps."""

import hashlib
import json
import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]


class OidcTests(unittest.TestCase):
    def test_two_contexts_share_oidc_but_runtime_secret_is_only_in_memory(self):
        env = jinja2.Environment(undefined=jinja2.StrictUndefined)
        env.filters["to_json"] = json.dumps
        env.filters["hash"] = lambda value, _: hashlib.sha256(value.encode()).hexdigest()
        env.filters["extract"] = lambda item, values, key: values[item][key]
        values = dict(
            project_root=str(ROOT),
            public_domain="example.test",
            oidc_enabled=True,
            groups={"app_sites": ["yc", "home"]},
            inventory_hostname="yc",
            secrets_image="secrets:test",
            cloud={
                "identities": {"headlamp-oidc-yc": "account"},
                "secrets": {"headlamp-oidc": "secret-id"},
            },
            headlamp=yaml.safe_load((ROOT / "infra/headlamp/defaults.yaml").read_text()),
            hostvars={
                s: {"private_ip": ip, "headlamp_cluster_ca": {"content": "PUBLIC"}}
                for s, ip in [("yc", "10.1.0.1"), ("home", "10.1.0.2")]
            },
        )
        values["lookup"] = lambda kind, path: env.from_string(Path(path).read_text()).render(
            **values
        )
        docs = list(
            yaml.safe_load_all(
                env.from_string((ROOT / "infra/headlamp/k8s/ui.yaml.j2").read_text()).render(
                    **values
                )
            )
        )
        config = json.loads(docs[0]["data"]["config"])
        for user in config["users"]:
            oidc = user["user"]["auth-provider"]["config"]
            self.assertEqual(oidc["client-id"], "headlamp")
            self.assertEqual(oidc["client-secret"], "__OIDC_CLIENT_SECRET__")
        pod = next(d for d in docs if d["kind"] == "Deployment")["spec"]["template"]["spec"]
        volumes = {v["name"]: v for v in pod["volumes"]}
        self.assertEqual(volumes["config"]["emptyDir"]["medium"], "Memory")
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertNotIn("identity", [v["name"] for v in pod["containers"][0]["volumeMounts"]])
        self.assertIn("-oidc-use-pkce=true", pod["containers"][0]["args"])
        self.assertIn("-oidc-use-token-broadcast=true", pod["containers"][0]["args"])

    def test_roles_are_required_at_apiserver_and_grafana(self):
        text = jinja2.Template(
            (ROOT / "infra/headlamp/k8s/authentication.yaml.j2").read_text()
        ).render(public_domain="example.test")
        jwt = yaml.safe_load(text)["jwt"][0]
        self.assertEqual(jwt["issuer"]["audiences"], ["headlamp"])
        self.assertIn("has(claims.headlamp_roles)", jwt["claimValidationRules"][0]["expression"])
        self.assertIn("'keycloak:'", jwt["claimMappings"]["username"]["expression"])
        grafana = (ROOT / "infra/observability/templates/grafana.yaml.j2").read_text()
        self.assertIn("role_attribute_strict = true", grafana)
        self.assertIn("|| 'None'", grafana)
        self.assertIn("allow_assign_grafana_admin = false", grafana)
        for doc in yaml.safe_load_all((ROOT / "infra/headlamp/k8s/oidc-rbac.yaml").read_text()):
            self.assertNotEqual(doc["roleRef"]["name"], "cluster-admin")
            self.assertTrue(
                all(s["name"].startswith("keycloak:headlamp:") for s in doc["subjects"])
            )
