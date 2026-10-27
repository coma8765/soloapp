#!/usr/bin/env python3
"""Read YC's routing decision with a projected workload identity; keep tokens in RAM."""

import importlib.util
import json
import os
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATES = ("INITIAL", "HEALTHY", "UNHEALTHY", "DRAINING", "INACTIVE", "UNKNOWN")


def metrics(targets, expected, success, last_success, duration):
    lines = [
        f"soloapp_nlb_poll_success {int(success)}",
        f"soloapp_nlb_last_success_timestamp_seconds {last_success}",
        f"soloapp_nlb_poll_duration_seconds {duration}",
    ]
    observed = {t["address"]: t for t in targets}
    for address, ingress in expected.items():
        target = observed.get(address, {})
        state = target.get("status", "UNKNOWN")
        if state not in STATES:
            state = "UNKNOWN"
        labels = f"ingress={json.dumps(ingress)},address={json.dumps(address)}"
        for item in STATES:
            lines.append(
                f'soloapp_nlb_target_state{{{labels},state="{item}"}} {int(item == state)}'
            )
        lines.append(
            f"soloapp_nlb_target_zone_shifted{{{labels}}} {int(target.get('zoneShifted', False))}"
        )
    return ("\n".join(lines) + "\n").encode()


def main():
    expected = json.loads(os.environ["NLB_TARGETS"])
    interval = float(os.environ.get("POLL_INTERVAL", "5"))
    timeout = float(os.environ.get("API_TIMEOUT", "2"))
    spec = importlib.util.spec_from_file_location("secret_fetch", "/usr/local/bin/secret-fetch.py")
    identity = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(identity)
    url = (
        "https://load-balancer.api.cloud.yandex.net/load-balancer/v1/networkLoadBalancers/"
        + os.environ["NLB_ID"]
        + ":getTargetStates?"
        + urllib.parse.urlencode({"targetGroupId": os.environ["TARGET_GROUP_ID"]})
    )
    snapshot = [metrics([], expected, False, 0, 0)]

    def poll():
        token, token_until, last_success = None, 0, 0
        while True:
            start = time.monotonic()
            targets, ok = [], False
            try:
                if time.monotonic() >= token_until:
                    token = identity.iam()
                    token_until = time.monotonic() + 240
                req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
                with urllib.request.urlopen(req, timeout=timeout) as response:
                    targets = json.load(response)["targetStates"]
                ok = True
                last_success = time.time()
            except Exception as error:
                print("NLB read failed: " + type(error).__name__, flush=True)
                token_until = 0
            snapshot[0] = metrics(targets, expected, ok, last_success, time.monotonic() - start)
            time.sleep(max(0.1, interval - (time.monotonic() - start)))

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/metrics":
                self.send_error(404)
                return
            body = snapshot[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    threading.Thread(target=poll, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", 19092), Handler).serve_forever()


if __name__ == "__main__":
    main()
