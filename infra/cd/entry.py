#!/usr/bin/python3
"""Forced SSH command; never evaluate client input in a shell."""

import os
import re

command = os.environ.get("SSH_ORIGINAL_COMMAND", "")
if command == "probe":
    os.execv("/usr/bin/sudo", ["sudo", "-n", "/usr/local/libexec/soloapp-cd", "probe"])
if not re.fullmatch(
    r"(deploy(?:-(?:auth|app-api|nginx|web|client-notify|client-gateway|keycloak|whisper|tts|all))?|publish|push-auth|push-whoami|push-web|push-client-notify|push-client-gateway|push-keycloak|push-whisper|push-tts|rollback(?:-(?:auth|app-api|nginx|web|client-notify|client-gateway|keycloak|whisper|tts|all))?) [0-9a-f]{40}",
    command,
):
    raise SystemExit("Only approved release operations with a full commit SHA are allowed")
os.execv(
    "/usr/bin/sudo",
    ["sudo", "-n", "/usr/local/libexec/soloapp-cd", command.split()[1], command.split()[0]],
)
