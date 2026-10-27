#!/usr/bin/env python3
"""Run format/static checks over versioned project sources, never private work files."""

import argparse
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run(*command):
    subprocess.run(command, cwd=ROOT, check=True)


def sources(suffixes, roots):
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
    return [
        name
        for name in tracked
        if name
        and Path(name).suffix in suffixes
        and any(name.startswith(root + "/") for root in roots)
        and "generated" not in Path(name).parts
        and Path(ROOT / name).is_file()
    ]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("check", choices=["python", "cpp-format", "cpp-analysis", "dart-format"])
    parser.add_argument("--fix", action="store_true")
    args = parser.parse_args()
    if args.check == "python":
        files = sources({".py"}, ["infra", "libs", "services"])
        run("ruff", "check", *(["--fix"] if args.fix else []), *files)
        run("ruff", "format", *([] if args.fix else ["--check"]), *files)
    elif args.check.startswith("cpp-"):
        files = sources(
            {".cpp", ".hpp", ".h", ".cc"},
            [
                "libs/runtime",
                "services/auth/src",
                "services/auth/tests",
                "services/client-notify/src",
                "services/client-notify/tests",
                "services/whoami/src",
                "services/whoami/tests",
            ],
        )
        if args.check == "cpp-format":
            run("clang-format", *(["-i"] if args.fix else ["--dry-run", "--Werror"]), *files)
        else:
            # Analyze translation units; headers are checked in their actual include context.
            files = [name for name in files if Path(name).suffix in {".cpp", ".cc"}]
            run(
                "cppcheck",
                "--enable=warning,style,performance,portability",
                "--error-exitcode=1",
                "--inline-suppr",
                "--suppress=missingIncludeSystem",
                # ODB emits POD image buffers initialized by its generated runtime.
                "--suppress=uninitMemberVarNoCtor:*/src/generated/odb/*",
                "--std=c++17",
                "--template=gcc",
                "--library=posix",
                "-DODB_BOOST_VERSION=2040000",
                "-DODB_VERSION=20400UL",
                "-Ilibs",
                "-Iservices/auth/src",
                "-Iservices/whoami/src",
                *files,
            )
    else:
        files = sources({".dart"}, ["services/web/lib", "services/web/test"])
        run(
            "dart",
            "format",
            *([] if args.fix else ["--output=none", "--set-exit-if-changed"]),
            *files,
        )


if __name__ == "__main__":
    main()
