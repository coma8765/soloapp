#!/usr/bin/python3
"""Root-owned CD gate. Only a green, current main commit can be deployed.

This program is installed by an operator, not self-updated by a release.
No arbitrary command, repository URL, inventory or manifest comes over SSH.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

CONFIG = Path('/etc/soloapp-cd/config.json')
STATE = Path('/var/lib/soloapp-cd')


def validate_revision(revision):
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Expected a full lowercase commit SHA')
    return revision


def ci_passed(data, revision, repository):
    return any(r.get('head_sha') == revision and r.get('head_branch') == 'main'
               and r.get('event') == 'push' and r.get('conclusion') == 'success'
               and r.get('head_repository', {}).get('full_name') == repository
               for r in data.get('workflow_runs', []))


def run(argv, *, cwd=None, capture=False, env=None):
    if argv[0] == 'git':
        argv = ['docker', 'run', '--rm', '--user', '0:0', '--cap-drop=ALL',
                '--security-opt', 'no-new-privileges', '-v', str(STATE) + ':' + str(STATE),
                '-w', str(cwd or STATE), '--entrypoint', 'git',
                'soloapp/deploy-controller:1'] + argv[1:]
        cwd = None
    return subprocess.run(argv, cwd=cwd, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None, env=env).stdout


def main():
    os.umask(0o077)
    if len(sys.argv) != 2:
        raise SystemExit('Expected probe or commit SHA')
    cfg = json.loads(CONFIG.read_text())
    if sys.argv[1] == 'probe':
        print(json.dumps({'site': cfg['site'], 'ready': True}))
        return
    sha = validate_revision(sys.argv[1])
    STATE.mkdir(mode=0o700, exist_ok=True)
    with (STATE / 'deploy.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        api = ('https://api.github.com/repos/' + cfg['repository'] +
               '/actions/workflows/ci.yaml/runs?event=push&branch=main&head_sha=' + sha)
        req = urllib.request.Request(api, headers={'User-Agent': 'soloapp-cd', 'Accept': 'application/vnd.github+json'})
        with urllib.request.urlopen(req, timeout=30) as response:
            if not ci_passed(json.load(response), sha, cfg['repository']):
                raise SystemExit('Deployment denied: successful push CI on main is required')
        repo = STATE / 'repository'
        if not repo.exists():
            run(['git', 'clone', '--no-checkout', 'https://github.com/' + cfg['repository'] + '.git', str(repo)])
        run(['git', 'fetch', '--prune', 'origin', '+refs/heads/main:refs/remotes/origin/main'], cwd=repo)
        if run(['git', 'rev-parse', 'origin/main'], cwd=repo, capture=True).strip() != sha:
            raise SystemExit('Deployment denied: this is not the current main commit')
        source = STATE / ('release-' + sha)
        if not source.exists():
            run(['git', 'worktree', 'add', '--detach', str(source), sha], cwd=repo)
        # Files mounted into the unprivileged controller must be traversable.
        os.chmod(STATE, 0o755)
        run(['chmod', '-R', 'a+rX', str(source)])
        tag = 'git-' + sha
        images = ['soloapp/' + service + ':' + tag for service in ('auth', 'whoami')]
        for service, image in zip(('auth', 'whoami'), images):
            print('Building ' + service + ' at ' + sha, flush=True)
            run(['docker', 'build', '--target', 'runtime', '--label', 'org.opencontainers.image.revision=' + sha,
                 '-f', 'services/' + service + '/deploy/Dockerfile', '-t', image, '.'], cwd=source)
        archive = STATE / ('images-' + sha + '.tar')
        try:
            run(['docker', 'save', '-o', str(archive)] + images)
            run(['k3s', 'ctr', 'images', 'import', str(archive)])
        finally:
            archive.unlink(missing_ok=True)
        # A short-lived, namespace-scoped token, held only in /run (tmpfs).
        with tempfile.TemporaryDirectory(prefix='soloapp-cd-', dir='/run') as temp:
            runtime = Path(temp)
            os.chown(runtime, 10004, 10004)
            kube = json.loads(run(['k3s', 'kubectl', 'config', 'view', '--raw', '-o', 'json'], capture=True))
            token = run(['k3s', 'kubectl', '-n', 'soloapp', 'create', 'token', 'cd-deployer', '--duration=20m'], capture=True).strip()
            kube['users'] = [{'name': 'cd', 'user': {'token': token}}]
            for context in kube['contexts']:
                context['context']['user'] = 'cd'
            extra = {'project_root': '/src', 'remote_root': '/manifests', 'ansible_connection': 'local',
                     'ansible_python_interpreter': '/usr/local/bin/python3', 'ansible_become': False,
                     'auth_image': images[0], 'whoami_image': images[1],
                     'cloud': json.loads(Path('/etc/soloapp-cd/resources.json').read_text())}
            for name, value in [('kubeconfig.json', kube), ('extra.json', extra)]:
                path = runtime / name
                path.write_text(json.dumps(value))
                os.chown(path, 10004, 10004)
            shutil.copyfile('/etc/soloapp-cd/inventory.yaml', runtime / 'inventory.yaml')
            os.chown(runtime / 'inventory.yaml', 10004, 10004)
            manifests = runtime / 'manifests'
            manifests.mkdir()
            os.chown(manifests, 10004, 10004)
            cmd = ['docker', 'run', '--rm', '--network', 'host', '--read-only', '--cap-drop=ALL',
                   '--security-opt', 'no-new-privileges', '--user', '10004:10004', '--tmpfs', '/tmp:rw,nosuid,nodev',
                   '-e', 'KUBECONFIG=/run/cd/kubeconfig.json', '-e', 'HOME=/tmp',
                   '-v', str(source) + ':/src:ro', '-v', str(runtime) + ':/run/cd:ro',
                   '-v', str(manifests) + ':/manifests',
                   '-w', '/src', 'soloapp/deploy-controller:1', '-i', '/run/cd/inventory.yaml',
                   'infra/ansible/apps.yaml', '--limit', cfg['site'], '-e', '@/run/cd/extra.json']
            # Validate before any mutation, then use existing rolling rollout gates.
            run(cmd + ['--check'])
            run(cmd)
        result = {'site': cfg['site'], 'revision': sha, 'images': images, 'status': 'deployed'}
        (STATE / 'deployed.json').write_text(json.dumps(result) + '\n')
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
