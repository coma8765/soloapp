import unittest
from pathlib import Path

import jinja2
import yaml


class ManifestTests(unittest.TestCase):
    def test_private_offline_runtime(self):
        template = Path(__file__).parents[1] / "deploy/k8s/deployment.yaml.j2"
        docs = list(
            yaml.safe_load_all(
                jinja2.Template(template.read_text()).render(llama_image="pinned:test")
            )
        )
        pod = docs[0]["spec"]["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertTrue(pod["containers"][0]["securityContext"]["readOnlyRootFilesystem"])
        self.assertNotIn("hostNetwork", pod)
        self.assertEqual(docs[1]["spec"].get("type", "ClusterIP"), "ClusterIP")
        self.assertEqual(docs[2]["spec"]["egress"], [])
        self.assertEqual(
            docs[2]["spec"]["ingress"][0]["from"],
            [{"podSelector": {"matchLabels": {"app": "whoami"}}}],
        )
