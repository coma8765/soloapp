# Public source publication

The public source repository is https://github.com/coma8765/soloapp, branch `main`.

Excluded from publication: `.secrets/`, `.env*`, local inventory/cloud configuration, work/, outputs/, build archives, Python environments and historical migrations. Those files remain on the operator workstation. Use `inventory.example.yaml` and `resources.example.json` after a fresh clone. Do not upload an archive of the whole working directory.

```sh
make check-codegen test-codegen public-check
git status --short
git add .
make public-check  # checks the staged snapshot as well as current files
# Review the staged files, then create the initial commit with your own Git identity.
```

`infra/publication/check.py` constructs an isolated candidate snapshot from Git's tracked/untracked non-ignored files, refuses sensitive paths and symlinks, and runs Gitleaks with full redaction. It also scans the exact Git index when staged files exist. Local exclusions do not mask a sensitive file already in the index. Existing commit history is checked by Gitleaks when present. No scanner uploads the source to a service.

GitHub Actions checks codegen/tests and scans committed content/history with read-only repository permissions. A separate production workflow deploys only green main commits, using environment-scoped, forced-command SSH identities. It does not run fault-injection tests or publish images. See infra/cd/README.md for the trust boundary and rotation procedure. Enable secret scanning/push protection and private vulnerability reporting in repository settings.

The original code is Apache-2.0. Read THIRD_PARTY_NOTICES.md before distributing binaries, especially the ODB runtime licensing section.
