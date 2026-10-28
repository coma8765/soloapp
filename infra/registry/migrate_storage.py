#!/usr/bin/env python3
"""Copy a frozen Distribution S3 store to a filesystem; never delete source data."""

import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil


def relative_key(key):
    path = pathlib.PurePosixPath(key)
    if (
        path.is_absolute()
        or ".." in path.parts
        or str(path) != key
        or not key.startswith("docker/registry/v2/")
        or "\\" in key
    ):
        raise ValueError("Unexpected registry object key")
    return path


def check_blob(key, digest):
    match = re.fullmatch(r"docker/registry/v2/blobs/sha256/[0-9a-f]{2}/([0-9a-f]{64})/data", key)
    if match and digest != match[1]:
        raise ValueError("Blob content does not match its digest")


def inventory(client, bucket):
    return {
        obj["Key"]: (obj["Size"], obj["ETag"])
        for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket)
        for obj in page.get("Contents", [])
    }


def main():
    import boto3
    from botocore.config import Config

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="/secrets/read.json")
    parser.add_argument("--target", default="/data")
    parser.add_argument("--copy", action="store_true")
    args = parser.parse_args()
    cfg = json.loads(pathlib.Path(args.source).read_text())["storage"]["s3"]
    client = boto3.client(
        "s3",
        endpoint_url=cfg["regionendpoint"],
        region_name=cfg["region"],
        aws_access_key_id=cfg["accesskey"],
        aws_secret_access_key=cfg["secretkey"],
        config=Config(
            signature_version="s3v4", s3={"addressing_style": "path"}, retries={"max_attempts": 5}
        ),
    )
    before = inventory(client, cfg["bucket"])
    if not before:
        raise ValueError("Refusing empty source registry")
    target = pathlib.Path(args.target)
    for key in before:
        relative_key(key)
    required = sum(size for size, _ in before.values())
    free = shutil.disk_usage(target).free
    print(json.dumps({"objects": len(before), "bytes": required, "free_bytes": free}), flush=True)
    if not args.copy:
        return
    if free < required + 1024**3:
        raise ValueError("Insufficient disk space (copy plus 1 GiB reserve)")
    marker = target / ".migration-verified.json"
    if marker.exists():
        raise ValueError("Verified destination already exists; refusing to overwrite live storage")
    hashes = {}
    for key, (size, etag) in sorted(before.items()):
        dest = target / relative_key(key)
        if any(p.is_symlink() for p in [dest, *dest.parents]):
            raise ValueError("Symlink in destination")
        dest.parent.mkdir(parents=True, exist_ok=True)
        temp = dest.with_name(dest.name + ".migrating")
        result = client.get_object(Bucket=cfg["bucket"], Key=key, IfMatch=etag)
        if result["ContentLength"] != size:
            raise ValueError("Source size changed")
        h = hashlib.sha256()
        with result["Body"] as stream, temp.open("wb") as out:
            for chunk in iter(lambda: stream.read(1024**2), b""):
                out.write(chunk)
                h.update(chunk)
            out.flush()
            os.fsync(out.fileno())
        if temp.stat().st_size != size:
            raise ValueError("Incomplete object copy")
        check_blob(key, h.hexdigest())
        with temp.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != h.hexdigest():
                raise ValueError("Filesystem read-back mismatch")
        os.replace(temp, dest)
        hashes[key] = h.hexdigest()
    if inventory(client, cfg["bucket"]) != before:
        raise ValueError("Source changed during migration; destination not marked verified")
    report = {"objects": len(before), "bytes": required, "sha256": hashes}
    temp = marker.with_suffix(".tmp")
    with temp.open("w") as out:
        json.dump(report, out)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp, marker)
    print(json.dumps({"verified_objects": len(before), "verified_bytes": required}), flush=True)


if __name__ == "__main__":
    main()
