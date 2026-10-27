#!/usr/bin/env python3
"""Create only Alertmanager workload identities and a dedicated Lockbox secret.
Token/chat ID travel through stdin to YC, never argv, manifest or log output.
"""
import argparse,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'object-storage'))
from bootstrap import yc,STATE

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--token-file',type=Path,required=True)
    parser.add_argument('--chat-id-file',type=Path,required=True)
    args=parser.parse_args()
    token=args.token_file.read_text().strip();chat=str(int(args.chat_id_file.read_text().strip()))
    if not token or ':' not in token: raise ValueError('Invalid bot token format')
    args.token_file.chmod(0o600)
    cloud=json.loads(STATE.read_text())
    def save(): STATE.write_text(json.dumps(cloud,indent=2)+'\n');STATE.chmod(0o600)
    name='alertmanager-telegram'
    if name not in cloud['secrets']:
        cloud['secrets'][name]=yc('lockbox','secret','create','--name','soloapp-'+name,'--folder-id',cloud['folder'],'--deletion-protection','--payload','-',payload=json.dumps([{'key':'telegram-token','textValue':token},{'key':'telegram-chat-id','textValue':chat}]))['id'];save()
    # Idempotent retry never silently rotates existing production credentials.
    for site in ['yc','home']:
        name='alertmanager-'+site
        if name not in cloud['identities']:
            cloud['identities'][name]=yc('iam','service-account','create','--name','soloapp-'+name,'--folder-id',cloud['folder'])['id'];save()
        account=cloud['identities'][name]
        existing=yc('iam','workload-identity','federated-credential','list','--service-account-id',account)
        if not any(c.get('federation_id')==cloud['federations'][site] and c.get('external_subject_id')=='system:serviceaccount:observability:alertmanager' for c in existing):
            yc('iam','workload-identity','federated-credential','create','--service-account-id',account,'--federation-id',cloud['federations'][site],'--external-subject-id','system:serviceaccount:observability:alertmanager')
        yc('lockbox','secret','add-access-binding',cloud['secrets']['alertmanager-telegram'],'--role','lockbox.payloadViewer','--service-account-id',account)
    print('Alertmanager identities provisioned; Telegram key stored only in Lockbox')
if __name__=='__main__':main()
