"""Run site-specific read-only Grafana API checks without exporting credentials.

Tokens are fetched inside the Grafana pod using its projected workload identity.
Callers receive only the output of their check; do not print GRAFANA_HEADERS.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infra/operations"))
from remote import run


def run_grafana(host, script, check=True):
    config = json.loads((ROOT / "infra/cloud/resources.json").read_text())
    secret_id = config["grafana_automation"]["sites"][host]["secret_id"]
    prelude = """import importlib.util, json, urllib.request
_spec = importlib.util.spec_from_file_location('workload_secrets', '/usr/local/bin/secret-fetch.py')
_identity = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_identity)
_req = urllib.request.Request('https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/' + SECRET_ID + '/payload', headers={'Authorization': 'Bearer ' + _identity.iam()})
with urllib.request.urlopen(_req, timeout=15) as _response:
    _entries = {entry['key']: entry['textValue'] for entry in json.load(_response)['entries']}
GRAFANA_HEADERS = {'Authorization': 'Bearer ' + _entries.pop('token')}
del _entries, _req, _response
""".replace("SECRET_ID", repr(secret_id))
    command = (
        "k3s kubectl -n observability exec -i deployment/grafana -c refresh-secrets -- python3 - <<'GRAFANA_CHECK'\n"
        + prelude
        + script
        + "\nGRAFANA_CHECK\n"
    )
    return run(host, command, capture=True, check=check)
