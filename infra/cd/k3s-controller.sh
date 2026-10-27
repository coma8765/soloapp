#!/bin/sh
# App playbooks use `k3s kubectl`; inside this controller use the pinned client.
set -eu
if [ "${1:-}" != kubectl ]; then
  echo 'Only kubectl is available in the deployment controller' >&2
  exit 2
fi
shift
exec /usr/local/bin/kubectl "$@"
