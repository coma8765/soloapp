"""Versioned web bundle validation; never extract an incoming archive to disk."""
import hashlib
import io
import json
import re
import tarfile
from pathlib import PurePosixPath

MAX_BUNDLE = 128 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024


def revision(value):
    if not re.fullmatch(r'[0-9a-f]{40}', value): raise ValueError('Invalid release SHA')
    return value


def safe_path(value):
    parts = PurePosixPath(value).parts
    if not parts or value.startswith('/') or '\\' in value or any(x in ('', '.', '..') for x in value.split('/')):
        raise ValueError('Unsafe release path')
    if not re.fullmatch(r'[A-Za-z0-9_./@+-]+', value): raise ValueError('Unsupported release filename')
    return value


def unpack(data, sha):
    revision(sha)
    if len(data) > MAX_BUNDLE: raise ValueError('Bundle too large')
    files = {}; size = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for number, member in enumerate(archive):
            if number >= 4096: raise ValueError('Too many files')
            name = member.name.removeprefix('./')
            if member.isdir(): continue
            safe_path(name)
            if name in ('_release.json', 'committed.json'): raise ValueError('Reserved manifest name')
            if not member.isfile() or name in files: raise ValueError('Non-regular or duplicate member')
            size += member.size
            if size > MAX_EXPANDED: raise ValueError('Expanded bundle too large')
            files[name] = archive.extractfile(member).read()
    if not {'index.html', 'flutter_bootstrap.js', 'main.dart.js'} <= files.keys():
        raise ValueError('Incomplete Flutter build')
    if f'/web/releases/{sha}/'.encode() not in files['index.html']:
        raise ValueError('Bundle base href disagrees with revision')
    manifest = {'revision': sha, 'files': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}}
    return files, json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
