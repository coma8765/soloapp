"""Render and verify service deployment boundaries without production credentials."""

import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
SERVICE = ROOT / "services/keycloak"


class DeploymentTests(unittest.TestCase):
    def render(self, name):
        env = jinja2.Environment(undefined=jinja2.StrictUndefined)
        env.filters["to_json"] = __import__("json").dumps
        return list(
            yaml.safe_load_all(
                env.from_string((SERVICE / "deploy/k8s" / name).read_text()).render(
                    keycloak_config={
                        "replicas": 1,
                        "image": "example/keycloak@sha256:" + "a" * 64,
                        "image_pull_policy": "IfNotPresent",
                        "resources": {"requests": {"memory": "512Mi"}, "limits": {"memory": "1Gi"}},
                    },
                    secrets_image="example/secrets:1",
                    inventory_hostname="yc",
                    private_ip="10.1.0.1",
                    public_domain="example.test",
                    cloud={
                        "identities": {"keycloak-yc": "account"},
                        "secrets": {"keycloak-runtime": "secret"},
                    },
                    groups={"app_sites": ["yc", "home"]},
                    hostvars={"yc": {"private_ip": "10.1.0.1"}, "home": {"private_ip": "10.1.0.2"}},
                )
            )
        )

    def test_runtime_has_no_kubernetes_credentials_or_persistent_secrets(self):
        sa, deploy = self.render("deployment.yaml.j2")
        self.assertFalse(sa["automountServiceAccountToken"])
        pod = deploy["spec"]["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        runtime = pod["containers"][0]
        self.assertNotIn("identity", [m["name"] for m in runtime["volumeMounts"]])
        volumes = {v["name"]: v for v in pod["volumes"]}
        self.assertEqual(volumes["secrets"]["emptyDir"]["medium"], "Memory")
        self.assertTrue(runtime["securityContext"]["readOnlyRootFilesystem"])
        self.assertEqual(deploy["spec"]["strategy"]["type"], "Recreate")
        for port in runtime["ports"]:
            if "hostPort" in port:
                self.assertEqual(port["hostIP"], "10.1.0.1")
        self.assertEqual(runtime["readinessProbe"]["httpGet"]["port"], "management")

    def test_service_is_internal_and_public_egress_excludes_metadata(self):
        (service,) = self.render("service.yaml.j2")
        self.assertNotIn("type", service["spec"])
        policy, _ = self.render("networkpolicy.yaml.j2")
        public = policy["spec"]["egress"][-1]
        self.assertIn("169.254.0.0/16", public["to"][0]["ipBlock"]["except"])
        self.assertEqual(public["ports"], [{"protocol": "TCP", "port": 443}])

    def test_standard_release_build_uses_preoptimized_runtime(self):
        dockerfile = (SERVICE / "deploy/Dockerfile").read_text()
        self.assertIn(" AS runtime", dockerfile)
        self.assertIn("kc.sh build", dockerfile)
        self.assertIn("start --optimized", (SERVICE / "src/entrypoint.sh").read_text())
        self.assertIn(
            "keycloak) services=(keycloak)", (ROOT / "infra/registry/build.sh").read_text()
        )


if __name__ == "__main__":
    unittest.main()
