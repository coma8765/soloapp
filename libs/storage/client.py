"""Small shared S3 client factory. Credentials are re-read from a tmpfs file."""

import json
from pathlib import Path

import boto3
from botocore.config import Config


def clients(path):
    config = json.loads(Path(path).read_text())
    return config["bucket"], [
        boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=config["access_key"],
            aws_secret_access_key=config["secret_key"],
            region_name="us-east-1",
            config=Config(
                signature_version="s3v4",
                connect_timeout=2,
                read_timeout=8,
                retries={"max_attempts": 1},
                s3={"addressing_style": "path"},
            ),
        )
        for endpoint in config["endpoints"]
    ]
