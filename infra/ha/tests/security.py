"""Live scoped IAM, pod isolation and DB checks. Never prints secret values."""
import json,sys,shlex
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'operations'))
from remote import ROOT,run
cloud=json.loads((ROOT/'infra/cloud/resources.json').read_text());report=[]
for site in ('yc','home'):
 for service in ('auth','nginx','whoami'):
  forbidden=cloud['secrets']['ca'] if service=='auth' else cloud['secrets']['auth-'+site]
  code="""import importlib.machinery,urllib.error
f=importlib.machinery.SourceFileLoader('fetch','/usr/local/bin/secret-fetch.py').load_module()
t=f.iam()
try:
 f.request('https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/'+FORBIDDEN+'/payload',headers={'Authorization':'Bearer '+t})
 raise SystemExit('Unexpected access to another identity secret')
except urllib.error.HTTPError as e: assert e.code==403,e.code
print('Scoped Lockbox access verified')
""".replace('FORBIDDEN',repr(forbidden))
  r=run(site,'k3s kubectl -n soloapp exec -i deployment/'+service+' -c refresh-secrets -- python3 - <<\'CHECK\'\n'+code+'\nCHECK\n',capture=True)
  assert 'Scoped Lockbox access verified' in r.stdout;report.append({'site':site,'service':service,'scoped_iam':True})
 code="""import urllib.request,urllib.error,socket
for target in [('169.254.169.254',80),('auth.soloapp.svc.cluster.local',19082)]:
 try:
  s=socket.create_connection(target,2);s.close();raise AssertionError('Forbidden connection succeeded: '+str(target))
 except (TimeoutError,ConnectionRefusedError,OSError):pass
print('Metadata and direct auth denied')
try:urllib.request.urlopen('http://127.0.0.1:8080/api/v1/whoami/v1/user-id',timeout=2);raise AssertionError('unsigned request accepted')
except urllib.error.HTTPError as e:assert e.code==401,e.code
print('Unsigned identity denied: 401')
"""
 r=run(site,"k3s kubectl -n soloapp exec -i deployment/whoami -c whoami -- python3 - <<'CHECK'\n"+code+"\nCHECK\ndocker exec solo-postgres psql -p 55432 -U postgres -Atc \"select count(*) from pg_hba_file_rules where auth_method='trust'\"\n",capture=True)
 assert 'Metadata and direct auth denied' in r.stdout and 'Unsigned identity denied: 401' in r.stdout and r.stdout.rstrip().endswith('0'),r.stdout
 report.append({'site':site,'metadata_denied':True,'unauthorized_service_denied':True,'unsigned_user_id_denied':True,'trust_hba_rules':0})
 print(site,'isolation checks passed',flush=True)
(ROOT/'outputs/security-report.json').write_text(json.dumps(report,indent=2))
