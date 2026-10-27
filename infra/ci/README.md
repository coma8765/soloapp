# Required CI checks

Every push to any branch and every pull request runs `.github/workflows/ci.yaml`.
There are no path filters. GitHub validates the pushed head and the PR merge result;
commits that have not been pushed are checked locally using the commands below.

| Required job | Checks |
| --- | --- |
| `source` | OpenAPI/codegen drift, codegen policy tests, dashboard generation, Prometheus alert tests, CD/storage/registry tests, monitoring exporter and relay tests, secret/history scanning |
| `quality` | Python Ruff analysis/import style/format, C++ clang-format and Cppcheck, Worker Prettier/Oxlint, actionlint and embedded shellcheck |
| `services (auth)` | C++ Docker build, ODB codegen/compilation, unit and PostgreSQL/API testsuite |
| `app-api (NestJS)` | TypeScript build, Prettier, type-aware Oxlint, unit/e2e tests, production Docker image |
| `web` | Dart formatting, strict Flutter analyzer, widget tests, versioned production web build |
| `Required checks` | All five upstream jobs must succeed; failed, skipped, cancelled or missing jobs are rejected |

Generated sources are checked by regeneration, not manual formatters. ODB image buffers
are compiler-generated: Cppcheck excludes only their `uninitMemberVarNoCtor` diagnostic.
The standalone analysis supplies the ODB 2.4 version macros; the auth build separately
regenerates and compiles the real ORM output and runs PostgreSQL integration tests.

## Local checks

Use Python 3.12+, Node.js 24, Flutter 3.44.8, Cppcheck, actionlint and shellcheck.
Python formatter versions are pinned in `requirements.txt`; JavaScript tools use the
NestJS lockfile. Docker is needed for C++/ODB/PostgreSQL and Prometheus tests.

```sh
python3 -m venv .venv-quality
.venv-quality/bin/pip install -r infra/ci/requirements.txt
export PATH="$PWD/.venv-quality/bin:$PATH"
npm --prefix services/app-api ci
make check-quality                 # dart must be on PATH
make check-codegen test-codegen check-dashboards test-alerts
make test-auth test-app-api test-web
make public-check
```

`make check-python`, `make check-cpp`, `make check-javascript` and `make check-dart`
are independently runnable. To apply formatting: `python3 infra/ci/check.py python --fix`,
`python3 infra/ci/check.py cpp-format --fix`, `python3 infra/ci/check.py dart-format --fix`;
NestJS has `npm run format`. Formatting does not regenerate API contracts.

## Protected default branch

The repository uses `main` (there is no `master`). `branch-protection.yaml` requires a
pull request, all six GitHub Actions check contexts, an up-to-date branch and resolved
review conversations. It blocks force pushes/deletion and enforces checks for admins.
A peer approval is not required for this single-maintainer repository; PR/check gates are.

Preview the policy, then apply it with an administrator identity:

```sh
.venv-codegen/bin/python infra/ci/protect.py
.venv-codegen/bin/python infra/ci/protect.py --apply
```

The policy defaults to `coma8765/soloapp:main`; repository and branch are configurable.
A regression test keeps the workflow jobs, aggregate gate and required check names aligned.
Production deployment separately requires successful CI for current main. The recommended
flow is a service-scoped manual deployment; see [CD](../cd/README.md).
