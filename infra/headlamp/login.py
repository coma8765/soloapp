#!/usr/bin/env python3
"""Issue a one-hour operator token through SSH; copy to the macOS clipboard."""

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "operations"))
from remote import run  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", choices=["yc", "home"])
    args = parser.parse_args()
    result = run(
        args.site,
        "k3s kubectl -n observability create token headlamp-operator --duration=1h",
        capture=True,
        check=False,
    )
    if result.returncode:
        raise SystemExit(
            "Token issuance failed; check operator SSH access and Headlamp installation."
        )
    token = result.stdout.strip()
    if len(token.split(".")) != 3:
        raise SystemExit("Unexpected response; nothing copied.")
    subprocess.run(["pbcopy"], input=token, text=True, check=True)
    print(
        f"{args.site}: token copied to clipboard (1 hour). Paste into the matching Headlamp cluster."
    )
    print("Clear the clipboard after login: pbcopy </dev/null")


if __name__ == "__main__":
    main()
