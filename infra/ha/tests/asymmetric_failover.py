"""Lose only primary<->monitor connectivity; verify promotion and old-primary fencing."""
import sys,time,json,secrets,shlex,urllib.request,argparse
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'operations'))
from remote import ROOT,run,base_url
ap=argparse.ArgumentParser();ap.add_argument('--target-seconds',type=float,default=15);args=ap.parse_args()
def state(host):
 r=run(host,"timeout 3 docker exec -i solo-postgres psql -p 55432 -U postgres -At <<'SQL'\nselect case when pg_is_in_recovery() then 'standby' when current_setting('default_transaction_read_only')::boolean then 'promoted_read_only' else 'writable' end;\nSQL\n",capture=True,check=False)
 return r.stdout.strip() if r.returncode==0 else 'unavailable'
states={h:state(h) for h in ('yc','home')}
assert sorted(states.values())==['standby','writable'],states
primary=next(h for h,s in states.items() if s=='writable');standby=next(h for h,s in states.items() if s=='standby')
restore='iptables -D INPUT -i wg-solo -s 10.77.26.13 -j DROP 2>/dev/null || true; iptables -D OUTPUT -o wg-solo -d 10.77.26.13 -j DROP 2>/dev/null || true'
run(primary,'systemd-run --unit=solo-asymmetric-restore-'+str(int(time.time()))+' --on-active=90s /bin/sh -c '+shlex.quote(restore)+'\niptables -I INPUT 1 -i wg-solo -s 10.77.26.13 -j DROP\niptables -I OUTPUT 1 -o wg-solo -d 10.77.26.13 -j DROP\n')
start=time.monotonic();report={'old_primary':primary,'new_primary':standby,'samples':[]};promoted=False
try:
 while time.monotonic()-start<60:
  new=state(standby);old=state(primary);elapsed=round(time.monotonic()-start,3)
  report['samples'].append({'seconds':elapsed,'old':old,'new':new})
  if new=='writable':
   assert old!='writable','New primary accepts read-write sessions while old primary still accepts them'
   report['promotion_seconds']=elapsed;report['old_primary_fenced']=True;promoted=True;break
  time.sleep(.25)
 assert promoted,'Promotion not observed'
 body={'username':'asym_'+secrets.token_hex(8),'password':secrets.token_hex(24)}
 req=urllib.request.Request(base_url()+'/api/v1/auth/v1/register',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=8) as response:assert response.status==201
 report['write_confirmed_seconds']=round(time.monotonic()-start,3)
 (ROOT/'outputs/asymmetric-report.json').write_text(json.dumps(report,indent=2))
 print(json.dumps(report),flush=True)
finally:
 (ROOT/'outputs/asymmetric-report.json').write_text(json.dumps(report,indent=2))
 run(primary,restore+'\n')
for _ in range(60):
 s=run('edge','docker exec solo-monitor pg_autoctl show state --pgdata /var/lib/postgresql/data\n',capture=True).stdout
 if 'primary' in s and 'secondary' in s and 'catchingup' not in s and 'wait_primary' not in s and '!' not in s:break
 time.sleep(2)
else:raise RuntimeError('Replication did not recover')
assert report['promotion_seconds']<=args.target_seconds,'Promotion exceeded target'
assert report['write_confirmed_seconds']<=args.target_seconds,'Write recovery exceeded target'
print('PASS: asymmetric partition, old primary fenced, writes accepted, replication restored')
