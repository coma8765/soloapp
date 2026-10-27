#!/usr/bin/env bash
# Run on the developer machine or GitHub runner, never on application servers.
set -euo pipefail
sha=${1:?full commit SHA required}
out=${2:?output directory required}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
mkdir -p "$out"
for service in auth whoami web; do
  docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
    --target runtime --label "org.opencontainers.image.revision=$sha" \
    -f "services/$service/deploy/Dockerfile" \
    --output "type=oci,dest=$out/$service.oci.tar" .
done
