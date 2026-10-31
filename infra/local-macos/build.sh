#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
context=colima-soloapp-local
# Explicit context prevents accidentally building on another Docker host.
for service in auth soloapp_app client-gateway client-notify; do
  docker --context "$context" build --platform linux/arm64 --target runtime -t "soloapp-local/$service:dev" -f "services/$service/deploy/Dockerfile" .
done
docker --context "$context" build --platform linux/arm64 -t soloapp-local/web-origin:dev -f services/web/deploy/Dockerfile .
