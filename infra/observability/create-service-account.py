import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "operations"))
from remote import ROOT, run

config_path = ROOT / "infra/cloud/resources.json"
cloud = json.loads(config_path.read_text())
assert "grafana_automation" not in cloud, "Already configured"


def yc(*args):
    r = subprocess.run(
        ["yc", *args, "--format", "json", "--no-browser"],
        text=True,
        capture_output=True,
        check=True,
        stdin=subprocess.DEVNULL,
        timeout=90,
    )
    return json.loads(r.stdout or "{}")


code = """import urllib.request,urllib.error,json,base64,time,datetime,importlib.util
from pathlib import Path
SECRET_ID=SECRET_ID_VALUE
spec=importlib.util.spec_from_file_location('workload_secrets','/usr/local/bin/secret-fetch.py')
identity=importlib.util.module_from_spec(spec);spec.loader.exec_module(identity)
# Mint only the current pod's short-lived, scoped workload credential.
IAM=identity.iam()
base='http://127.0.0.1:3000/grafana/api/'
h={'Authorization':'Basic '+base64.b64encode(('admin:'+Path('/run/soloapp-secrets/data/admin-password').read_text().strip()).encode()).decode(),'Content-Type':'application/json'}
def request(url,body=None,method=None,headers=None):
 with urllib.request.urlopen(urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),headers=headers or h,method=method),timeout=20) as r:return json.load(r)
def api(path,body=None,method=None,headers=None):return request(base+path,body,method,headers)
def lockbox(url,body=None):return request(url,body,headers={'Authorization':'Bearer '+IAM,'Content-Type':'application/json'})
accounts=api('serviceaccounts/search?query=codex-observer')['serviceAccounts']
found=[a for a in accounts if a['name']=='codex-observer']
account=found[0] if found else api('serviceaccounts',{'name':'codex-observer','role':'Viewer','isDisabled':False})
assert account['role']=='Viewer' and not account['isDisabled']
token=api('serviceaccounts/'+str(account['id'])+'/tokens',{'name':'codex-'+str(int(time.time())),'secondsToLive':2592000})
try:
 bearer={'Authorization':'Bearer '+token['key']}
 assert api('dashboards/uid/soloapp-postgres',headers=bearer)['dashboard']['uid']=='soloapp-postgres'
 assert api('datasources/proxy/uid/prometheus/api/v1/query?query=pg_up',headers=bearer)['status']=='success'
 try:
  api('serviceaccounts/search',headers=bearer)
  raise RuntimeError('Unexpected administrative permissions')
 except urllib.error.HTTPError as e:assert e.code==403
 expiry=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=30)).isoformat()
 operation=lockbox('https://lockbox.api.cloud.yandex.net/lockbox/v1/secrets/'+SECRET_ID+':addVersion',{'description':'Grafana scoped Viewer token; 30-day expiry','payloadEntries':[{'key':'token','textValue':token['key']},{'key':'expires-at','textValue':expiry}]})
 for _ in range(30):
  if operation.get('done'):break
  time.sleep(1)
  operation=lockbox('https://operation.api.cloud.yandex.net/operations/'+operation['id'])
 assert operation.get('done') and 'error' not in operation, 'Lockbox operation did not complete'
 payload=lockbox('https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/'+SECRET_ID+'/payload')
 assert {v['key']:v['textValue'] for v in payload['entries']}['token']==token['key']
 print(json.dumps({'account_id':account['id'],'token_id':token['id'],'role':account['role'],'secret_id':SECRET_ID,'expires_at':expiry}))
except Exception:
 api('serviceaccounts/'+str(account['id'])+'/tokens/'+str(token['id']),method='DELETE')
 raise
"""
metadata = {"name": "codex-observer", "role": "Viewer", "sites": {}}
for host, identity_key in [("yc", "grafana-admin"), ("home", "grafana-admin-home")]:
    name = "soloapp-grafana-codex-" + host
    secret = yc(
        "lockbox",
        "secret",
        "create",
        "--name",
        name,
        "--description",
        "Grafana Viewer credential for Codex; " + host,
        "--deletion-protection",
        "--folder-id",
        cloud["folder"],
    )
    secret_id = secret["id"]
    account_id = cloud["identities"][identity_key]
    # Writer is limited to this new secret and removed even when bootstrap fails.
    yc(
        "lockbox",
        "secret",
        "add-access-binding",
        "--id",
        secret_id,
        "--role",
        "lockbox.payloadViewer",
        "--service-account-id",
        account_id,
    )
    yc(
        "lockbox",
        "secret",
        "add-access-binding",
        "--id",
        secret_id,
        "--role",
        "lockbox.editor",
        "--service-account-id",
        account_id,
    )
    try:
        remote = code.replace("SECRET_ID_VALUE", repr(secret_id))
        result = run(
            host,
            "k3s kubectl -n observability exec -i deployment/grafana -c refresh-secrets -- python3 - <<'CREATE'\n"
            + remote
            + "\nCREATE",
            capture=True,
        )
        metadata["sites"][host] = {**json.loads(result.stdout), "secret_name": name}
        (ROOT / "outputs/grafana-service-account.json").write_text(
            json.dumps(metadata, indent=2) + "\n"
        )
        print(host, "Viewer account and Lockbox storage verified", flush=True)
    finally:
        yc(
            "lockbox",
            "secret",
            "remove-access-binding",
            "--id",
            secret_id,
            "--role",
            "lockbox.editor",
            "--service-account-id",
            account_id,
        )
cloud["grafana_automation"] = metadata
config_path.write_text(json.dumps(cloud, indent=2) + "\n")
print(json.dumps(metadata, indent=2))
