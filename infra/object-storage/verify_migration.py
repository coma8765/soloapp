"""Compare all S3 object versions before/after runtime migration (no keys in output)."""

import argparse
import hashlib
import json
from pathlib import Path


def main():
    import boto3
    from botocore.config import Config

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("endpoint")
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    cfg = json.loads(Path("/secrets/admin.json").read_text())
    client = boto3.client(
        "s3",
        endpoint_url=args.endpoint,
        region_name="us-east-1",
        aws_access_key_id=cfg["access_key"],
        aws_secret_access_key=cfg["secret_key"],
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )
    inventory = {}
    for bucket in client.list_buckets()["Buckets"]:
        name = bucket["Name"]
        entries = {}
        for page in client.get_paginator("list_object_versions").paginate(Bucket=name):
            for obj in page.get("Versions", []):
                response = client.get_object(
                    Bucket=name, Key=obj["Key"], VersionId=obj["VersionId"]
                )
                digest = hashlib.sha256()
                with response["Body"] as body:
                    for chunk in iter(lambda: body.read(1024**2), b""):
                        digest.update(chunk)
                key = json.dumps([obj["Key"], obj["VersionId"]])
                entries[key] = {
                    "sha256": digest.hexdigest(),
                    "size": obj["Size"],
                    "latest": obj["IsLatest"],
                }
            for obj in page.get("DeleteMarkers", []):
                key = json.dumps([obj["Key"], obj["VersionId"]])
                entries[key] = {"deleted": True, "latest": obj["IsLatest"]}
        inventory[name] = {
            "versioning": client.get_bucket_versioning(Bucket=name).get("Status"),
            "objects": entries,
        }
    if not inventory or not any(b["objects"] for b in inventory.values()):
        raise ValueError("Refusing empty inventory")
    snapshot = Path(args.snapshot)
    if args.verify:
        if json.loads(snapshot.read_text()) != inventory:
            raise ValueError("Object versions or content changed")
    else:
        with snapshot.open("x") as out:
            json.dump(inventory, out, sort_keys=True)
        snapshot.chmod(0o600)
    print(
        json.dumps(
            {
                "buckets": len(inventory),
                "versions": sum(len(b["objects"]) for b in inventory.values()),
                "verified": args.verify,
            }
        )
    )


if __name__ == "__main__":
    main()
