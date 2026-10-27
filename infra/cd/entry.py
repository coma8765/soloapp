#!/usr/bin/python3
"""Forced SSH command; never evaluate client input in a shell."""
import os
import re

command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
if command == 'probe':
    os.execv('/usr/bin/sudo', ['sudo', '-n', '/usr/local/libexec/soloapp-cd', 'probe'])
if not re.fullmatch(r'(deploy|publish) [0-9a-f]{40}', command):
    raise SystemExit('Only probe, deploy or publish <40-character main commit> is allowed')
os.execv('/usr/bin/sudo', ['sudo', '-n', '/usr/local/libexec/soloapp-cd', command.split()[1], command.split()[0]])
