"""Check provisioned dashboards and actual data on each independent store.
Runs read-only API requests with a Viewer token fetched from Lockbox inside each pod.
"""
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'operations'))
from remote import ROOT
sys.path.insert(0,str(ROOT))
from libs.monitoring.grafana import run_grafana
dashboards=[]
queries=[]
for name in ('soloapp','auth','whoami','nginx','infrastructure','routing','postgres'):
 dashboard=json.loads((ROOT/('infra/observability/dashboards/'+name+'.json')).read_text())
 dashboards.append({'uid':dashboard['uid'],'panels':len(dashboard['panels'])})
 for panel in dashboard['panels']:
  for t in panel['targets']:
   expr=t['expr'].replace('$__rate_interval','2m').replace('$__range','1h').replace('$dc','.+').replace('$pod',(name+'-.+') if name in ('auth','whoami','nginx') else '.+').replace('$route','.*').replace('$search','.*').replace('$ingress','.+').replace('$observer','.+')
   queries.append({'dashboard':name,'title':panel['title'],'datasource':t['datasource']['uid'],'expr':expr})
remote='''import json,urllib.request,urllib.parse,base64
from pathlib import Path
headers=GRAFANA_HEADERS
def get(path):
 req=urllib.request.Request('http://127.0.0.1:3000/grafana/api/'+path,headers=headers)
 with urllib.request.urlopen(req,timeout=20) as r:return json.load(r)
for expected in DASHBOARDS:
 dashboard=get('dashboards/uid/'+expected['uid'])
 assert len(dashboard['dashboard']['panels'])==expected['panels'], expected
# Verify provisioned dashboards above; Grafana personal home is user-specific
# and its built-in default dashboard is not accessible to service accounts.
results=[]
for q in QUERIES:
 ds=q['datasource'];api='api/v1/query' if ds=='prometheus' else 'loki/api/v1/query_range'
 data=get('datasources/proxy/uid/'+ds+'/'+api+'?'+urllib.parse.urlencode({'query':q['expr'],**({'limit':10} if ds=='loki' else {})}))
 assert data['status']=='success', q['title']
 result=data['data']['result']
 if q['dashboard']=='postgres' or q['title'].startswith('/healthz') or q['title'] in ['Readiness — accepting traffic','Database /ready — availability','Database /ready — response time','Available / desired replicas','CPU usage — application container','Memory working set — application container']:
  assert result, 'No series: '+q['dashboard']+' / '+q['title']
 results.append({'dashboard':q['dashboard'],'panel':q['title'],'series':len(result)})
up=get('datasources/proxy/uid/prometheus/api/v1/query?'+urllib.parse.urlencode({'query':'up{job=~"alloy|cadvisor|kube-state-metrics"} and topk by (dc,job) (1, timestamp(up))'}))['data']['result']
assert len({(v['metric']['dc'],v['metric']['job']) for v in up})==6 and all(v['value'][1]=='1' for v in up), 'Missing DC or failed scrape target'
probe=get('datasources/proxy/uid/prometheus/api/v1/query?'+urllib.parse.urlencode({'query':'probe_success{job="http-probes"} and (time() - timestamp(probe_success{job="http-probes"}) < 20)'}))['data']['result']
assert len(probe)==28 and all(float(v['value'][1])==1 for v in probe), 'Expected 28 healthy, fresh per-pod HTTP probes'
counts={}
for v in probe:
 m=v['metric'];key=m['dc']+'/'+m['service']+'/'+m['check'];counts[key]=counts.get(key,0)+1
assert len(counts)==14 and all(n==2 for n in counts.values()), counts
database_checks={
 'database_connections': ('pg_up{job="postgres"}',4,'1'),
 'database_queries': ('pg_exporter_last_scrape_error{job="postgres"}',4,'0'),
 'database_roles': ('solo_pg_node_primary and (time()-timestamp(solo_pg_node_primary)<20)',4,None),
}
for name,(expr,count,value) in database_checks.items():
 rows=get('datasources/proxy/uid/prometheus/api/v1/query?'+urllib.parse.urlencode({'query':expr}))['data']['result']
 assert len(rows)==count, (name,len(rows),count)
 if value is not None:assert all(v['value'][1]==value for v in rows), (name,rows)
 else:
  assert sum(float(v['value'][1]) for v in rows)==2, 'Expected one primary observed from both DCs'
  assert len({v['metric']['dc'] for v in rows if v['value'][1]=='1'})==1, 'Observers disagree on primary'
routing_checks={
 'nlb_targets': ('soloapp_nlb_target_state{state="HEALTHY"} == 1',4),
 'nlb_pollers': ('soloapp_nlb_poll_success == 1',2),
 'ingress_scrapes': ('up{job="haproxy"} == 1',4),
 'service_endpoints': ('kube_endpointslice_endpoints{namespace="soloapp",ready="true",terminating!="true"}',12),
}
for name,(expr,count) in routing_checks.items():
 rows=get('datasources/proxy/uid/prometheus/api/v1/query?'+urllib.parse.urlencode({'query':expr}))['data']['result']
 assert len(rows)==count, (name,len(rows),count)
print(json.dumps({'dashboard_uids':[d['uid'] for d in DASHBOARDS],'panels':results,'scrape_targets':6,'http_probe_targets':counts}))
'''.replace('QUERIES',repr(queries)).replace('DASHBOARDS',repr(dashboards))
report={}
for host in ('yc','home'):
 result=run_grafana(host,remote,check=False)
 if result.returncode:raise RuntimeError(result.stderr)
 report[host]=json.loads(result.stdout);print(host,'verified',len(report[host]['panels']),'queries')
(ROOT/'outputs/observability-verification.json').write_text(json.dumps(report,indent=2)+'\n')
