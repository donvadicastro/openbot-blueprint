#!/bin/sh
set -eu

# Disposable Compose project: never operate on an existing installation.
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
scratch=$(mktemp -d)
export COMPOSE_PROJECT_NAME="obwf-$$"
export APP_PORT=$((20000 + $$ % 30000))
export WORKFLOW_POSTGRES_PASSWORD="temporary-test-password"
export WORKFLOW_ACTIVITY_TOKEN="temporary-activity-token-0123456789abcdef"
export WORKFLOW_ENGINE_TOKEN="temporary-engine-token-0123456789abcdef"
cat > "$scratch/override.yml" <<EOF
services:
  workflow-fixture:
    image: node:22-bookworm-slim
    command: ["node", "/fixture/temporal-fixture.mjs"]
    environment:
      WORKFLOW_ACTIVITY_TOKEN: \${WORKFLOW_ACTIVITY_TOKEN}
    volumes:
      - "$root/test/integration/temporal-fixture.mjs:/fixture/temporal-fixture.mjs:ro"
      - "fixture-data:/data"
    networks: [workflow]
  workflow-worker:
    environment:
      OPENBOT_WORKFLOW_ACTIVITY_URL: http://workflow-fixture:4320
    volumes:
      - "$root/test/integration/temporal-client.mjs:/tmp/temporal-client.mjs:ro"
    depends_on:
      workflow-fixture:
        condition: service_started
volumes:
  fixture-data:
EOF
compose() { docker compose -p "$COMPOSE_PROJECT_NAME" -f "$root/docker-compose.yml" -f "$scratch/override.yml" "$@"; }
cleanup() { compose down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT HUP INT TERM
compose up -d --build workflow-worker
wait_worker() {
  attempt=0
  until compose exec -T workflow-worker node -e 'const s=require("net").connect(4310,"127.0.0.1");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))' >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 120 ]; then echo 'Workflow worker did not become ready.' >&2; return 1; fi
    sleep 1
  done
}
wait_worker
compose exec -T workflow-worker node /tmp/temporal-client.mjs start
compose stop workflow-worker
compose restart temporal
compose up -d workflow-worker
wait_worker
compose exec -T workflow-worker node /tmp/temporal-client.mjs resume
test "$(compose exec -T workflow-fixture cat /data/effects)" = effect
echo 'Disposable Compose restart and effect reconciliation passed.'
