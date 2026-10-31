#!/usr/bin/env python3
"""Read-only web origin, serving only files in a verified release manifest."""

import hashlib
import json
import mimetypes
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from storage.client import clients
from storage.release import revision, safe_path

CURRENT = revision(os.environ["WEB_RELEASE"])
CACHE = Path("/cache")
CONFIG = "/run/soloapp-secrets/data/reader.json"
LOCK = threading.RLock()
MAX_CACHE = 192 * 1024 * 1024
LAST_GOOD = 0


def object_bytes(key):
    global LAST_GOOD
    bucket, stores = clients(CONFIG)
    order = [LAST_GOOD] + [i for i in range(len(stores)) if i != LAST_GOOD]
    for index in order:
        store = stores[index]
        try:
            response = store.get_object(Bucket=bucket, Key=key)
            if response["ContentLength"] > 64 * 1024 * 1024:
                raise ValueError("Oversized object")
            with response["Body"] as body:
                data = body.read()
            LAST_GOOD = index
            return data
        except Exception:
            continue
    raise OSError("S3 replicas unavailable")


def manifest(sha):
    path = CACHE / sha / "committed.json"
    if path.exists():
        return json.loads(path.read_bytes())
    data = object_bytes(f"releases/{sha}/committed.json")
    value = json.loads(data)
    if value["revision"] != sha or len(value["files"]) > 4096:
        raise ValueError("Bad manifest")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return value


def asset(sha, name):
    revision(sha)
    safe_path(name)
    with LOCK:
        digest = manifest(sha)["files"].get(name)
        if digest is None:
            raise FileNotFoundError(name)
        path = CACHE / sha / name
        if path.exists():
            return path.read_bytes()
        data = object_bytes(f"releases/{sha}/{name}")
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("Asset checksum mismatch")
        # The active release is preloaded; other versions are served without unbounded caching.
        if sha == CURRENT:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        return data


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32
    slots = threading.BoundedSemaphore(16)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *args):
        pass

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        try:
            if path in ("/healthz", "/ready"):
                data = b"ok"
                content_type = "text/plain"
                immutable = False
            else:
                immutable = path != "/"
                if path == "/":
                    sha, name = CURRENT, "index.html"
                else:
                    match = re.fullmatch(r"/web/releases/([0-9a-f]{40})/(.+)", path)
                    if not match:
                        self.send_error(404)
                        return
                    sha, name = match.groups()
                data = asset(sha, name)
                content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header(
                "Cache-Control", "public, max-age=31536000, immutable" if immutable else "no-store"
            )
            self.send_header("X-Web-Revision", CURRENT)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
        except (FileNotFoundError, ValueError, KeyError):
            self.send_error(404)
        except Exception:
            self.send_error(503)


if __name__ == "__main__":
    CACHE.mkdir(exist_ok=True)
    # Ready only after the complete active build is available locally.
    total = 0
    for name in manifest(CURRENT)["files"]:
        total += len(asset(CURRENT, name))
        if total > MAX_CACHE:
            raise SystemExit("Release exceeds web cache budget")
    Server(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
