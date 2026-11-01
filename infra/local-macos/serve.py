#!/usr/bin/env python3
"""Keep LAN HTTPS connected to the Kubernetes Service through the local VM."""

import ipaddress
import signal
import subprocess
import time
from pathlib import Path

import yaml

child = None
stopping = False


def stop(*_):
    global stopping
    stopping = True
    if child is not None:
        child.terminate()


def tunnel_command(config, service_ip):
    address = str(ipaddress.ip_address(service_ip.strip()))
    port = config["lan"]["https_port"]
    bindings = [("127.0.0.1", 8443 if port == 443 else port)]
    if port != 443:
        bindings.append((str(ipaddress.ip_address(config["lan"]["ip"])), port))
    command = [
        "ssh",
        "-F",
        str(Path.home() / ".colima/ssh_config"),
        "-S",
        "none",
        "-o",
        "ControlMaster=no",
        "-o",
        "ForwardAgent=no",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=10",
        "-o",
        "ServerAliveCountMax=3",
        "-N",
    ]
    for host, listen_port in bindings:
        command += ["-L", f"{host}:{listen_port}:{address}:8443"]
    return command + ["colima-" + config["profile"]]


def main():
    global child
    config = yaml.safe_load((Path(__file__).parent / "config.yaml").read_text())
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not stopping:
        try:
            # Resolve again after VM/service recreation. Individual closed client
            # streams must not kill the tunnel and every active WebSocket.
            address = subprocess.check_output(
                [
                    "kubectl",
                    "--context",
                    "colima-" + config["profile"],
                    "-n",
                    config["namespace"],
                    "get",
                    "service/nginx",
                    "-o",
                    "jsonpath={.spec.clusterIP}",
                ],
                text=True,
                timeout=15,
            )
            if stopping:
                break
            child = subprocess.Popen(tunnel_command(config, address))
            child.wait()
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            print(f"Local HTTPS tunnel unavailable: {type(error).__name__}", flush=True)
        finally:
            child = None
        if not stopping:
            time.sleep(2)


if __name__ == "__main__":
    main()
