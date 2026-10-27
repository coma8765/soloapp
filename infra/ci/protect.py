#!/usr/bin/env python3
"""Apply the reviewed branch-protection policy with the operator's gh identity."""

import argparse
import json
import subprocess
from pathlib import Path

import yaml


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", default="coma8765/soloapp")
    parser.add_argument("--branch", default="main")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    policy = yaml.safe_load(Path(__file__).with_name("branch-protection.yaml").read_text())
    if not args.apply:
        print(json.dumps(policy, indent=2))
        return
    endpoint = f"repos/{args.repository}/branches/{args.branch}/protection"
    subprocess.run(
        ["gh", "api", "--method", "PUT", endpoint, "--input", "-"],
        input=json.dumps(policy),
        text=True,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    actual = json.loads(subprocess.check_output(["gh", "api", endpoint], text=True))
    assert actual["enforce_admins"]["enabled"]
    assert actual["required_status_checks"]["strict"]
    actual_checks = {
        (item["context"], item["app_id"]) for item in actual["required_status_checks"]["checks"]
    }
    expected_checks = {
        (item["context"], item["app_id"]) for item in policy["required_status_checks"]["checks"]
    }
    assert actual_checks == expected_checks
    assert "required_pull_request_reviews" in actual
    assert not actual["allow_force_pushes"]["enabled"] and not actual["allow_deletions"]["enabled"]
    print(
        f"{args.repository}:{args.branch}: PR and all required GitHub Actions checks enforced, including administrators"
    )


if __name__ == "__main__":
    main()
