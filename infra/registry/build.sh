#!/usr/bin/env bash
# Run on the developer machine or GitHub runner, never on application servers.
set -euo pipefail
sha=${1:?full commit SHA required}
out=${2:?output directory required}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
mkdir -p "$out"
scope=${3:-all}
case "$scope" in
  auth) services=(auth) ;;
  app-api) services=(whoami) ;;
  web) services=(web) ;;
  all) services=(auth whoami web) ;;
  *) echo 'Expected auth, app-api, web or all' >&2; exit 2 ;;
esac
for service in "${services[@]}"; do
  docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
    --target runtime --label "org.opencontainers.image.revision=$sha" --label "org.opencontainers.image.version=${RELEASE_VERSION:-$sha}" \
    -f "services/$service/deploy/Dockerfile" \
    --output "type=oci,dest=$out/$service.oci.tar" .
done
