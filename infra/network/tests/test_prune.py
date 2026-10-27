import json
import unittest

from prune import objects, stale


class PruneTests(unittest.TestCase):
    def test_kubectl_concatenated_objects(self):
        a = {"kind": "NetworkPolicy", "metadata": {"name": "a", "namespace": "soloapp"}}
        self.assertEqual(objects(json.dumps(a) + "\n" + json.dumps(a)), {"items": [a, a]})
        self.assertEqual(objects(json.dumps({"kind": "List", "items": [a]})), {"items": [a]})

    def test_never_deletes_foreign_policies(self):
        def policy(name, managed=True):
            return {
                "metadata": {
                    "name": name,
                    "namespace": "soloapp",
                    "labels": {"soloapp.io/network-policy": "isolation" if managed else "service"},
                }
            }

        self.assertEqual(
            stale(
                {"items": [policy("keep")]},
                {"items": [policy("keep"), policy("revoked"), policy("foreign", False)]},
            ),
            [("soloapp", "revoked")],
        )
