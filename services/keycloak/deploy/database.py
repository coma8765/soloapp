"""Operator-only bootstrap of the dedicated TLS/SCRAM Keycloak database.

Credentials travel from Lockbox to psql stdin; they are never stored in SQL files.
"""

import importlib.util
import json
import re
import shlex
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "infra/operations"))
from remote import run  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "storage_bootstrap", ROOT / "infra/object-storage/bootstrap.py"
)
cloud_api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud_api)


def main():
    cloud = json.loads(cloud_api.STATE.read_text())
    entries = cloud_api.yc("lockbox", "payload", "get", cloud["secrets"]["keycloak-operator"])[
        "entries"
    ]
    values = {e["key"]: e.get("textValue", e.get("text_value")) for e in entries}
    password = values["database-password"]
    if not re.fullmatch("[a-f0-9]{64}", password):
        raise ValueError("Unexpected generated password format")
    primary = None
    for site in ("yc", "home"):
        r = run(
            site,
            "docker exec -u postgres solo-postgres psql -p 55432 -At -d postgres -c 'select pg_is_in_recovery()'",
            capture=True,
        )
        if r.stdout.strip() == "f":
            if primary:
                raise RuntimeError("More than one PostgreSQL primary")
            primary = site
    if not primary:
        raise RuntimeError("No writable PostgreSQL primary")
    sql = r"""SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET password_encryption = 'scram-sha-256';
SELECT format('CREATE ROLE keycloak LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 20 PASSWORD %L', 'PASSWORD_VALUE') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='keycloak') \gexec
SELECT 'CREATE DATABASE keycloak OWNER keycloak' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='keycloak') \gexec
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
""".replace("PASSWORD_VALUE", password)
    result = run(
        primary,
        "docker exec -i -u postgres solo-postgres psql -p 55432 -v ON_ERROR_STOP=1 -d postgres <<'KEYCLOAK_SQL'\n"
        + sql
        + "\nKEYCLOAK_SQL\n",
        capture=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError("Dedicated database provisioning failed (output withheld)")
    # Preserve existing certificate-only identities. Insert only this database/role's rules.
    edit = """import pathlib
p=pathlib.Path('/var/lib/postgresql/data/pg_hba.conf')
s=p.read_text()
marker='# BEGIN keycloak TLS SCRAM'
if marker not in s:
 rules=marker+'\\n'+''.join('hostssl keycloak keycloak '+cidr+' scram-sha-256\\n' for cidr in ['10.77.26.11/32','10.77.26.12/32','10.78.0.0/16','10.80.0.0/16'])+'# END keycloak TLS SCRAM\\n'
 anchor='host all all 0.0.0.0/0 reject'
 assert anchor in s
 p.write_text(s.replace(anchor,rules+anchor,1))
"""
    for site in ("yc", "home"):
        # Use host Python with the container's actual mounted directory, not a new image.
        script = "hba=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination \"/var/lib/postgresql\"}}{{.Source}}{{end}}{{end}}' solo-postgres)\n"
        script += 'test -n "$hba"\npython3 - "$hba/data/pg_hba.conf" <<\'EDIT_HBA\'\n'
        script += (
            edit.replace(
                "p=pathlib.Path('/var/lib/postgresql/data/pg_hba.conf')",
                "import sys\np=pathlib.Path(sys.argv[1])",
            )
            + "\nEDIT_HBA\n"
        )
        script += (
            "docker exec -u postgres solo-postgres psql -p 55432 -v ON_ERROR_STOP=1 -d postgres -Atc "
            + shlex.quote(
                "select pg_reload_conf(); select count(*) from pg_hba_file_rules where error is not null;"
            )
        )
        r = run(site, script, capture=True)
        if r.stdout.strip().splitlines() != ["t", "0"]:
            raise RuntimeError("HBA validation failed on " + site)
        print(site + ": dedicated Keycloak HBA valid")
    print("Dedicated Keycloak database initialized")


if __name__ == "__main__":
    main()
