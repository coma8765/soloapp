#!/usr/bin/env python3
"""Operator SSH helper: targets come exclusively from a local Ansible inventory."""
import functools, json, os, pathlib, shlex, subprocess, sys
ROOT = pathlib.Path(__file__).resolve().parents[2]

@functools.lru_cache(maxsize=1)
def inventory():
    path = pathlib.Path(os.environ.get('SOLOAPP_INVENTORY', ROOT / 'infra/ansible/inventory.yaml'))
    if not path.is_file():
        raise RuntimeError('Create a private infra/ansible/inventory.yaml from inventory.example.yaml first')
    result = subprocess.run(['ansible-inventory', '-i', str(path), '--list'], cwd=ROOT, text=True, capture_output=True, check=True)
    return json.loads(result.stdout)['_meta']['hostvars']

def host_config(host):
    return inventory()[host]

def base_url():
    explicit = os.environ.get('SOLOAPP_BASE_URL')
    return explicit.rstrip('/') if explicit else 'https://' + host_config('yc')['public_domain']

def run(host, script, check=True, capture=False):
    config = host_config(host)
    target = config['ansible_user'] + '@' + config['ansible_host']
    options = shlex.split(config.get('ansible_ssh_common_args', '-o ForwardAgent=no -o BatchMode=yes'))
    (ROOT / 'outputs').mkdir(exist_ok=True)
    return subprocess.run(['ssh', *options, '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-p', str(config.get('ansible_port', 22)), target, 'sudo -n bash -se'], input=script, text=True, check=check, capture_output=capture)

if __name__ == '__main__':
    script = pathlib.Path(sys.argv[2]).read_text() if len(sys.argv)>2 else sys.stdin.read()
    run(sys.argv[1], script)
