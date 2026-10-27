"""Verify that a probe-only network fault is observed in both monitoring stores."""
import sys,json,time,shlex
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'operations'))
from remote import run, ROOT

def query(host, expr):
    code='''import json,urllib.request,urllib.parse,base64
from pathlib import Path
password=Path('/run/soloapp-secrets/data/admin-password').read_text().strip()
headers={'Authorization':'Basic '+base64.b64encode(('admin:'+password).encode()).decode()}
url='http://127.0.0.1:3000/grafana/api/datasources/proxy/uid/prometheus/api/v1/query?'+urllib.parse.urlencode({'query':EXPR})
with urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=10) as r: print(json.dumps(json.load(r)['data']['result']))
'''.replace('EXPR',repr(expr))
    out=run(host,"k3s kubectl -n observability exec -i deployment/grafana -c refresh-secrets -- python3 - <<'QUERY'\n"+code+"\nQUERY\n",capture=True)
    return json.loads(out.stdout)
code='''python3 - <<'PODS'
import json,subprocess
result={}
for ns,app in [('observability','alloy'),('soloapp','auth')]:
 p=json.loads(subprocess.check_output(['k3s','kubectl','-n',ns,'get','pods','-l','app='+app,'-o','json']))['items'][0]
 result[app]={'ip':p['status']['podIP'],'name':p['metadata']['name']}
print(json.dumps(result))
PODS
'''
pods=json.loads(run('yc',code,capture=True).stdout)
rule=['-s',pods['alloy']['ip'],'-d',pods['auth']['ip'],'-p','tcp','--dport','19082','-m','comment','--comment','soloapp-probe-test','-j','REJECT','--reject-with','tcp-reset']
restore=shlex.join(['iptables','-D','FORWARD',*rule])+' 2>/dev/null || true'
unit='soloapp-probe-restore-'+str(int(time.time()))
selector='{dc="yc",pod='+json.dumps(pods['auth']['name'])+',check="healthz"}'
report={'pod':pods['auth']['name']}
try:
    run('yc',shlex.join(['systemd-run','--unit='+unit,'--on-active=120s','/bin/sh','-c',restore])+'\n'+shlex.join(['iptables','-I','FORWARD','1',*rule])+'\n',capture=True)
    start=time.monotonic()
    for _ in range(12):
        values={h:query(h,'probe_success'+selector) for h in ('yc','home')}
        if all(len(v)==1 and float(v[0]['value'][1])==0 for v in values.values()):break
        time.sleep(1)
    else:raise RuntimeError('Probe failure did not reach both stores')
    for h in ('yc','home'):
        status=query(h,'probe_http_status_code'+selector)
        assert len(status)==1 and float(status[0]['value'][1])==0,status
    report['failure_visible_in_both_stores_seconds']=round(time.monotonic()-start,2)
finally:
    run('yc',restore+'\nsystemctl stop '+unit+'.timer\n',capture=True)
start=time.monotonic()
for _ in range(12):
    values={h:query(h,'probe_success'+selector) for h in ('yc','home')}
    if all(len(v)==1 and float(v[0]['value'][1])==1 for v in values.values()):break
    time.sleep(1)
else:raise RuntimeError('Probe did not recover in both stores')
report['recovery_visible_in_both_stores_seconds']=round(time.monotonic()-start,2)
print(json.dumps(report))
(ROOT/'outputs/dashboard-probe-fault.json').write_text(json.dumps(report,indent=2)+'\n')
