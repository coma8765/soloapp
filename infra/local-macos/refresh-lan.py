#!/usr/bin/env python3
"""Reissue the LAN certificate and refresh app origins after a network change."""

import ipaddress
import subprocess
import sys
from pathlib import Path

import yaml

root = Path(__file__).resolve().parent
address = (
    sys.argv[1]
    if len(sys.argv) > 1
    else subprocess.check_output(["ipconfig", "getifaddr", "en0"], text=True).strip()
)
ip = ipaddress.ip_address(address)
if not ip.is_private or ip.is_loopback or ip.is_unspecified:
    raise SystemExit("Specify the private LAN IPv4 address of this Mac")
config = yaml.safe_load((root / "config.yaml").read_text())
context = "colima-" + config["profile"]
nodes = subprocess.check_output(
    ["kubectl", "--context", context, "get", "nodes", "-o", "name"], text=True
)
if "node/colima-soloapp-local" not in nodes:
    raise SystemExit("Unexpected cluster")
config["lan"]["ip"] = address
(root / "config.yaml").write_text(yaml.safe_dump(config, sort_keys=False))
from credentials import apply_secret, bundle, issue  # noqa: E402

apply_secret(
    "lan-tls", issue(bundle(), "soloapp-local", ips=[address, "127.0.0.1"], dns=["localhost"])
)
manifest = subprocess.check_output([sys.executable, str(root / "apps.py")])
kube = ["kubectl", "--context", context, "-n", config["namespace"]]
subprocess.run(kube + ["apply", "-f", "-"], input=manifest, check=True)
subprocess.run(kube + ["rollout", "restart", "deployment/nginx"], check=True)
for app in ["auth", "whoami", "client-gateway", "client-notify", "nginx"]:
    subprocess.run(kube + ["rollout", "status", "deployment/" + app, "--timeout=180s"], check=True)
subprocess.run([sys.executable, str(root / "install-launchagent.py")], check=True)
if config["lan"]["https_port"] == 443:
    subprocess.run([sys.executable, str(root / "install-https-relay.py")], check=True)
print(f"LAN URL: https://{address}:{config['lan']['https_port']}/")
