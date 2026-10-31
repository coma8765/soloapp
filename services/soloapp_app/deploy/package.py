#!/usr/bin/env python3
"""Package static ES modules with a release-scoped base, never inline secrets."""

import argparse
import io
import sys
import tarfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "libs"))
from storage.release import revision, unpack

p = argparse.ArgumentParser()
p.add_argument("revision", type=revision)
p.add_argument("output", type=Path)
args = p.parse_args()
public = Path(__file__).resolve().parents[1] / "public"
with tarfile.open(args.output, "w:gz") as archive:
    for path in sorted(public.rglob("*")):
        if not path.is_file() or path.is_symlink() or path.suffix == ".gz":
            continue
        name = path.relative_to(public).as_posix()
        data = path.read_bytes()
        if path.suffix == ".html":
            text = data.decode().replace(
                "<head>", f'<head>\n  <base href="/web/releases/{args.revision}/">'
            )
            text = text.replace('src="/', 'src="').replace('href="/client/', 'href="client/')
            data = text.encode()
        info = tarfile.TarInfo(name)
        info.size = len(data)
        info.mode = 0o644
        info.mtime = 0
        archive.addfile(info, io.BytesIO(data))
files, _ = unpack(args.output.read_bytes(), args.revision)
print(f"Packaged {len(files)} static assets")
