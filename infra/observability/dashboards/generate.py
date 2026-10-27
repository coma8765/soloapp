"""Build service-specific Grafana dashboards from shared panel definitions."""
import json
from pathlib import Path
ROOT=Path(__file__).parent
PROM={'type':'prometheus','uid':'prometheus'}
LOKI={'type':'loki','uid':'loki'}
LINKS=[{'title':title,'url':'/grafana/d/'+uid,'type':'link','keepTime':True,'includeVars':False} for title,uid in [('Overview','soloapp-overview'),('Auth','soloapp-auth'),('Whoami','soloapp-whoami'),('Nginx','soloapp-nginx'),('Infrastructure','soloapp-infrastructure'),('Routing chain','soloapp-routing'),('PostgreSQL','soloapp-postgres')]]

def panel(title, expressions, unit='short', kind='timeseries', description='', binary=False, datasource=PROM):
    if isinstance(expressions,str):expressions=[(expressions,'{{dc}} {{pod}}')]
    p={'title':title,'type':kind,'description':description,'datasource':datasource,'targets':[{'refId':chr(65+i),'expr':expr,'legendFormat':legend,'datasource':datasource} for i,(expr,legend) in enumerate(expressions)],'fieldConfig':{'defaults':{'unit':unit},'overrides':[]},'options':{'legend':{'displayMode':'table','placement':'bottom'},'tooltip':{'mode':'multi'}}}
    if binary:
        p['fieldConfig']['defaults'].update({'min':0,'max':2,'mappings':[{'type':'value','options':{'0':{'text':'DOWN','color':'red'},'1':{'text':'UP','color':'green'},'2':{'text':'STALE','color':'orange'}}}],'thresholds':{'mode':'absolute','steps':[{'color':'red','value':None},{'color':'green','value':1},{'color':'orange','value':2}]}})
    if kind=='logs':p['options']={'showTime':True,'showLabels':True,'wrapLogMessage':True,'sortOrder':'Descending'}
    return p

def probe_state(sel):
    metric='probe_success{'+sel+'}'
    age='time() - timestamp('+metric+')'
    return metric+' * ('+age+' < bool 20) + 2 * ('+age+' >= bool 20)'

def probes(service=None):
    sel='dc=~"$dc"'+(',service="'+service+'",pod=~"$pod"' if service else '')
    # Mask old remote-write series. Missing or stale probes must never look UP.
    live=probe_state(sel+',check="healthz"')
    return [
      panel('/healthz — availability per pod',live,kind='state-timeline',binary=True,description='Real HTTP GET from local Alloy every 5s. Only 200 is healthy. STALE means sample age >=20s; gaps mean missing data, not success. Independent of kubelet probes.'),
      panel('/healthz — response time','probe_duration_seconds{'+sel+',check="healthz"}','s'),
      panel('/healthz — HTTP status','probe_http_status_code{'+sel+',check="healthz"}',description='0 means no HTTP response (timeout, connection or transport failure). Expected 200.'),
      panel('/healthz — last sample age','time() - timestamp(probe_success{'+sel+',check="healthz"})','s',description='Time since last received probe sample; >20s is stale.'),
      panel('Readiness — accepting traffic',probe_state(sel+',check="readiness"'),kind='state-timeline',binary=True,description='Auth/whoami: /health/ready (includes 5xx cooldown); nginx: /healthz. Kubelet independently controls Service endpoints.'),
    ]

def resources(service):
    sel='namespace="soloapp",dc=~"$dc",pod=~"$pod",container="'+service+'"'
    dep='namespace="soloapp",dc=~"$dc",deployment="'+service+'"'
    return [
      panel('Available / desired replicas',[(f'kube_deployment_status_replicas_available{{{dep}}}','{{dc}} available'),(f'kube_deployment_spec_replicas{{{dep}}}','{{dc}} desired')]),
      panel('CPU usage — application container',f'sum by(dc,pod)(rate(container_cpu_usage_seconds_total{{{sel}}}[$__rate_interval]))','cores'),
      panel('Memory working set — application container',f'container_memory_working_set_bytes{{{sel}}}','bytes'),
      panel('Memory utilization / limit',f'100 * container_memory_working_set_bytes{{{sel}}} / on(dc,namespace,pod,container) group_left kube_pod_container_resource_limits{{{sel},resource="memory"}}','percent'),
      panel('CPU throttling',f'rate(container_cpu_cfs_throttled_seconds_total{{{sel}}}[$__rate_interval])','s'),
      panel('Container restarts',f'kube_pod_container_status_restarts_total{{{sel}}}'),
    ]

def http(service):
    # Gateway metrics have pod=nginx-pod. Do not apply the application pod filter.
    sel='dc=~"$dc",route=~"$route"'+('' if service=='nginx' else ',service="'+service+'"')
    desc='Measured at nginx gateway; includes network/auth checks. These HTTP panels are per service/DC, not per application pod. Internal auth subrequests are not separately counted.'
    metric='soloapp_http_requests_total'
    panels=[panel('HTTP requests / second',f'sum by(dc,route)(rate({metric}{{{sel}}}[$__rate_interval]))','reqps',description=desc),panel('HTTP latency — p50 / p95 / p99',[(f'histogram_quantile({q},sum by(le,dc,route)(rate(soloapp_http_request_duration_seconds_bucket{{{sel}}}[$__rate_interval])))',label+' {{dc}} {{route}}') for q,label in [(0.5,'p50'),(0.95,'p95'),(0.99,'p99')]],'s',description=desc),panel('HTTP responses by status',f'sum by(dc,route,status)(rate({metric}{{{sel}}}[$__rate_interval]))','reqps')]
    error=f'sum by(dc,route)(rate({metric}{{{sel},status=~"5.."}}[$__rate_interval]))'
    total=f'sum by(dc,route)(rate({metric}{{{sel}}}[$__rate_interval]))'
    panels.append(panel('HTTP 5xx share',f'100 * ({error} or 0 * {total}) / clamp_min({total}, 0.000001)','percent'))
    if service=='auth':
        panels += [panel('Auth outcomes — login / registration / logout',f'sum by(dc,route,status)(rate({metric}{{{sel},route=~"/auth/(login|register|logout)"}}[$__rate_interval]))','reqps',description='Login 200=success, 401=denied; registration 201=created, 409=duplicate; 429=rate limited.'),panel('Database /ready — availability',probe_state('dc=~"$dc",service="auth",pod=~"$pod",check="db-ready"'),kind='state-timeline',binary=True),panel('Database /ready — response time','probe_duration_seconds{dc=~"$dc",service="auth",pod=~"$pod",check="db-ready"}','s')]
    if service=='whoami':
        panels.append(panel('/user-id — successful / rejected requests',f'sum by(dc,status)(rate({metric}{{{sel},route="/user-id"}}[$__rate_interval]))','reqps',description='Client-visible result includes nginx auth_request. A 401 can originate from auth verification before whoami is invoked.'))
    if service=='nginx':
        panels.append(panel('Gateway 429 rate limiting',f'(sum by(dc,route)(rate({metric}{{{sel},status="429"}}[$__rate_interval])) or 0 * sum by(dc,route)(rate({metric}{{{sel}}}[$__rate_interval])))','reqps',description='Zero means no rate limiting for routes with observed traffic.'))
    for p in panels:
        for t in p['targets']:
            if t['legendFormat']=='{{dc}} {{pod}}' and 'soloapp_http_' in t['expr']:
                t['legendFormat']='{{dc}} {{route}} {{status}}'
    return panels

def dashboard(uid,title,panels,service=None):
    variables=[{'name':'dc','type':'custom','query':'yc,home','multi':True,'includeAll':True,'allValue':'.+','current':{'text':'All','value':'$__all'}}]
    if service:
        variables += [{'name':'pod','type':'query','datasource':PROM,'query':'label_values(probe_success{service="'+service+'",dc=~"$dc"},pod)','refresh':2,'multi':True,'includeAll':True,'allValue':service+'-.+','current':{'text':'All','value':'$__all'}},{'name':'route','type':'query','datasource':PROM,'query':'label_values(soloapp_http_requests_total{dc=~"$dc"'+('' if service=='nginx' else ',service="'+service+'"')+'},route)','refresh':2,'multi':True,'includeAll':True,'allValue':'.*','current':{'text':'All','value':'$__all'}},{'name':'search','type':'textbox','query':'.*','current':{'text':'.*','value':'.*'}}]
    y=0;half=False
    for i,p in enumerate(panels,1):
        wide=p['type']=='logs'
        if wide and half:y+=8;half=False
        p['id']=i;p['gridPos']={'x':12 if half else 0,'y':y,'w':24 if wide else 12,'h':12 if wide else 8}
        if wide:y+=12
        elif half:y+=8;half=False
        else:half=True
    return {'id':None,'uid':uid,'title':title,'schemaVersion':39,'version':2,'refresh':'5s','timezone':'browser','time':{'from':'now-1h','to':'now'},'tags':['soloapp','lite'],'description':'Per-pod HTTP health probes and service-specific telemetry. Missing data is not success. Business HTTP latency/RPS are observed at nginx.','links':LINKS,'templating':{'list':variables},'panels':panels}

for svc in ['auth','whoami','nginx']:
    panels=probes(svc)+http(svc)+resources(svc)
    # Keep actual application logs apart from gateway access logs attributed to it.
    panels.append(panel('Application logs',f'{{dc=~"$dc",container="{svc}",pod=~"$pod"}} |~ "$search"',kind='logs',datasource=LOKI))
    if svc!='nginx':panels.append(panel('Gateway access logs for '+svc,f'{{dc=~"$dc",container="nginx",service="{svc}"}} |~ "$search"',kind='logs',datasource=LOKI))
    (ROOT/(svc+'.json')).write_text(json.dumps(dashboard('soloapp-'+svc,'Soloapp · '+svc.capitalize(),panels,svc),indent=2)+'\n')
summary=probes()+[
 panel('Available / desired replicas',[(f'{m}{{namespace="soloapp",dc=~"$dc"}}','{{dc}} {{deployment}} '+label) for m,label in [('kube_deployment_status_replicas_available','available'),('kube_deployment_spec_replicas','desired')]]),
 panel('Business RPS by service',[('sum by(dc,service)(rate(soloapp_http_requests_total{dc=~"$dc"}[$__rate_interval]))','{{dc}} {{service}}')],'reqps'),
 panel('Agent sample age','time() - max by(dc)(timestamp(up{job="alloy",dc=~"$dc"}))','s'),
]
(ROOT/'soloapp.json').write_text(json.dumps(dashboard('soloapp-overview','Soloapp · Overview',summary),indent=2)+'\n')
infra=[
 panel('Node Ready','kube_node_status_condition{condition="Ready",status="true",dc=~"$dc"}',binary=True),
 panel('Scrape targets',[('up{job=~"alloy|cadvisor|kube-state-metrics",dc=~"$dc"}','{{dc}} {{job}}')],binary=True),
 panel('Agent sample age','time() - max by(dc)(timestamp(up{job="alloy",dc=~"$dc"}))','s'),
 panel('HTTP probe count by service','count by(dc,service,check)(probe_success{dc=~"$dc"})'),
 panel('Monitoring container CPU','sum by(dc,pod,container)(rate(container_cpu_usage_seconds_total{namespace="observability",container!="",container!="POD",dc=~"$dc"}[$__rate_interval]))','cores'),
 panel('Monitoring container memory','container_memory_working_set_bytes{namespace="observability",container!="",container!="POD",dc=~"$dc"}','bytes'),
]
(ROOT/'infrastructure.json').write_text(json.dumps(dashboard('soloapp-infrastructure','Soloapp · Infrastructure',infra),indent=2)+'\n')

# Keep the observer dimension: a partition may affect one observer only.
def fresh_state(metric, horizon=20):
    age='time() - timestamp('+metric+')'
    return metric+' * ('+age+' < bool '+str(horizon)+') + 2 * ('+age+' >= bool '+str(horizon)+')'
ha='ingress=~"$ingress",observer=~"$observer",proxy=~"auth_sites|grafana_sites|witness_reachability"'
nlb='ingress=~"$ingress",observer=~"$observer"'
route_panels=[
 panel('1 · YC NLB → ingress — actual target state',[(f'soloapp_nlb_target_state{{{nlb}}} == 1','{{observer}} → {{ingress}} {{state}}')],kind='state-timeline',description='YC getTargetStates decision, not an inferred HTTP probe. HEALTHY is eligible; UNHEALTHY/DRAINING/INACTIVE excluded. UNKNOWN means no authoritative state. Check poll freshness below.'),
 panel('NLB API — observer freshness',[(f'time() - soloapp_nlb_last_success_timestamp_seconds{{observer=~"$observer"}}','{{observer}} last successful API read')],'s',description='API read every 5s. A failed API read produces UNKNOWN targets; an absent/stalled observer must not be interpreted as healthy.'),
 panel('2 · HAProxy → DC — server state',[(f'haproxy_server_status{{{ha}}} == 1','{{observer}} / {{ingress}} → {{proxy}} / {{server}} {{state}}')],kind='state-timeline',description='Actual HAProxy state. Grafana home is a healthy backup: UP does not mean currently selected. Auth and Grafana route health are independent.'),
 panel('HAProxy — last check result',[(f'haproxy_server_check_status{{{ha}}} == 1','{{observer}} / {{ingress}} → {{proxy}} / {{server}} {{state}}')],kind='state-timeline',description='L4TOUT/L6TOUT/L7TOUT = timeout; L4CON = connection error; L7STS = unexpected HTTP status; L7OK = successful HTTP check.'),
 panel('HAProxy — check duration',[(f'haproxy_server_check_duration_seconds{{{ha}}}','{{observer}} / {{ingress}} → {{proxy}} / {{server}}')],'s'),
 panel('HAProxy — responses by status (selected range)',[('sum by(code) (max by(ingress,proxy,server,code) (increase(haproxy_server_http_responses_total{ingress=~"$ingress",observer=~"$observer",server=~"$dc",proxy=~"auth_sites|grafana_sites"}[$__range])))','HTTP {{code}}')],kind='bargauge',description='Estimated backend response counts over the selected dashboard time range, grouped as 1xx–5xx/other (native HAProxy counters do not expose individual codes). Counts user traffic, not active health checks or responses generated by HAProxy without a backend server. Filters: ingress, DC, observer. Counter resets are handled by increase; take the maximum estimate across observers for each server before summing, so dual collection does not double counts. Gaps may undercount; rounded for display.'),
 panel('HAProxy — exclusions (UP → DOWN)',[(f'increase(haproxy_server_check_up_down_total{{{ha}}}[$__rate_interval])','{{observer}} / {{ingress}} → {{proxy}} / {{server}}')],description='Transitions counted by each HAProxy. Separate observers duplicate the same counter: do not sum them.'),
 panel('HAProxy — routed sessions / second',[(f'rate(haproxy_server_sessions_total{{{ha}}}[$__rate_interval])','{{observer}} / {{ingress}} → {{proxy}} / {{server}}')],'reqps',description='Shows actual backend selection, including activation of Grafana backup. Sessions are not necessarily HTTP requests.'),
 panel('3 · Service → pod — ready endpoints', [('kube_endpointslice_endpoints{namespace="soloapp",dc=~"$dc",ready="true",terminating!="true"} and (time() - timestamp(kube_endpointslice_endpoints{namespace="soloapp",dc=~"$dc"}) < 45)','{{dc}} {{endpointslice}} → {{targetref_name}}')],kind='state-timeline',description='Actual EndpointSlice membership from Kubernetes. Only ready, non-terminating endpoints. Missing lines mean not eligible or missing collection; consult pod Ready and collector state.'),
 panel('Kubernetes — pod Ready condition',[(fresh_state('kube_pod_status_ready{namespace="soloapp",dc=~"$dc",pod=~"(auth|nginx|whoami)-.+",condition="true"}',45),'{{dc}} {{pod}}')],kind='state-timeline',binary=True,description='Kubelet readiness, not the independent Alloy probe. 0 excludes the pod from normal Service traffic. STALE means sample older than 45s.'),
 panel('4 · Pod /healthz — independent HTTP check',[(probe_state('dc=~"$dc",check="healthz"'),'{{dc}} {{service}} {{pod}}')],kind='state-timeline',binary=True),
 panel('Pod readiness — independent HTTP check',[(probe_state('dc=~"$dc",check="readiness"'),'{{dc}} {{service}} {{pod}}')],kind='state-timeline',binary=True),
 panel('Collection — HAProxy scrape status',[(fresh_state('up{job="haproxy",ingress=~"$ingress",observer=~"$observer"}'),'{{observer}} → {{ingress}}')],kind='state-timeline',binary=True,description='A scrape failure means the observer cannot read the proxy. It does not by itself prove NLB exclusion.'),
 panel('Collection — NLB API read status',[(fresh_state('soloapp_nlb_poll_success{observer=~"$observer"}'),'{{observer}}')],kind='state-timeline',binary=True),
]


# One instant result for the full selected range, not a moving-window time series.
route_panels[5]['targets'][0].update({'instant':True,'range':False})
route_panels[5]['options']={'orientation':'horizontal','displayMode':'gradient','showUnfilled':True,'reduceOptions':{'values':False,'calcs':['lastNotNull'],'fields':''}}
route_panels[5]['fieldConfig']['defaults'].update({'min':0,'decimals':0})
route_panels[5]['fieldConfig']['overrides']=[{'matcher':{'id':'byName','options':'HTTP '+code},'properties':[{'id':'color','value':{'mode':'fixed','fixedColor':color}}]} for code,color in [('1xx','blue'),('2xx','green'),('3xx','yellow'),('4xx','orange'),('5xx','red'),('other','gray')]]

def coded_states(metric, selector, mapping, legend, freshness=20):
    base=metric+'{'+selector+'}'
    terms=[str(value)+' * sum without(state)('+metric+'{'+selector+',state="'+state+'"})' for value,(state,color) in mapping.items() if state!='STALE']
    code='('+' + '.join(terms)+')'
    age='time() - max without(state)(timestamp('+base+'))'
    expr=code+' * ('+age+' < bool '+str(freshness)+') + 2 * ('+age+' >= bool '+str(freshness)+')'
    fields={'unit':'short','mappings':[{'type':'value','options':{str(value):{'text':state,'color':color} for value,(state,color) in mapping.items()}}],'color':{'mode':'thresholds'}}
    return expr,fields

for index,metric,selector,mapping in [
 (0,'soloapp_nlb_target_state',nlb,{0:('UNHEALTHY','red'),1:('HEALTHY','green'),2:('STALE','orange'),3:('INITIAL','yellow'),4:('DRAINING','orange'),5:('INACTIVE','gray'),6:('UNKNOWN','orange')}),
 (2,'haproxy_server_status',ha,{0:('DOWN','red'),1:('UP','green'),2:('STALE','orange'),3:('MAINT','gray'),4:('DRAIN','orange'),5:('NOLB','red')}),
 (3,'haproxy_server_check_status',ha,{i:(state,'green' if state in ('L4OK','L6OK','L7OK','PROCOK') else 'orange' if state=='STALE' else 'red') for i,state in enumerate(['HANA','SOCKERR','STALE','L4OK','L4TOUT','L4CON','L6OK','L6TOUT','L6RSP','L7TOUT','L7RSP','L7OK','L7OKC','L7STS','PROCERR','PROCTOUT','PROCOK'])}),
]:
    expr,fields=coded_states(metric,selector,mapping,'')
    if index==0:
        # Poll timestamp is refreshed independently from Prometheus scrape timestamp.
        expr='('+expr+') * on(observer) group_left() (time() - soloapp_nlb_last_success_timestamp_seconds{observer=~"$observer"} < bool 20) + 2 * on(observer) group_left() (0 * ('+expr+') + 1) * on(observer) group_left() (time() - soloapp_nlb_last_success_timestamp_seconds{observer=~"$observer"} >= bool 20)'
        # Keep UNKNOWN for a collector that has never read the API.
        expr=expr.replace('2 * on(observer) group_left() (0 * (','2 * (0 * (')
    route_panels[index]['targets'][0]['expr']=expr
    route_panels[index]['targets'][0]['legendFormat']='{{observer}} → {{ingress}}'+(' / {{proxy}} → {{server}}' if index else '')
    route_panels[index]['fieldConfig']['defaults']=fields
    route_panels[index]['options']['mergeValues']=True
    route_panels[index]['description']+=' Samples older than 20s are STALE; consult collector status before interpreting routing.'
# Real ready and non-terminating endpoints, including 0 for excluded members.
ep='kube_endpointslice_endpoints{namespace="soloapp",dc=~"$dc"}'
route_panels[8]['targets'][0]['expr']='max by(dc,endpointslice,targetref_name) (('+ep.replace('}',',ready="true",terminating!="true"}')+' or on(dc,endpointslice,address,targetref_name) 0 * '+ep+') * (time() - timestamp('+ep+') < bool 20) + 2 * (time() - timestamp('+ep+') >= bool 20))'
route_panels[8]['fieldConfig']['defaults']=route_panels[9]['fieldConfig']['defaults']
route_panels[8]['description']='Actual EndpointSlice: UP=ready and not terminating; DOWN=not eligible for normal Service traffic. STALE after 20s; missing endpoint is a gap. Kube-proxy may briefly route to serving/terminating endpoints while draining existing traffic.'
# Split successful/redirect and error response rates without summing duplicate observers.
for quality,codes,color in [('Good','1xx|2xx|3xx','green'),('Bad','4xx|5xx|other','red')]:
    selector='ingress=~"$ingress",observer=~"$observer",server=~"$dc",proxy=~"auth_sites|grafana_sites",code=~"'+codes+'"'
    expr='sum by(ingress,proxy,server) (max by(ingress,proxy,server,code) (rate(haproxy_server_http_responses_total{'+selector+'}[$__rate_interval])))'
    item=panel('HAProxy — '+quality+' RPS',[(expr,'{{ingress}} → {{proxy}} / {{server}}')],'reqps',description=quality+' responses per second: '+codes.replace('|',', ')+'. Backend user-traffic responses; active health checks and locally generated HAProxy errors without backend response are excluded. HTTP 4xx includes expected auth rejections, not only service faults. Observer estimates are deduplicated per ingress/backend/server/code before summing. No samples remain missing, never synthesized as zero.')
    item['fieldConfig']['defaults'].update({'min':0,'color':{'mode':'fixed','fixedColor':color}})
    route_panels.append(item)
routing=dashboard('soloapp-routing','Soloapp · Routing chain',route_panels)
routing['description']='NLB → ingress → DC → Kubernetes Service → pod. HAProxy excludes on its active health checks; slow arbitrary business responses do not automatically exclude an otherwise healthy pod. Missing telemetry is not an UP state. NLB/Grafana and auth health are independent. Grafana home is backup.'
routing['templating']['list'] += [{'name':name,'type':'custom','query':values,'multi':True,'includeAll':True,'allValue':'.+','current':{'text':'All','value':'$__all'}} for name,values in [('ingress','yc,edge'),('observer','yc,home')]]
(ROOT/'routing.json').write_text(json.dumps(routing,indent=2)+'\n')

# PostgreSQL counters are observed twice. Deduplicate by physical DC, never sum observers.
pgsel='job="postgres",dc=~"$dc",observer=~"$observer"'
def pgmetric(name): return name+'{'+pgsel+'}'
def pgmax(name): return 'max by(dc,observer)('+pgmetric(name)+')'
pgup='('+pgmax('pg_up')+' * (1 - '+pgmax('pg_exporter_last_scrape_error')+'))'
pgage='(time() - max by(dc,observer)(timestamp('+pgmetric('pg_up')+')))'
pgfresh='('+pgage+' < bool 20)'
primary='('+pgmax('solo_pg_node_primary')+' and (time() - max by(dc,observer)(timestamp('+pgmetric('solo_pg_node_primary')+')) < 20))'
role='((('+pgmax('solo_pg_node_primary')+' and on(dc,observer) ('+pgup+' == 1)) or on(dc,observer) ((2 + 0 * '+pgup+') and on(dc,observer) ('+pgup+' == 0))) * '+pgfresh+' + 3 * (1 - '+pgfresh+'))'
live='('+pgup+' == 1) and on(dc,observer) ('+pgage+' < 20)'
def gauge(name,groups='dc'):
    return 'max by('+groups+')('+pgmetric(name)+' and on(dc,observer) ('+live+'))'
def counter(name,groups='dc'):
    return 'max by('+groups+')(rate('+pgmetric(name)+'[$__rate_interval]) and on(dc,observer) ('+live+'))'
pgpanels=[
 panel('Current master — physical DC',[( 'max by(dc)(('+primary+' == 1) and on(dc,observer) ('+live+'))','{{dc}}')],kind='stat',description='Fresh observations of pg_is_in_recovery()=false. Empty means no confirmed current primary. It does not prove fencing or successful writes; compare auth /ready and the primary-count panel.'),
 panel('Primary / standby — history by observer',[(role,'{{observer}} → {{dc}}')],kind='state-timeline',description='1 PRIMARY, 0 STANDBY, 2 UNAVAILABLE (connection or collection failure), 3 STALE (20s). Two independent observers can disagree during a partition; gaps are unknown, not healthy.'),
 panel('Number of observed primaries', [('sum(max by(dc)(('+primary+' and on(dc,observer) ('+live+'))))','observed primary count')],kind='stat',description='Expected 1 when both sites are observed. 0 = no primary observed; >1 requires investigation. Missing data is not synthesized as zero.'),
 panel('Database reachability',[(fresh_state(pgmetric('pg_up')),'{{observer}} → {{dc}}')],kind='state-timeline',binary=True),
 panel('Database metrics — sample age',[(pgage,'{{observer}} → {{dc}}')],'s'),
 panel('Database collection errors',[(pgmetric('pg_exporter_last_scrape_error'),'{{observer}} → {{dc}}')],description='0 healthy; 1 one or more metric queries failed. Database connectivity alone does not guarantee complete statistics.'),
 panel('Synchronous replication',[(gauge('solo_pg_node_sync_required'),'{{dc}} sync configured'),(gauge('solo_pg_node_synchronous_standbys'),'{{dc}} synchronous replicas'),(gauge('solo_pg_node_streaming_standbys'),'{{dc}} streaming replicas')],description='Interpret on the primary. A standalone writable primary can have sync disabled by pg_auto_failover; 0 replicas is then expected but data has only one copy.'),
 panel('Replication — primary to replica WAL gap',[(gauge('solo_pg_replication_replay_gap_bytes','dc,application_name,state,sync_state'),'{{dc}} → {{application_name}} {{state}} {{sync_state}}')],'bytes',description='Primary WAL position minus last reported replay LSN. Only rows with a reported replay LSN are emitted; missing replica is missing, never zero lag.'),
 panel('Standby — received WAL not yet replayed',[(gauge('solo_pg_node_receive_replay_gap_bytes'),'{{dc}}')],'bytes',description='Receive minus replay on standby; primary emits 0. Does not include WAL not yet received over the network.'),
 panel('Client connections by state', [('sum by(dc,state)('+gauge('solo_pg_connections_count','dc,state,application,wait_type')+')','{{dc}} {{state}}')]),
 panel('Auth pool — database connections', [('sum by(dc)(max by(dc,state,application,wait_type)(solo_pg_connections_count{'+pgsel+',application="auth"} and on(dc,observer) ('+live+')))','{{dc}} auth')],description='Physical PostgreSQL sessions with application_name=soloapp-auth. Pools connect to the current primary; this is not a count grouped by the application pod location.'),
 panel('Connections / configured maximum',[(gauge('solo_pg_database_numbackends'),'{{dc}} authdb'),(gauge('solo_pg_node_max_connections'),'{{dc}} server limit')],description='authdb sessions compared with the global server connection limit; other databases and reserved slots also consume capacity.'),
 panel('Transactions / second',[(counter('solo_pg_database_xact_commit'),'{{dc}} commits'),(counter('solo_pg_database_xact_rollback'),'{{dc}} rollbacks')],'ops',description='Database transactions including monitoring and readiness, not business request RPS. Read-only queries on standby also commit transactions.'),
 panel('Cache hit ratio', [('100 * '+counter('solo_pg_database_blks_hit')+' / clamp_min(('+counter('solo_pg_database_blks_hit')+' + '+counter('solo_pg_database_blks_read')+'), 0.000001)','{{dc}}')],'percent',description='PostgreSQL shared-buffer hits. OS cache is not included; idle periods can display zero.'),
 panel('Rows / second',[(counter('solo_pg_database_'+key),'{{dc}} '+label) for key,label in [('tup_fetched','fetched'),('tup_inserted','inserted'),('tup_updated','updated'),('tup_deleted','deleted')]],'ops'),
 panel('Temporary writes / second',[(counter('solo_pg_database_temp_bytes'),'{{dc}}')],'Bps'),
 panel('Waiting locks / blocked sessions',[(gauge('solo_pg_contention_waiting_locks'),'{{dc}} waiting locks'),(gauge('solo_pg_contention_blocked_sessions'),'{{dc}} blocked sessions')]),
 panel('Oldest open client transaction',[(gauge('solo_pg_contention_oldest_transaction_seconds'),'{{dc}}')],'s'),
 panel('Deadlocks / second',[(counter('solo_pg_database_deadlocks'),'{{dc}}')],'ops'),
 panel('Database size',[(gauge('solo_pg_database_size_bytes'),'{{dc}} authdb')],'bytes'),
 panel('PostgreSQL uptime',[(gauge('solo_pg_node_uptime_seconds'),'{{dc}}')],'s'),
 panel('Connections by wait category',[('sum by(dc,wait_type)('+gauge('solo_pg_connections_count','dc,state,application,wait_type')+')','{{dc}} {{wait_type}}')]),
]
pgpanels[0]['fieldConfig']['defaults']['mappings']=[{'type':'value','options':{'1':{'text':'MASTER','color':'green'}}}]
pgpanels[0]['options']={'textMode':'value_and_name','colorMode':'background','reduceOptions':{'calcs':['last'],'fields':'','values':False}}
pgpanels[0]['fieldConfig']['defaults']['noValue']='UNKNOWN'
pgpanels[1]['fieldConfig']['defaults']['mappings']=[{'type':'value','options':{str(k):{'text':v,'color':c} for k,v,c in [(0,'STANDBY','blue'),(1,'PRIMARY','green'),(2,'UNAVAILABLE','red'),(3,'STALE','orange')]}}]
pgpanels[1]['options']['mergeValues']=True
pgpanels[2]['fieldConfig']['defaults']['thresholds']={'mode':'absolute','steps':[{'color':'red','value':None},{'color':'green','value':1},{'color':'red','value':2}]}
for i in (0,2):
    for target in pgpanels[i]['targets']:target.update({'instant':True,'range':False})
pgdash=dashboard('soloapp-postgres','Soloapp · PostgreSQL',pgpanels)
pgdash['description']='Physical PostgreSQL nodes, observed independently from YC and home every 5s over mTLS. Missing or stale data never proves a healthy primary. Statistics exclude SQL text and application records.'
pgdash['templating']['list'].append({'name':'observer','type':'custom','query':'yc,home','multi':True,'includeAll':True,'allValue':'.+','current':{'text':'All','value':'$__all'}})
(ROOT/'postgres.json').write_text(json.dumps(pgdash,indent=2)+'\n')
