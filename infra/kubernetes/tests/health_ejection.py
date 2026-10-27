"""Isolate only one auth pod from PostgreSQL; watchdog and finally undo all rules."""
import json, subprocess, time, shlex

def cmd(*args):
    return subprocess.check_output(args,text=True)
def kube(*args):
    return cmd('k3s','kubectl','-n','soloapp',*args)
items=json.loads(kube('get','pods','-l','app=auth','-o','json'))['items']
assert len(items)==2 and all(all(c['ready'] for c in p['status']['containerStatuses']) for p in items)
pod=items[0]['metadata']['name']; ip=items[0]['status']['podIP']
restarts=sum(c['restartCount'] for c in items[0]['status']['containerStatuses'])
args=['-s',ip,'-p','tcp','-m','multiport','--dports','5432,55432','-m','comment','--comment','soloapp-health-test','-j','REJECT','--reject-with','tcp-reset']
restore='\n'.join(shlex.join(['iptables','-D',chain,*args])+' 2>/dev/null || true' for chain in ('INPUT','FORWARD'))
unit='soloapp-health-restore-'+str(int(time.time()))
cmd('systemd-run','--unit='+unit,'--on-active=120s','/bin/sh','-c',restore)

def status(path, post=False):
    script="""import urllib.request,urllib.error,json
req=urllib.request.Request('http://127.0.0.1:19082/'+PATH,data=(json.dumps({'username':'health.test.nonexistent','password':'health-test-password'}).encode() if POST else None),headers={'Content-Type':'application/json'})
try:
 with urllib.request.urlopen(req,timeout=5) as r: print(r.status)
except urllib.error.HTTPError as e: print(e.code)
""".replace('PATH',repr(path)).replace('POST',repr(post))
    return int(kube('exec',pod,'-c','auth','--','python3','-c',script).strip())

def endpoints():
    slices=json.loads(kube('get','endpointslice','-l','kubernetes.io/service-name=auth','-o','json'))
    return [ip for sl in slices['items'] for e in sl.get('endpoints',[]) if e.get('conditions',{}).get('ready') for ip in e['addresses']]

report={'pod':pod,'errors':[]}
try:
    for chain in ('INPUT','FORWARD'):cmd('iptables','-I',chain,'1',*args)
    for _ in range(3):report['errors'].append(status('auth/login',True))
    assert report['errors']==[503]*3, report
    start=time.monotonic()
    assert status('health/ready')==503
    assert status('healthz')==200
    removed=False
    for _ in range(20):
        ips=endpoints()
        if ip not in ips:
            assert len(ips)==1,ips
            removed=True;break
        time.sleep(.3)
    assert removed,'pod remained a ready EndpointSlice backend'
    report['excluded_after_threshold_seconds']=round(time.monotonic()-start,2)
    report['healthy_backend_count']=len(ips)
finally:
    subprocess.run(['/bin/sh','-c',restore],check=True)
    subprocess.run(['systemctl','stop',unit+'.timer'],check=True)
start=time.monotonic()
for _ in range(90):
    if ip in endpoints():break
    time.sleep(.5)
else:raise RuntimeError('pod did not return after cooldown')
report['returned_after_restore_seconds']=round(time.monotonic()-start,2)
assert status('health/ready')==200
assert status('healthz')==200
assert status('auth/login',True)==401
current=json.loads(kube('get','pod',pod,'-o','json'))
assert sum(c['restartCount'] for c in current['status']['containerStatuses'])==restarts
report['restarted']=False
print(json.dumps(report))
