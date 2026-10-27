"""Verify mTLS identity boundaries without extracting private keys from pods."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "operations"))
from remote import ROOT, run

report = {}
for host, ip, cn in [
    ("yc", "10.77.26.11", "observability-gateway"),
    ("home", "10.77.26.12", "observability-gateway-home"),
]:
    results = {}
    for namespace, deployment, path in [
        ("observability", "alloy", "/grafana/"),
        ("soloapp", "nginx", "/api/v1/write"),
    ]:
        code = (
            """import ssl,socket,http.client
ctx=ssl.create_default_context(cafile='/run/soloapp-secrets/data/ca.crt')
ctx.load_cert_chain('/run/soloapp-secrets/data/tls.crt','/run/soloapp-secrets/data/tls.key')
sock=ctx.wrap_socket(socket.create_connection((IP,31981),timeout=5),server_hostname=CN)
c=http.client.HTTPConnection(CN);c.sock=sock;c.request('GET',PATH);r=c.getresponse()
assert r.status==403,r.status
print(r.status)
""".replace("IP", repr(ip))
            .replace("CN", repr(cn))
            .replace("PATH", repr(path))
        )
        cmd = (
            "k3s kubectl -n "
            + namespace
            + " exec -i deployment/"
            + deployment
            + " -c refresh-secrets -- python3 - <<'CHECK'\n"
            + code
            + "\nCHECK\n"
        )
        r = run(host, cmd, capture=True, check=False)
        assert r.returncode == 0, r.stderr
        results[deployment + " denied " + path] = int(r.stdout)
    report[host] = results
(ROOT / "outputs/observability-security.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
for host, ip in [("yc", "10.77.26.11"), ("home", "10.77.26.12")]:
    code = """import urllib.request,urllib.error,ssl,pathlib,json
ctx=ssl.create_default_context(cafile='/var/run/secrets/kubernetes.io/serviceaccount/ca.crt')
token=pathlib.Path('/var/run/secrets/kubernetes.io/serviceaccount/token').read_text().strip()
results={}
for path,expected in [('/metrics/cadvisor',200),('/configz',403)]:
 req=urllib.request.Request('https://IP:10250'+path,headers={'Authorization':'Bearer '+token})
 try:
  with urllib.request.urlopen(req,context=ctx,timeout=8) as r:status=r.status;r.read()
 except urllib.error.HTTPError as e:status=e.code
 assert status==expected,(path,status)
 results[path]=status
print(json.dumps(results))
""".replace("IP", ip)
    r = run(
        host,
        "k3s kubectl -n observability exec -i deployment/alloy -c refresh-secrets -- python3 - <<'CHECK'\n"
        + code
        + "\nCHECK\n",
        capture=True,
        check=False,
    )
    assert r.returncode == 0, r.stderr
    report[host]["kubelet"] = json.loads(r.stdout)
    r = run(
        host,
        "k3s kubectl auth can-i get nodes/solo-"
        + host
        + " --subresource=proxy --as=system:serviceaccount:observability:alloy\n",
        capture=True,
        check=False,
    )
    assert r.returncode == 1 and r.stdout.strip() == "no", r.stdout
    report[host]["node_proxy_allowed"] = False
(ROOT / "outputs/observability-security.json").write_text(json.dumps(report, indent=2) + "\n")
print("Kubelet metrics-only authorization verified on both sites")
