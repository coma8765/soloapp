#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
(cd /tmp && colima start --profile soloapp-local --cpu 8 --memory 12 --disk 48 --vm-type vz --runtime docker --kubernetes --activate=false --mount none --ssh-config=false --k3s-arg=--disable=traefik --k3s-arg=--secrets-encryption)
exec .venv-codegen/bin/python infra/local-macos/serve.py
