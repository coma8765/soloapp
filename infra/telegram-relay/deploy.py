#!/usr/bin/env python3
"""Operator deployment. Credentials remain in memory, Lockbox and Worker Secrets."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'infra/object-storage'))
from bootstrap import yc, STATE


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--subdomain', help='Register only if this account has no workers.dev subdomain')
    parser.add_argument('--hostname', help='Optional custom HTTPS hostname for this Worker')
    parser.add_argument('--zone-name', help='Cloudflare zone containing --hostname')
    args = parser.parse_args()
    cloud = json.loads(STATE.read_text())
    account, token = os.environ['CF_ACCOUNT_ID'], os.environ['CF_API_TOKEN']
    worker = 'soloapp-alert-relay'

    def cf(path, method='GET', payload=None, content_type='application/json', allow_missing=False):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request('https://api.cloudflare.com/client/v4/accounts/' + account + path,
            data=body, method=method, headers={'Authorization': 'Bearer ' + token, 'Content-Type': content_type})
        try:
            with urllib.request.urlopen(request, timeout=60) as response: result = json.load(response)
        except urllib.error.HTTPError as error:
            if allow_missing and error.code == 404: return None
            # API error text may echo input bindings. Report codes only.
            try: codes = [entry.get('code') for entry in json.loads(error.read()).get('errors', [])]
            except Exception: codes = []
            raise RuntimeError(f'Cloudflare {method} failed: HTTP {error.code}, codes={codes}') from None
        if not result.get('success'): raise RuntimeError('Cloudflare operation unsuccessful')
        return result.get('result')

    def save():
        STATE.write_text(json.dumps(cloud, indent=2) + '\n'); STATE.chmod(0o600)

    def payload(name):
        result = yc('lockbox', 'payload', 'get', cloud['secrets'][name])
        return {entry['key']: entry.get('text_value', entry.get('textValue')) for entry in result['entries']}

    subdomain = cf('/workers/subdomain', allow_missing=True)
    if subdomain is None:
        if not args.subdomain or not re.fullmatch(r'[a-z0-9][a-z0-9-]{2,50}', args.subdomain):
            raise ValueError('Pass --subdomain to initialize this account')
        subdomain = cf('/workers/subdomain', 'PUT', {'subdomain': args.subdomain})
    name = 'alertmanager-relay'
    if name not in cloud['secrets']:
        value = secrets.token_urlsafe(48)
        cloud['secrets'][name] = yc('lockbox', 'secret', 'create', '--name', 'soloapp-' + name,
            '--folder-id', cloud['folder'], '--deletion-protection', '--payload', '-',
            payload=json.dumps([{'key': 'relay-token', 'textValue': value}]))['id']
        save()
    relay = payload(name); telegram = payload('alertmanager-telegram')
    bindings = {'RELAY_TOKEN': relay['relay-token'], 'TELEGRAM_BOT_TOKEN': telegram['telegram-token'],
                'TELEGRAM_CHAT_ID': telegram['telegram-chat-id']}
    if not all(isinstance(value, str) and value for value in bindings.values()):
        raise ValueError('Missing secret entries')
    metadata = {'main_module': 'worker.mjs', 'compatibility_date': '2026-10-27',
                'bindings': [{'name': name, 'type': 'secret_text', 'text': value} for name, value in bindings.items()],
                'observability': {'enabled': False}}
    boundary = 'soloapp-' + secrets.token_hex(16)
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n'.encode()
        + json.dumps(metadata).encode()
        + f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"\r\nContent-Type: application/javascript+module\r\n\r\n'.encode()
        + (Path(__file__).parent / 'src/worker.mjs').read_bytes() + f'\r\n--{boundary}--\r\n'.encode())
    cf('/workers/scripts/' + worker, 'PUT', body, 'multipart/form-data; boundary=' + boundary)
    previous = cloud.get('telegram_relay', {})
    hostname = args.hostname or previous.get('hostname')
    zone = args.zone_name or previous.get('zone')
    if hostname:
        if not zone or not hostname.endswith('.' + zone) or not re.fullmatch(r'[a-z0-9.-]+', hostname):
            raise ValueError('Custom hostname must be inside the configured zone')
        existing = cf('/workers/domains?hostname=' + hostname)
        if any(domain['hostname'] == hostname and domain['service'] != worker for domain in existing):
            raise ValueError('Custom hostname is already owned by another Worker')
        if not any(domain['hostname'] == hostname and domain.get('enabled', True) and
                   not domain.get('previews_enabled', False) for domain in existing):
            cf('/workers/domains', 'PUT', {'hostname': hostname, 'zone_name': zone, 'service': worker,
                                         'enabled': True, 'previews_enabled': False})
        url = 'https://' + hostname + '/alerts'
    else:
        url = f'https://{worker}.{subdomain["subdomain"]}.workers.dev/alerts'
    cf('/workers/scripts/' + worker + '/subdomain', 'POST', {'enabled': not bool(hostname), 'previews_enabled': False})
    cloud['telegram_relay'] = {'worker': worker, 'url': url, 'hostname': hostname, 'zone': zone}; save()
    for site in ('yc', 'home'):
        yc('lockbox', 'secret', 'add-access-binding', cloud['secrets'][name], '--role',
           'lockbox.payloadViewer', '--service-account-id', cloud['identities']['alertmanager-' + site])
    print('Relay deployed:', url)
    print('Only relay-token is readable by Alertmanager; remove old bot-secret grants after rollout.')


if __name__ == '__main__':
    main()
