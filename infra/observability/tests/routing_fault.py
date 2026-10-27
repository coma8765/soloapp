"""Test routing telemetry while draining only one ingress; restore with finally + watchdog."""

import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "operations"))
from remote import ROOT, run

OUTPUT = ROOT / "outputs/routing-fault.json"
cloud = json.loads((ROOT / "infra/cloud/resources.json").read_text())


def target_states():
    return json.loads(
        subprocess.check_output(
            [
                "yc",
                "load-balancer",
                "network-load-balancer",
                "target-states",
                cloud["nlb"],
                "--target-group-id",
                cloud["target_group"],
                "--format",
                "json",
            ],
            text=True,
        )
    )


def wait_nlb(status):
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        rows = target_states()
        assert next(r for r in rows if r["address"] == "10.131.0.27")["status"] == "HEALTHY", (
            "The other ingress must remain healthy"
        )
        if next(r for r in rows if r["address"] == "10.130.0.31")["status"] == status:
            return rows
        time.sleep(2)
    raise TimeoutError("NLB did not reach " + status)


def observe(condition):
    queries = {
        "nlb": 'soloapp_nlb_target_state{ingress="yc",state="'
        + ("UNHEALTHY" if condition == "down" else "HEALTHY")
        + '"} == 1',
        "ha": 'haproxy_server_status{ingress="yc",proxy="auth_sites",server="home",state="'
        + ("DOWN" if condition == "down" else "UP")
        + '"} == 1',
        "reason": 'haproxy_server_check_status{ingress="yc",proxy="auth_sites",server="home",state="'
        + ("L7TOUT" if condition == "down" else "L7OK")
        + '"} == 1',
    }
    code = """import json,urllib.request,urllib.parse,base64,time
from pathlib import Path
pw=Path('/run/soloapp-secrets/data/admin-password').read_text().strip()
h={'Authorization':'Basic '+base64.b64encode(('admin:'+pw).encode()).decode()}
result={}
for name,q in QUERIES.items():
 u='http://127.0.0.1:3000/grafana/api/datasources/proxy/uid/prometheus/api/v1/query?'+urllib.parse.urlencode({'query':q})
 with urllib.request.urlopen(urllib.request.Request(u,headers=h),timeout=10) as r:data=json.load(r)
 result[name]=data['data']['result']
print(json.dumps(result))
""".replace("QUERIES", repr(queries))
    results = {}
    for host in ("yc", "home"):
        r = run(
            host,
            "k3s kubectl -n observability exec -i deployment/grafana -c refresh-secrets -- python3 - <<'QUERY'\n"
            + code
            + "\nQUERY",
            capture=True,
        )
        results[host] = json.loads(r.stdout)
    return results


def wait_telemetry(condition):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        result = observe(condition)
        if all(
            {v["metric"]["observer"] for v in rows} == {"yc", "home"}
            for site in result.values()
            for rows in site.values()
        ):
            return result
        time.sleep(2)
    raise TimeoutError("Telemetry did not reach " + condition + " " + json.dumps(result))


def install(name):
    run(
        "yc",
        "cat /run/solo-routing-test/"
        + name
        + " > /opt/hack-vk-26/ingress/haproxy.cfg\ndocker kill --signal=USR2 solo-ingress >/dev/null\n",
    )


report = {}
try:
    assert all(r["status"] == "HEALTHY" for r in target_states())
    # Config and backup contain paths only, no secret payloads.
    prepare = """install -d -m 700 /run/solo-routing-test
cp /opt/hack-vk-26/ingress/haproxy.cfg /run/solo-routing-test/original
python3 - <<'PREP'
from pathlib import Path
p=Path('/run/solo-routing-test')
s=(p/'original').read_text()
drain=s.replace('  acl ready path /healthz','  acl ready path /healthz\\n  http-request return status 503 content-type text/plain string routing-test if ready')
(p/'drained').write_text(drain)
lines=[];section=''
for line in drain.splitlines():
 if line.startswith('backend '):section=line.split()[1]
 if section=='auth_sites' and line.startswith('  server home '):line+=' addr 127.0.0.1 port 19999'
 lines.append(line)
lines += ['frontend routing_test_stall','  bind 127.0.0.1:19999','  mode tcp','  tcp-request inspect-delay 15s','  tcp-request content reject if WAIT_END']
(p/'fault').write_text('\\n'.join(lines)+'\\n')
PREP
docker run --rm --user 10002:10002 --network host -v /run/solo-routing-test/fault:/usr/local/etc/haproxy/haproxy.cfg:ro -v /run/soloapp-ingress:/run/soloapp-ingress:ro haproxy:3.0-alpine haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
cat > /run/solo-routing-test/restore.sh <<'RESTORE'
#!/bin/bash
cat /run/solo-routing-test/original > /opt/hack-vk-26/ingress/haproxy.cfg
docker kill --signal=USR2 solo-ingress >/dev/null
RESTORE
chmod 700 /run/solo-routing-test/restore.sh
systemd-run --unit=solo-routing-test-restore --on-active=120s /bin/bash /run/solo-routing-test/restore.sh
"""
    run("yc", prepare)
    install("drained")
    report["drained"] = wait_nlb("UNHEALTHY")
    start = time.monotonic()
    install("fault")
    report["down"] = wait_telemetry("down")
    report["down_visible_seconds"] = round(time.monotonic() - start, 2)
finally:
    run(
        "yc",
        "if test -f /run/solo-routing-test/restore.sh; then bash /run/solo-routing-test/restore.sh; fi\nsystemctl stop solo-routing-test-restore.timer 2>/dev/null || true\n",
        check=False,
    )
start = time.monotonic()
report["restored"] = wait_nlb("HEALTHY")
report["up"] = wait_telemetry("up")
report["recovery_visible_seconds"] = round(time.monotonic() - start, 2)
OUTPUT.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({k: v for k, v in report.items() if k.endswith("_seconds")}))
