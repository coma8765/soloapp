"""Reversible inter-site partition test. SSH remains available; restores in finally
and through a 180-second host timer. Does not simulate loss of local disks.
"""

import json
import shlex
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "operations"))
from remote import ROOT, base_url, run

base = base_url()
restore = "iptables -D FORWARD -i wg-solo -j DROP 2>/dev/null || true; iptables -D FORWARD -o wg-solo -j DROP 2>/dev/null || true; iptables -D OUTPUT -o wg-solo -j DROP 2>/dev/null || true; iptables -D INPUT -i wg-solo -j DROP 2>/dev/null || true"


def health():
    try:
        with urllib.request.urlopen(base + "/grafana/api/health", timeout=4) as r:
            return {
                "status": r.status,
                "site": r.headers.get("X-Solo-Site"),
                "database": json.load(r).get("database"),
            }
    except Exception as e:
        return {"status": 0, "error": type(e).__name__}


probe = """import json,urllib.request,urllib.parse,base64
from pathlib import Path
p=Path('/run/soloapp-secrets/data/admin-password').read_text().strip()
h={'Authorization':'Basic '+base64.b64encode(('admin:'+p).encode()).decode()}
def get(path):
 with urllib.request.urlopen(urllib.request.Request(PUBLIC_GRAFANA_API+path,headers=h),timeout=15) as r:return json.load(r)
d=get('dashboards/uid/soloapp-overview');assert d['dashboard']['uid']=='soloapp-overview'
q='time() - max(timestamp(up{dc="SURVIVOR",job="alloy"}))'
m=get('datasources/proxy/uid/prometheus/api/v1/query?'+urllib.parse.urlencode({'query':q}))['data']['result']
assert m and float(m[0]['value'][1])<45,m
q='{dc="SURVIVOR",container="nginx"}'
l=get('datasources/proxy/uid/loki/loki/api/v1/query_range?'+urllib.parse.urlencode({'query':q,'limit':5}))['data']['result']
assert l,'No logs on surviving store'
print(json.dumps({'dashboard':True,'fresh_metrics_age_seconds':float(m[0]['value'][1]),'log_streams':len(l)}))
"""
report = {}
for failed, survivor in [("yc", "home"), ("home", "yc")]:
    print("ISOLATING", failed, flush=True)
    restore_unit = "solo-observability-restore-" + str(int(time.time()))
    run(
        failed,
        "systemd-run --unit="
        + restore_unit
        + " --on-active=180s /bin/sh -c "
        + shlex.quote(restore)
        + "\n"
        + "".join(
            "iptables -I " + chain + " 1 " + direction + " wg-solo -j DROP\n"
            for chain, direction in [
                ("INPUT", "-i"),
                ("OUTPUT", "-o"),
                ("FORWARD", "-i"),
                ("FORWARD", "-o"),
            ]
        ),
    )
    start = time.monotonic()
    samples = []
    try:
        while time.monotonic() - start < 40:
            h = health()
            h["seconds"] = round(time.monotonic() - start, 2)
            samples.append(h)
            time.sleep(0.5)
        for i in range(10):
            h = health()
            assert h.get("site") == survivor and h.get("database") == "ok", h
        cmd = (
            "k3s kubectl -n observability exec -i deployment/grafana -c refresh-secrets -- python3 - <<'VERIFY'\n"
            + probe.replace("SURVIVOR", survivor).replace(
                "PUBLIC_GRAFANA_API", repr(base + "/grafana/api/")
            )
            + "\nVERIFY\n"
        )
        r = run(survivor, cmd, capture=True, check=False)
        assert r.returncode == 0, r.stderr
        report[failed] = {
            "survivor": survivor,
            "samples": samples,
            "public_authenticated_queries": json.loads(r.stdout),
        }
        print(
            "PASS",
            failed,
            "isolated; public dashboard, fresh metrics and logs served by",
            survivor,
            flush=True,
        )
    finally:
        run(failed, restore + "\nsystemctl stop " + restore_unit + ".timer\n")
    for i in range(50):
        state = run(
            "edge",
            "docker exec solo-monitor pg_autoctl show state --pgdata /var/lib/postgresql/data\n",
            capture=True,
        ).stdout
        if (
            "primary" in state
            and "secondary" in state
            and "catchingup" not in state
            and "wait_primary" not in state
            and "!" not in state
        ):
            break
        time.sleep(3)
    else:
        raise RuntimeError("Postgres did not recover after " + failed)
    time.sleep(10)
(ROOT / "outputs/observability-failover.json").write_text(json.dumps(report, indent=2) + "\n")
print("BOTH DIRECTIONS VERIFIED", flush=True)
