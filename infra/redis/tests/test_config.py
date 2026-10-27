import importlib.util
import unittest
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "files/manage.py"
spec = importlib.util.spec_from_file_location("redis_manager", PATH)
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)


class ConfigTest(unittest.TestCase):
    def test_persist_only_topology(self):
        raw = "sentinel monitor room 10.0.0.1 16379 2\nsentinel auth-pass room password\nsentinel sentinel-pass password\nsentinel current-epoch 3\nmasterauth password\nreplicaof 10.0.0.2 16379\n"
        self.assertNotIn("password", manager.topology(raw, "sentinel"))
        self.assertNotIn("password", manager.topology(raw, "redis"))
        self.assertIn("current-epoch 3", manager.topology(raw, "sentinel"))
        self.assertEqual(manager.topology(raw, "redis"), "replicaof 10.0.0.2 16379\n")

    def test_empty_saved_role_preserves_promoted_primary(self):
        config = {
            "ip": "10.0.0.2",
            "initial_master": "10.0.0.1",
            "port": 16379,
            "master_name": "room",
            "maxmemory": "128mb",
            "min_replicas_to_write": 0,
        }
        credentials = dict.fromkeys(["operator", "replication", "sentinel", "chat"], "fixture")
        text, acl = manager.render(config, credentials, "redis", "\n")
        self.assertNotIn("replicaof", text)
        self.assertIn("tls-auth-clients no", text)
        self.assertIn("port 0\n", text)
        self.assertNotIn("fixture", acl)
        chat = next(line for line in acl.splitlines() if line.startswith("user chat "))
        self.assertIn("~soloapp:chat:*", chat)
        for forbidden in ("+@all", "+publish", "+config", "+replicaof", "+flushall", "&*"):
            self.assertNotIn(forbidden, chat)
