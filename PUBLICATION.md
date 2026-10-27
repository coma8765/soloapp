# Public source publication

The local Git repository is prepared on branch `main`; creation of a GitHub remote and pushing are separate operator actions.

Excluded from publication: `.secrets/`, `.env*`, local inventory/cloud configuration, work/, outputs/, build archives, Python environments and historical migrations. Those files remain on the operator workstation. Use `inventory.example.yaml` and `resources.example.json` after a fresh clone. Do not upload an archive of the whole working directory.

```sh
make check-codegen test-codegen public-check
git status --short
git add .
make public-check  # checks the staged snapshot as well as current files
# Review the staged files, then create the initial commit with your own Git identity.
```

`infra/publication/check.py` constructs an isolated candidate snapshot from Git's tracked/untracked non-ignored files, refuses sensitive paths and symlinks, and runs Gitleaks with full redaction. It also scans the exact Git index when staged files exist. Local exclusions do not mask a sensitive file already in the index. Existing commit history is checked by Gitleaks when present. No scanner uploads the source to a service.

GitHub Actions checks codegen/tests and scans committed content/history. It has read-only repository permissions; it does not access production credentials, deploy infrastructure, run fault-injection tests or publish images. Enable GitHub secret scanning/push protection and private vulnerability reporting in repository settings after creation if available.

The original code is Apache-2.0. Read THIRD_PARTY_NOTICES.md before distributing binaries, especially the ODB runtime licensing section.
