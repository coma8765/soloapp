#!/usr/bin/env python3
"""Publish a verified immutable bundle to the independent Mac S3 only."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from credentials import bundle

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "libs"))
from storage.release import revision, unpack

p = argparse.ArgumentParser()
p.add_argument("revision", type=revision)
p.add_argument("archive", type=Path)
p.add_argument("--endpoint", default="http://127.0.0.1:18333")
a = p.parse_args()
files, manifest = unpack(a.archive.read_bytes(), a.revision)
value = bundle()
s3 = boto3.client(
    "s3",
    endpoint_url=a.endpoint,
    aws_access_key_id=value["s3_access"],
    aws_secret_access_key=value["s3_secret"],
    region_name="us-east-1",
    config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
)
bucket = "soloapp-web"
try:
    s3.head_bucket(Bucket=bucket)
except ClientError as e:
    if e.response["ResponseMetadata"]["HTTPStatusCode"] != 404:
        raise
    s3.create_bucket(Bucket=bucket)
prefix = f"releases/{a.revision}/"
try:
    old = s3.get_object(Bucket=bucket, Key=prefix + "_release.json")["Body"].read()
    if old != manifest:
        raise ValueError("Immutable revision already contains a different bundle")
except ClientError as e:
    if e.response["ResponseMetadata"]["HTTPStatusCode"] != 404:
        raise
for name, data in {**files, "_release.json": manifest}.items():
    s3.put_object(Bucket=bucket, Key=prefix + name, Body=data)
    copy = s3.get_object(Bucket=bucket, Key=prefix + name)["Body"].read()
    if hashlib.sha256(copy).digest() != hashlib.sha256(data).digest():
        raise ValueError("Read-back mismatch")
s3.put_object(Bucket=bucket, Key=prefix + "committed.json", Body=manifest)
print(
    json.dumps(
        {"revision": a.revision, "files": len(files), "contour": "mac", "copies_verified": 1}
    )
)
