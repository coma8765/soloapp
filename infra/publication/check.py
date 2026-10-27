#!/usr/bin/env python3
"""Scan publishable worktree, exact index, and existing history without uploading data."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FORBIDDEN = {'infra/cloud/resources.json', 'infra/ansible/inventory.yaml', 'infra/ha/deployment-history.md'}


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def allowed(name):
    path = Path(name)
    if path.is_absolute() or '..' in path.parts or name in FORBIDDEN:
        return False
    if path.parts[0] in ('work', 'outputs', '.secrets') or any(part.startswith('.venv') for part in path.parts):
        return False
    if 'migrations' in path.parts or '__pycache__' in path.parts:
        return False
    if path.name.startswith('.env') and path.name != '.env.example':
        return False
    return path.suffix.lower() not in {'.pem', '.key', '.p12', '.pfx', '.tar', '.gz', '.db', '.sqlite', '.pyc'} and 'kubeconfig' not in path.name.lower()


def scan_snapshot(names, staged=False):
    count = 0
    with tempfile.TemporaryDirectory(prefix='soloapp-public-check-') as folder:
        snapshot = Path(folder)
        for name in sorted(set(names)):
            if not name:
                continue
            if not allowed(name):
                raise SystemExit('Forbidden publication path: ' + name)
            source = ROOT / name
            if staged:
                entry = git('ls-files', '-s', '--', name).decode()
                if not entry.startswith('100644 ') and not entry.startswith('100755 '):
                    raise SystemExit('Unsupported index file mode: ' + name)
                data = git('show', ':' + name)
            else:
                if source.is_symlink():
                    raise SystemExit('Symlinks require explicit publication review: ' + name)
                if not source.exists():
                    continue
                data = source.read_bytes()
            if len(data) > 2 * 1024 * 1024:
                raise SystemExit('Unexpected large publication file: ' + name)
            destination = snapshot / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            count += 1
        subprocess.run(['gitleaks', 'dir', str(snapshot), '--config', str(ROOT / '.gitleaks.toml'), '--redact=100', '--no-banner'], check=True)
    print(('Index' if staged else 'Working tree') + ': ' + str(count) + ' files passed', flush=True)


def main():
    if not shutil.which('gitleaks'):
        raise SystemExit('Install gitleaks before publication (for example: brew install gitleaks)')
    names = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').decode().split('\0')
    scan_snapshot(names)
    indexed = git('ls-files', '--cached', '-z').decode().split('\0')
    if any(indexed):
        scan_snapshot(indexed, staged=True)
    if subprocess.run(['git', 'rev-parse', '--verify', 'HEAD'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        subprocess.run(['gitleaks', 'git', str(ROOT), '--config', str(ROOT / '.gitleaks.toml'), '--redact=100', '--no-banner'], check=True)


if __name__ == '__main__':
    main()
