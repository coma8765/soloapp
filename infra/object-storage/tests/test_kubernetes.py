import json
import pathlib
import unittest

import jinja2
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[3]


class StorageManifestTest(unittest.TestCase):
    def test_existing_data_is_retained_and_not_shared_between_writers(self):
        env = jinja2.Environment(undefined=jinja2.StrictUndefined)
        env.filters["to_json"] = json.dumps
        config = yaml.safe_load((ROOT / "infra/object-storage/defaults.yaml").read_text())
        text = (ROOT / "infra/object-storage/k8s/seaweedfs.yaml.j2").read_text()
        docs = list(
            yaml.safe_load_all(
                env.from_string(text).render(
                    s3_config=config,
                    s3_node_name={"stdout": "test-node"},
                    private_ip="10.1.1.1",
                    hostvars={"yc": {"private_ip": "10.1.1.1"}, "home": {"private_ip": "10.1.1.2"}},
                )
            )
        )
        pv = next(d["spec"] for d in docs if d["kind"] == "PersistentVolume")
        self.assertEqual(pv["persistentVolumeReclaimPolicy"], "Retain")
        self.assertEqual(pv["local"]["path"], "/var/lib/soloapp-s3")
        sts = next(d["spec"] for d in docs if d["kind"] == "StatefulSet")
        self.assertEqual(sts["replicas"], 1)
        pod = sts["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertFalse(pod.get("hostNetwork", False))
        server = pod["containers"][0]
        self.assertEqual(server["ports"][0]["hostIP"], "10.1.1.1")
        self.assertIn("-s3.config=/secrets/s3.json", server["args"])
        for probe in ("startupProbe", "readinessProbe", "livenessProbe"):
            self.assertIn(probe, server)
        policy = next(d["spec"] for d in docs if d["metadata"]["name"] == "seaweedfs-isolation")
        self.assertEqual(policy["egress"], [])
        self.assertEqual(policy["ingress"][0]["ports"], [{"port": 8333, "protocol": "TCP"}])
