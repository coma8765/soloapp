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
  client-notify) services=(client-notify) ;;
  client-gateway) services=(client-gateway) ;;
  keycloak) services=(keycloak) ;;
  whisper) services=(whisper) ;;
  tts) services=(tts) ;;
  llama) services=(llama) ;;
  all) services=(auth whoami web client-notify client-gateway keycloak whisper tts llama) ;;
  *) echo 'Expected auth, app-api, web, client-notify, client-gateway, keycloak, whisper, tts, llama or all' >&2; exit 2 ;;
esac
for service in "${services[@]}"; do
  dockerfile="services/$service/deploy/Dockerfile"
  # Keep the deployed image identity for digest-based rollback compatibility.
  if [ "$service" = whoami ]; then dockerfile=services/soloapp_app/deploy/Dockerfile; fi
  if [ "$service" = whisper ] && [ -n "${WHISPER_BASE_CACHE:-}" ]; then
    base_options=()
    if [ "${REFRESH_WHISPER_BASE:-false}" = true ]; then
      base_options+=(--pull --no-cache-filter model,runtime-base)
    elif [ -f "$WHISPER_BASE_CACHE/index.json" ]; then
      base_options+=(--cache-from "type=local,src=$WHISPER_BASE_CACHE")
    fi
    docker buildx build --platform linux/amd64 --target runtime-base \
      "${base_options[@]}" --cache-to "type=local,dest=$WHISPER_BASE_CACHE,mode=min" \
      -f "$dockerfile" .
  fi
  docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
    --target runtime --label "org.opencontainers.image.revision=$sha" --label "org.opencontainers.image.version=${RELEASE_VERSION:-$sha}" \
    -f "$dockerfile" \
    --output "type=oci,dest=$out/$service.oci.tar" .
done
