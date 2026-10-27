#!/usr/bin/env python3
"""Publish exactly one immutable bundle to both independent S3 replicas."""

import argparse
import hashlib
import json
import mimetypes
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "libs"))
from botocore.exceptions import ClientError
from storage.client import clients
from storage.release import MAX_BUNDLE, revision, unpack


def get(client, bucket, key):
    return client.get_object(Bucket=bucket, Key=key)["Body"].read()


def verify_copies(bucket, stores, sha):
    if len(stores) != 2:
        raise ValueError("Exactly two replicas required")
    manifests = [get(s, bucket, f"releases/{sha}/committed.json") for s in stores]
    if manifests[0] != manifests[1] or json.loads(manifests[0])["revision"] != sha:
        raise ValueError("Release differs between replicas")
    return manifests[0]


def publish(bucket, stores, sha, files, manifest):
    if len(stores) != 2:
        raise ValueError("Exactly two replicas required")
    prefix = f"releases/{sha}/"
    # Preflight BOTH stores before writing anything. Never overwrite another build of a SHA.
    for store in stores:
        store.head_bucket(Bucket=bucket)
        try:
            if get(store, bucket, prefix + "_release.json") != manifest:
                raise ValueError("This revision already has a different build")
        except ClientError as error:
            if error.response["ResponseMetadata"]["HTTPStatusCode"] != 404:
                raise
    for store in stores:
        for name, data in files.items():
            store.put_object(
                Bucket=bucket,
                Key=prefix + name,
                Body=data,
                ContentType=mimetypes.guess_type(name)[0] or "application/octet-stream",
            )
            if (
                hashlib.sha256(get(store, bucket, prefix + name)).digest()
                != hashlib.sha256(data).digest()
            ):
                raise ValueError("Read-back verification failed")
        store.put_object(
            Bucket=bucket,
            Key=prefix + "_release.json",
            Body=manifest,
            ContentType="application/json",
        )
    # Only after every object has been read back from both sites.
    for store in stores:
        store.put_object(
            Bucket=bucket,
            Key=prefix + "committed.json",
            Body=manifest,
            ContentType="application/json",
        )
    verify_copies(bucket, stores, sha)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("sha", type=revision)
    p.add_argument("--check", action="store_true")
    p.add_argument("--config", default="/run/s3/publisher.json")
    args = p.parse_args()
    bucket, stores = clients(args.config)
    if args.check:
        verify_copies(bucket, stores, args.sha)
    else:
        data = sys.stdin.buffer.read(MAX_BUNDLE + 1)
        files, manifest = unpack(data, args.sha)
        publish(bucket, stores, args.sha, files, manifest)
    print(json.dumps({"revision": args.sha, "replicas_verified": 2}))


if __name__ == "__main__":
    main()
