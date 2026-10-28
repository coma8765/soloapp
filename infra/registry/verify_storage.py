#!/usr/bin/env python3
"""Snapshot/verify registry tag digests and referenced blobs using the mTLS API."""

import argparse
import hashlib
import http.client
import json
import pathlib
import ssl
from urllib.parse import quote, urlsplit

ACCEPT = "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host")
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--write-check", action="store_true")
    args = parser.parse_args()
    directory = pathlib.Path("/run/soloapp-registry")

    def request(path, method="GET", data=None, write=False, content_type=None):
        ctx = ssl.create_default_context(cafile=str(directory / "ca.crt"))
        identity = "push" if write else "pull"
        ctx.load_cert_chain(
            str(directory / (identity + ".crt")), str(directory / (identity + ".key"))
        )
        conn = http.client.HTTPSConnection(
            "127.0.0.1" if write else args.host, 5044 if write else 5043, context=ctx, timeout=30
        )
        try:
            headers = {"Accept": ACCEPT}
            if content_type:
                headers["Content-Type"] = content_type
            conn.request(method, path, body=data, headers=headers)
            result = conn.getresponse()
            body = result.read()
            if result.status not in (200, 201):
                raise RuntimeError(f"Registry request failed: {method} {result.status}")
            return body, dict((k.lower(), v) for k, v in result.getheaders())
        finally:
            conn.close()

    def listing(path, field):
        values = []
        while path:
            body, headers = request(path)
            values.extend(json.loads(body).get(field) or [])
            link = headers.get("link")
            path = None
            if link:
                next_url = urlsplit(link.split(">")[0].lstrip("<"))
                if next_url.netloc:
                    raise ValueError("Unexpected external pagination URL")
                path = next_url.path + ("?" + next_url.query if next_url.query else "")
        return values

    result = {}
    sample = None
    blobs = set()
    for repo in listing("/v2/_catalog?n=1000", "repositories"):
        for tag in listing("/v2/" + quote(repo, safe="/") + "/tags/list?n=1000", "tags"):
            path = "/v2/" + quote(repo, safe="/") + "/manifests/" + quote(tag, safe="")
            body, headers = request(path)
            digest = "sha256:" + hashlib.sha256(body).hexdigest()
            if headers.get("docker-content-digest") != digest:
                raise ValueError("Manifest digest mismatch")
            result[repo + ":" + tag] = digest
            manifest = json.loads(body)
            for desc in [manifest["config"], *manifest["layers"]]:
                blob = "/v2/" + quote(repo, safe="/") + "/blobs/" + desc["digest"]
                if blob not in blobs:
                    _, bh = request(blob, method="HEAD")
                    if int(bh["content-length"]) != desc["size"]:
                        raise ValueError("Blob size mismatch")
                    blobs.add(blob)
            sample = (path, body, headers["content-type"])
    if not result:
        raise ValueError("Empty registry")
    target = pathlib.Path(args.snapshot)
    if args.verify:
        if json.loads(target.read_text()) != result:
            raise ValueError("Tag/digest inventory changed")
    else:
        if target.exists():
            raise ValueError("Snapshot already exists")
        target.write_text(json.dumps(result, sort_keys=True))
        target.chmod(0o600)
    if args.write_check:
        path, body, media = sample
        request(path, method="PUT", data=body, write=True, content_type=media)
        if request(path)[0] != body:
            raise ValueError("Write/read-back mismatch")
    print(
        json.dumps(
            {
                "tags": len(result),
                "repository_blobs": len(blobs),
                "inventory_sha256": hashlib.sha256(
                    json.dumps(result, sort_keys=True).encode()
                ).hexdigest(),
                "verified": args.verify,
                "write_check": args.write_check,
            }
        )
    )


if __name__ == "__main__":
    main()
