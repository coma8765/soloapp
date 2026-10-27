import sys,json,time,secrets,urllib.request,urllib.error,shlex
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'operations'))
from remote import run,ROOT,base_url
restore='iptables -D OUTPUT -o wg-solo -j DROP 2>/dev/null || true; iptables -D INPUT -i wg-solo -j DROP 2>/dev/null || true'
run('edge',"systemd-run --unit=solo-edge-restore-"+str(int(time.time()))+" --on-active=120s /bin/sh -c "+shlex.quote(restore)+"\niptables -I INPUT 1 -i wg-solo -j DROP\niptables -I OUTPUT 1 -o wg-solo -j DROP\n")
samples=[];start=time.monotonic()
try:
 for i in range(12):
  req=urllib.request.Request(base_url()+'/auth/register',data=json.dumps({'username':'edge_'+secrets.token_hex(7),'password':secrets.token_hex(16)}).encode(),headers={'Content-Type':'application/json'})
  try:
   with urllib.request.urlopen(req,timeout=8) as r:status=r.status;r.read()
  except urllib.error.HTTPError as e:status=e.code
  except Exception:status=0
  samples.append({'seconds':round(time.monotonic()-start,2),'status':status});time.sleep(3)
 if not all(x['status']==201 for x in samples[-5:]):raise RuntimeError('Writes did not remain available with edge isolated')
finally:run('edge',restore+'\n')
(ROOT/'outputs/edge-failover.json').write_text(json.dumps(samples,indent=2));print(json.dumps(samples))
