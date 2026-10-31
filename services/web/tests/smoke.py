#!/usr/bin/env python3
"""Verify versioned assets through the production HTTPS entry point."""

import json
import os
import re
import sys
import urllib.request

base = os.environ["SOLOAPP_BASE_URL"].rstrip("/")
sha = sys.argv[1]
assert re.fullmatch("[0-9a-f]{40}", sha)
with urllib.request.urlopen(base + "/", timeout=20) as r:
    html = r.read().decode()
    assert r.headers["X-Web-Revision"] == sha
assert f"/web/releases/{sha}/" in html
paths = (
    ("client/main.js", "client/generated/api.js", "assets/world.json")
    if "client/main.js" in html
    else ("flutter_bootstrap.js", "main.dart.js", "canvaskit/canvaskit.wasm")
)
for path in paths:
    with urllib.request.urlopen(base + f"/web/releases/{sha}/" + path, timeout=30) as r:
        assert r.status == 200 and len(r.read()) > 0
        assert "immutable" in r.headers["Cache-Control"]
print(json.dumps({"web_revision": sha, "assets_verified": 3}))
