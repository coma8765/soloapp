#!/bin/bash
set -euo pipefail
# Bootstrap password is delivered in tmpfs, never in a manifest or command argument.
if [ -s /run/soloapp-secrets/data/bootstrap-password ]; then
  export KC_BOOTSTRAP_ADMIN_USERNAME=bootstrap-admin
  KC_BOOTSTRAP_ADMIN_PASSWORD=$(cat /run/soloapp-secrets/data/bootstrap-password)
  export KC_BOOTSTRAP_ADMIN_PASSWORD
fi
exec /opt/keycloak/bin/kc.sh --config-file=/run/soloapp-secrets/data/keycloak.conf start --optimized
