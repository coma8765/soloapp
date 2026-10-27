#!/usr/bin/env python3
"""Run on a cluster node as operator. Temporary unprivileged pod has no credentials."""

import json
import subprocess

NAME = "isolation-verification"


def kubectl(*args, data=None):
    return subprocess.check_output(["k3s", "kubectl", *args], input=data, text=True)


def main():
    image = json.loads(kubectl("-n", "soloapp", "get", "deployment", "auth", "-o", "json"))["spec"][
        "template"
    ]["spec"]["initContainers"][0]["image"]
    auth = json.loads(kubectl("-n", "soloapp", "get", "service", "auth", "-o", "json"))
    address, port = auth["spec"]["clusterIP"], auth["spec"]["ports"][0]["port"]
    pod = {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": NAME, "namespace": "soloapp", "labels": {"app": NAME}},
        "spec": {
            "automountServiceAccountToken": False,
            "restartPolicy": "Never",
            "activeDeadlineSeconds": 180,
            "securityContext": {
                "runAsNonRoot": True,
                "runAsUser": 10001,
                "seccompProfile": {"type": "RuntimeDefault"},
            },
            "containers": [
                {
                    "name": "probe",
                    "image": image,
                    "imagePullPolicy": "Never",
                    "command": ["python3", "-c", "import time; time.sleep(180)"],
                    "securityContext": {
                        "allowPrivilegeEscalation": False,
                        "readOnlyRootFilesystem": True,
                        "capabilities": {"drop": ["ALL"]},
                    },
                    "resources": {
                        "requests": {"cpu": "5m", "memory": "16Mi"},
                        "limits": {"cpu": "100m", "memory": "32Mi"},
                    },
                }
            ],
        },
    }

    def connect(host, number, expected):
        code = f"import socket\ntry:\n s=socket.create_connection(({host!r},{number}),2);s.close(); connected=True\nexcept OSError: connected=False\nassert connected is {expected!r}, 'unexpected network access'\n"
        kubectl("-n", "soloapp", "exec", NAME, "--", "python3", "-c", code)

    try:
        kubectl("apply", "-f", "-", data=json.dumps(pod))
        kubectl("-n", "soloapp", "wait", "--for=condition=Ready", "pod/" + NAME, "--timeout=60s")
        connect(address, port, False)
        connect("1.1.1.1", 443, False)
        # No Service selector includes this pod: granting a network role does not
        # put it behind a production load balancer, and it has no HMAC/TLS keys.
        kubectl("-n", "soloapp", "label", "pod", NAME, "app=nginx", "--overwrite")
        import time

        time.sleep(6)
        connect(address, port, True)
        connect("169.254.169.254", 80, False)
        print(
            "PASS: unknown pod denied backend/public egress; explicit nginx role allowed; metadata denied"
        )
    finally:
        kubectl("-n", "soloapp", "delete", "pod", NAME, "--ignore-not-found", "--wait=false")


if __name__ == "__main__":
    main()
