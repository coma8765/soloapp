#!/usr/bin/env bash
set -euo pipefail
name="soloapp-world-test-$$"
cleanup() {
  docker rm -fv "$name" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create "$name" >/dev/null
docker run -d --name "$name" --network "$name" --network-alias postgres   -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-bookworm >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$name" pg_isready -U postgres >/dev/null; then break; fi
  sleep 1
done
docker exec -i "$name" psql -U postgres -v ON_ERROR_STOP=1 < services/soloapp_app/deploy/schema.sql
docker run --rm --network "$name" soloapp-test /src/build/world_store_test   'host=postgres dbname=postgres user=postgres sslmode=disable' /src/services/soloapp_app/src/data/lakes.json
