import argparse,http.client,ssl,socket,json,time,secrets,threading,concurrent.futures
from pathlib import Path
import sys, urllib.parse
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'operations'))
from remote import base_url,host_config
p=argparse.ArgumentParser();p.add_argument('--seconds',type=int,default=900);p.add_argument('--output',required=True);p.add_argument('--stop-file',required=True);a=p.parse_args()
domain=urllib.parse.urlsplit(base_url()).hostname
class Connection(http.client.HTTPSConnection):
 def __init__(self,ip=None):super().__init__(domain,timeout=8,context=ssl.create_default_context());self.ip=ip
 def connect(self):self.sock=self._context.wrap_socket(socket.create_connection((self.ip or self.host,443),self.timeout),server_hostname=self.host)
def req(path,body=None,token=None,ip=None):
 c=Connection(ip);h={'Content-Type':'application/json'}
 if token:h['Authorization']='Bearer '+token
 try:
  c.request('POST' if body is not None else 'GET',path,body=json.dumps(body) if body is not None else None,headers=h);r=c.getresponse();data=r.read();return r.status,(json.loads(data or b'{}') if r.getheader('Content-Type','').startswith('application/json') else {}),r.getheader('X-Solo-Site')
 finally:c.close()
username='rolling_'+secrets.token_hex(8);password=secrets.token_hex(20)
s,b,_=req('/api/v1/auth/v1/register',{'username':username,'password':password});assert s==201,s;uid=b['user_id']
s,b,_=req('/api/v1/auth/v1/login',{'username':username,'password':password});assert s==200,s;token=b['access_token']
report={'started':time.time(),'requests':0,'failures':[],'targets':{},'max_latency_seconds':0};lock=threading.Lock();start=time.monotonic()
def worker(label,ip):
 while time.monotonic()-start<a.seconds and not Path(a.stop_file).exists():
  t=time.monotonic()
  try:
   status,body,site=req('/api/v1/whoami/v1/user-id',token=token,ip=ip);good=status==200 and body.get('user_id')==uid
  except Exception as e:status=type(e).__name__;good=False;site=None
  elapsed=time.monotonic()-t
  with lock:
   report['requests']+=1;report['targets'][label]=report['targets'].get(label,0)+1;report['max_latency_seconds']=max(report['max_latency_seconds'],round(elapsed,3))
   if not good:report['failures'].append({'at':round(time.monotonic()-start,3),'target':label,'status':status})
  time.sleep(.2)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
 fs=[ex.submit(worker,label,ip) for label,ip in [('public',None),('yc-ingress',host_config('yc')['ansible_host']),('edge-ingress',host_config('edge')['ansible_host'])]]
 while not all(f.done() for f in fs):
  time.sleep(5)
  with lock:Path(a.output).write_text(json.dumps(report,indent=2))
 for f in fs:f.result()
report['finished']=time.time();report['elapsed_seconds']=round(time.monotonic()-start,2)
Path(a.output).write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
raise SystemExit(bool(report['failures']))
