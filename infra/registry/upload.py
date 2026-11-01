#!/usr/bin/env python3
"""Send only OCI blobs absent from the destination's persistent registry."""

import argparse
import json
import subprocess
import tarfile

from push import PROTOCOL, REPLY, load_archive


def transfer(archive, revision, command, force=False):
    tar, members, image, _, config = load_archive(archive)
    try:
        if (
            config.get("config", {}).get("Labels", {}).get("org.opencontainers.image.revision")
            != revision
        ):
            raise ValueError("OCI revision label must match approved commit")
        layers = {d["digest"]: d for d in image["layers"]}
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            process.stdin.write(PROTOCOL + json.dumps(list(layers.values())).encode() + b"\n")
            process.stdin.flush()
            for line in process.stdout:
                text = line.decode()
                if text.startswith(REPLY):
                    cached = json.loads(text[len(REPLY) :])
                    if not isinstance(cached, list) or any(
                        not isinstance(d, str) or d not in layers for d in cached
                    ):
                        raise ValueError("Invalid cached layer response")
                    break
                print(text, end="", flush=True)
            else:
                raise RuntimeError("Destination did not negotiate layer reuse")
            omitted = set() if force else {"blobs/sha256/" + d[7:] for d in cached}
            # Config is always transmitted and checked, even if shared with another descriptor.
            omitted.discard("blobs/sha256/" + image["config"]["digest"][7:])
            saved = sum(members[name].size for name in omitted)
            print(
                json.dumps(
                    {
                        "reused_layers": len(omitted),
                        "reused_bytes": saved,
                        "sent_blob_bytes": sum(
                            m.size for n, m in members.items() if n not in omitted
                        ),
                        "force_image_transfer": force,
                    }
                ),
                flush=True,
            )
            with tarfile.open(fileobj=process.stdin, mode="w|") as output:
                for name, member in members.items():
                    if name not in omitted:
                        with tar.extractfile(member) as content:
                            output.addfile(member, content)
            process.stdin.close()
            for line in process.stdout:
                print(line.decode(), end="", flush=True)
            if process.wait() != 0:
                raise RuntimeError("Image upload failed")
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait()
            process.stdout.close()
            try:
                process.stdin.close()
            except BrokenPipeError:
                pass
    finally:
        tar.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("SSH command is required")
    transfer(args.archive, args.revision, command, args.force)


if __name__ == "__main__":
    main()
