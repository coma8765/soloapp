import hashlib
import json
import pathlib
import unittest

import jinja2
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[3]


class HeadlampConfigTest(unittest.TestCase):
    def test_ha_manifest_and_no_workload_credentials(self):
        env = jinja2.Environment(undefined=jinja2.StrictUndefined)
        env.filters["to_json"] = json.dumps
        env.filters["hash"] = lambda value, _: hashlib.sha256(value.encode()).hexdigest()
        env.filters["extract"] = lambda item, values, key: values[item][key]
        text = (ROOT / "infra/headlamp/k8s/ui.yaml.j2").read_text()
        config = yaml.safe_load((ROOT / "infra/headlamp/defaults.yaml").read_text())
        values = {
            "groups": {"app_sites": ["yc", "home"]},
            "hostvars": {
                site: {"private_ip": ip, "headlamp_cluster_ca": {"content": "PUBLIC_CA"}}
                for site, ip in [("yc", "10.77.26.11"), ("home", "10.77.26.12")]
            },
            "headlamp": config,
        }
        docs = list(yaml.safe_load_all(env.from_string(text).render(**values)))
        deployment = next(d for d in docs if d["kind"] == "Deployment")["spec"]
        self.assertEqual(deployment["replicas"], 2)
        self.assertEqual(deployment["strategy"]["rollingUpdate"]["maxUnavailable"], 0)
        pod = deployment["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        kubeconfig = yaml.safe_load(docs[0]["data"]["config"])
        self.assertEqual({c["name"] for c in kubeconfig["contexts"]}, {"yc", "home"})
        self.assertTrue(all(not u["user"] for u in kubeconfig["users"]))
        self.assertTrue(
            all("certificate-authority-data" in c["cluster"] for c in kubeconfig["clusters"])
        )
        self.assertTrue(
            all("insecure-skip-tls-verify" not in c["cluster"] for c in kubeconfig["clusters"])
        )

    def test_permissions_are_scoped_and_not_bound_to_ui(self):
        docs = list(yaml.safe_load_all((ROOT / "infra/headlamp/k8s/access.yaml.j2").read_text()))
        for obj in docs:
            for subject in obj.get("subjects", []):
                self.assertEqual(subject["name"], "headlamp-operator")
            for rule in obj.get("rules", []):
                if obj["kind"] == "ClusterRole":
                    self.assertLessEqual(set(rule["verbs"]), {"get", "list", "watch"})
                    self.assertNotIn("pods/log", rule["resources"])
                    self.assertNotIn("configmaps", rule["resources"])
                self.assertNotIn("*", rule["verbs"])
                self.assertNotIn("secrets", rule["resources"])
                self.assertNotIn("pods/exec", rule["resources"])
                if "patch" in rule["verbs"] or "update" in rule["verbs"]:
                    self.assertEqual(obj["metadata"]["namespace"], "soloapp")
                    self.assertEqual(len(rule["resourceNames"]), 6)


if __name__ == "__main__":
    unittest.main()
