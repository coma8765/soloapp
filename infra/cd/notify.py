#!/usr/bin/env python3
"""Send bounded deployment events through the dedicated, chat-scoped relay endpoint."""

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

SERVICES = ("auth", "app-api", "nginx", "web", "client-notify", "client-gateway", "keycloak")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def events(env):
    scope = env["SERVICE"]
    if scope not in (*SERVICES, "all"):
        raise ValueError("Invalid deployment scope")
    state = env["DEPLOY_STATE"]
    if state not in ("started", "success", "failure", "cancelled"):
        raise ValueError("Invalid deployment state")
    target = env.get("TARGET") or env.get("ROLLBACK") or env["GITHUB_SHA"]
    if not re.fullmatch(r"(?:[0-9a-f]{40}|v0\.1\.\d+)", target):
        # Invalid rollback input must still produce a prepare-failure notification.
        target = env["GITHUB_SHA"]
    return [
        {
            "project": "soloapp",
            "service": service,
            "state": state,
            "revision": env["GITHUB_SHA"],
            "target": target,
            "version": env.get("VERSION", ""),
            "operation": "rollback" if env.get("ROLLBACK") else "deploy",
            "run_id": env["GITHUB_RUN_ID"],
            "attempt": env["GITHUB_RUN_ATTEMPT"],
            "phase": env.get("PHASE", "prepare"),
            "scope": scope,
        }
        for service in (SERVICES if scope == "all" else (scope,))
    ]


def send_events(env, *, send=None, sleep=time.sleep):
    url, token = env.get("CD_NOTIFY_URL", ""), env.get("CD_NOTIFY_TOKEN", "")
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path != "/deployments"
        or parsed.query
        or parsed.fragment
        or len(token) < 32
    ):
        raise ValueError("Deployment notification secrets are missing or invalid")
    send = send or urllib.request.build_opener(NoRedirect()).open
    for event in events(env):
        request = urllib.request.Request(
            url,
            data=json.dumps(event).encode(),
            headers={
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json",
                "User-Agent": "soloapp-cd/1",
            },
            method="POST",
        )
        for attempt in range(3):
            try:
                with send(request, timeout=15) as response:
                    if response.status != 204:
                        raise OSError("Unexpected relay response")
                break
            except (OSError, urllib.error.URLError):
                if attempt == 2:
                    raise RuntimeError(
                        "Deployment notification delivery failed after 3 attempts"
                    ) from None
                sleep(2**attempt)
        print("Deployment event delivered:", event["service"], event["state"])


if __name__ == "__main__":
    try:
        send_events(os.environ)
    except (RuntimeError, ValueError) as error:
        raise SystemExit(str(error)) from None
