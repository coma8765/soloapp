import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("serve", Path(__file__).parents[1] / "serve.py")
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


class ServiceTunnelTests(unittest.TestCase):
    def config(self, port=443):
        return {"profile": "soloapp-local", "lan": {"ip": "192.168.1.2", "https_port": port}}

    def test_https_relay_keeps_backend_loopback_only_and_uses_service(self):
        command = serve.tunnel_command(self.config(), "10.43.1.5\n")
        self.assertEqual(command.count("-L"), 1)
        self.assertIn("127.0.0.1:8443:10.43.1.5:8443", command)
        self.assertIn("ExitOnForwardFailure=yes", command)
        self.assertIn("ForwardAgent=no", command)
        self.assertIn("ServerAliveCountMax=3", command)
        self.assertIn("none", command)
        self.assertEqual(command[-1], "colima-soloapp-local")

    def test_nonprivileged_port_keeps_explicit_lan_binding(self):
        command = serve.tunnel_command(self.config(9443), "10.43.1.5")
        self.assertEqual(command.count("-L"), 2)
        self.assertIn("192.168.1.2:9443:10.43.1.5:8443", command)
        self.assertIn("127.0.0.1:9443:10.43.1.5:8443", command)

    def test_missing_or_invalid_cluster_ip_is_rejected(self):
        for value in ["", "None", "10.43.1.5:22", "localhost"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                serve.tunnel_command(self.config(), value)
