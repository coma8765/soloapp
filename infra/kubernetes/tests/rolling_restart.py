import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "operations"))
from remote import run

script = r"""python3 - <<'INNER'
import subprocess,time,json
k=['k3s','kubectl','-n','soloapp'];results=[]
for service in ('whoami','auth','nginx'):
 subprocess.run(k+['rollout','restart','deployment/'+service],check=True)
 started=time.monotonic();minimum=100;samples=0
 while time.monotonic()-started<240:
  d=json.loads(subprocess.check_output(k+['get','deployment',service,'-o','json']))
  slices=json.loads(subprocess.check_output(k+['get','endpointslices','-l','kubernetes.io/service-name='+service,'-o','json']))
  ready=sum(e.get('conditions',{}).get('ready',False) for x in slices['items'] for e in x.get('endpoints',[]));minimum=min(minimum,ready);samples+=1
  assert ready>=2,(service,'ready endpoints fell below 2',ready)
  s=d.get('status',{})
  if s.get('observedGeneration',0)>=d['metadata']['generation'] and s.get('updatedReplicas',0)==2 and s.get('availableReplicas',0)>=2 and s.get('replicas',0)==2:break
  time.sleep(1)
 else:raise RuntimeError('rollout timed out '+service)
 results.append({'service':service,'min_ready_endpoints':minimum,'samples':samples,'seconds':round(time.monotonic()-started,2)})
print('REPORT '+json.dumps(results))
INNER
"""
report = {}
for site in ("yc", "home"):
    result = run(site, script, capture=True)
    print(site, result.stdout, flush=True)
    report[site] = json.loads(
        next(x[7:] for x in result.stdout.splitlines() if x.startswith("REPORT "))
    )
    Path("outputs/rolling-update-endpoints.json").write_text(json.dumps(report, indent=2))
