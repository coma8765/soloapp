#!/usr/bin/env python3
"""Operator bootstrap: create scoped S3 credentials directly in Lockbox."""
import json
from pathlib import Path
import secrets
import subprocess

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / 'infra/cloud/resources.json'


def yc(*args, payload=None):
    result = subprocess.run(['yc', *args, '--format', 'json'], input=payload, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode: raise RuntimeError('YC operation failed: ' + ' '.join(args[:4]))
    return json.loads(result.stdout or '{}')


def main():
    cloud = json.loads(STATE.read_text())
    if 's3-server' in cloud['secrets']:
        print('S3 secrets already initialized; refusing to replace keys'); return
    def key(): return {'accessKey': 'solo' + secrets.token_hex(12), 'secretKey': secrets.token_hex(32)}
    admin, writer, reader = key(), key(), key()
    bucket = 'soloapp-web'
    endpoints = ['http://10.77.26.11:18333', 'http://10.77.26.12:18333']
    def client(k, endpoints): return {'bucket': bucket, 'access_key': k['accessKey'], 'secret_key': k['secretKey'], 'endpoints': endpoints}
    server = {'identities': [
        {'name':'operator', 'credentials':[admin], 'actions':['Admin','Read','Write','List','Tagging']},
        {'name':'publisher', 'credentials':[writer], 'actions':['Read:'+bucket,'Write:'+bucket,'List:'+bucket]},
        {'name':'web', 'credentials':[reader], 'actions':['Read:'+bucket]},
    ]}
    entries = {'s3-server': {'s3.json': server, 'admin.json': client(admin, endpoints)},
               's3-publisher': {'publisher.json': client(writer, endpoints)},
               'web-yc': {'reader.json': client(reader, endpoints)},
               'web-home': {'reader.json': client(reader, list(reversed(endpoints)))}}
    for name, files in entries.items():
        if name not in cloud['secrets']:
            payload = json.dumps([{'key': k, 'textValue': json.dumps(v)} for k,v in files.items()])
            cloud['secrets'][name] = yc('lockbox','secret','create','--name','soloapp-'+name,'--deletion-protection','--payload','-',payload=payload)['id']
            STATE.write_text(json.dumps(cloud, indent=2)+'\n'); STATE.chmod(0o600)
    for site in ('yc','home'):
        for name in ('s3-server','s3-publisher'):
            yc('lockbox','secret','add-access-binding',cloud['secrets'][name], '--role','lockbox.payloadViewer','--service-account-id',cloud['identities']['node-'+site])
        name = 'web-'+site
        if name not in cloud['identities']:
            cloud['identities'][name] = yc('iam','service-account','create','--name','soloapp-'+name)['id']
            STATE.write_text(json.dumps(cloud, indent=2)+'\n')
        account = cloud['identities'][name]
        yc('iam','workload-identity','federated-credential','create','--service-account-id',account,
           '--federation-id',cloud['federations'][site],'--external-subject-id','system:serviceaccount:soloapp:web-secrets')
        yc('lockbox','secret','add-access-binding',cloud['secrets'][name], '--role','lockbox.payloadViewer','--service-account-id',account)
    print('S3 identities initialized; key material remains in Lockbox')


if __name__ == '__main__': main()
