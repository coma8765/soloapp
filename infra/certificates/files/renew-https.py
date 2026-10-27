#!/usr/bin/env python3
import pathlib,os,json,urllib.request,subprocess,tarfile,io,base64,time
root=pathlib.Path('/run/soloapp-acme');root.mkdir(mode=0o700,exist_ok=True)
cfg=json.loads(pathlib.Path('/opt/hack-vk-26/acme-cloud.json').read_text())
def req(url,body=None):
 h={'Authorization':'Bearer '+token,'Content-Type':'application/json'}
 with urllib.request.urlopen(urllib.request.Request(url,data=json.dumps(body).encode() if body else None,headers=h),timeout=30) as r:return json.load(r)
r=urllib.request.Request('http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',headers={'Metadata-Flavor':'Google'})
with urllib.request.urlopen(r,timeout=10) as f:token=json.load(f)['access_token']
if not (root/'renewal').exists():
 p=req('https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/'+cfg['state']+'/payload');encoded=next(x['textValue'] for x in p['entries'] if x['key']=='archive')
 with tarfile.open(fileobj=io.BytesIO(base64.b64decode(encoded)),mode='r:gz') as t:
  for m in t.getmembers():
   target=(root/m.name).resolve()
   if not str(target).startswith(str(root)+'/') and target!=root:raise RuntimeError('Invalid archive path')
   if not (m.isdir() or m.isfile() or m.issym()):raise RuntimeError('Invalid archive member')
   if m.issym() and not str((target.parent/m.linkname).resolve()).startswith(str(root)+'/'):raise RuntimeError('Invalid archive link')
  t.extractall(root)
cert=root/'live'/cfg['domain']/'fullchain.pem'
before=cert.read_bytes()
args=['docker','run','--rm','--network','host','-v',str(root)+':/etc/letsencrypt','-v','/var/lib/solo-acme:/var/lib/solo-acme','--tmpfs','/var/log/letsencrypt','--tmpfs','/var/lib/letsencrypt','certbot/certbot:v4.0.0','renew','--webroot','--webroot-path','/var/lib/solo-acme','--non-interactive','--no-random-sleep-on-renew']
if os.environ.get('DRY_RUN'):args.append('--dry-run')
subprocess.run(args,check=True)
def update(sid,entries):
 op=req('https://lockbox.api.cloud.yandex.net/lockbox/v1/secrets/'+sid+':addVersion',{'payloadEntries':[{'key':k,'textValue':v} for k,v in entries.items()]})
 while not op.get('done'):
  time.sleep(1);op=req('https://operation.api.cloud.yandex.net/operations/'+op['id'])
 if op.get('error'):raise RuntimeError('Lockbox renewal storage failed')
if cert.read_bytes()!=before:
 update(cfg['https'],{'fullchain.pem':cert.read_text(),'privkey.pem':(cert.parent/'privkey.pem').read_text()})
 buf=io.BytesIO()
 with tarfile.open(fileobj=buf,mode='w:gz') as t:t.add(root,arcname='.')
 update(cfg['state'],{'archive':base64.b64encode(buf.getvalue()).decode()})
 subprocess.run(['systemctl','start','solo-ingress-secrets'],check=True)
print('HTTPS renewal check complete')
