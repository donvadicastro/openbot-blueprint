#!/bin/sh
set -eu

# Disposable Compose project: a real Temporal worker interrupts a release deploy
# after the staging target commits the effect but loses its first response.
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
scratch=$(mktemp -d)
export COMPOSE_PROJECT_NAME="obrelease-$$"
export APP_PORT=$((20000 + $$ % 30000))
export WORKFLOW_POSTGRES_PASSWORD="temporary-test-password"
export WORKFLOW_ACTIVITY_TOKEN="temporary-activity-token-0123456789abcdef"
export WORKFLOW_ENGINE_TOKEN="temporary-engine-token-0123456789abcdef"
export STAGING_TARGET_TOKEN="disposable-staging-fixture-token-0123456789"
export STAGING_TARGET_ID="staging-fixture"
cat > "$scratch/override.yml" <<EOF
services:
  project-postgres:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: fixture
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      timeout: 3s
      retries: 30
    networks: [workflow]
  staging-fixture:
    image: openbot-blueprint-staging-fixture:local
    build:
      context: "$root"
      dockerfile: deploy/workflow/staging-fixture.Dockerfile
    environment:
      STAGING_TARGET_TOKEN: \${STAGING_TARGET_TOKEN}
      STAGING_DROP_FIRST_RECEIPT: each
    volumes:
      - staging-data:/data
    networks: [workflow]
  workflow-fixture:
    image: ${OPENBOT_TEST_IMAGE:-openbot-blueprint-server:ab9855c19848}
    entrypoint: ["bun", "/fixture-test/release-recovery-fixture.ts"]
    environment:
      WORKFLOW_ACTIVITY_TOKEN: \${WORKFLOW_ACTIVITY_TOKEN}
      WORKFLOW_ENGINE_TOKEN: \${WORKFLOW_ENGINE_TOKEN}
      WORKFLOW_ENGINE_URL: http://workflow-worker:4310
      STAGING_TARGET_URL: http://staging-fixture:4520
      STAGING_TARGET_TOKEN: \${STAGING_TARGET_TOKEN}
      STAGING_TARGET_ID: \${STAGING_TARGET_ID}
    volumes:
      - "$root/test/integration/release-recovery-fixture.ts:/fixture-test/release-recovery-fixture.ts:ro"
      - "$root/blueprints/software-development:/swe-fixture:ro"
    depends_on:
      project-postgres:
        condition: service_healthy
      staging-fixture:
        condition: service_started
    networks: [workflow]
  workflow-worker:
    environment:
      OPENBOT_WORKFLOW_ACTIVITY_URL: http://workflow-fixture:4320
    depends_on:
      workflow-fixture:
        condition: service_started
volumes:
  staging-data:
EOF
compose() { docker compose -p "$COMPOSE_PROJECT_NAME" -f "$root/docker-compose.yml" -f "$scratch/override.yml" "$@"; }
cleanup() { compose down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT HUP INT TERM
compose up -d --build workflow-worker

wait_for() {
  description=$1
  shift
  attempt=0
  while ! "$@" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 150 ]; then
      echo "Timed out waiting for $description." >&2
      compose logs --tail 60 workflow-fixture workflow-worker staging-fixture >&2
      exit 1
    fi
    sleep 1
  done
}

fixture_ready() {
  compose exec -T workflow-fixture bun -e 'const r=await fetch("http://127.0.0.1:4320/fixture-ready"); process.exit(r.ok?0:1)'
}
start_runs() {
  compose exec -T workflow-fixture bun -e 'const r=await fetch("http://127.0.0.1:4320/fixture-start",{method:"POST"}); if(!r.ok){console.error(await r.text());process.exit(1)}'
}
wait_uncertain() {
  compose exec -T workflow-fixture bun -e 'const r=await fetch("http://127.0.0.1:4320/fixture-status"); const v=await r.json(); if(v.published?.state==="uncertain" && v.temporary?.state==="uncertain") process.exit(0); console.error(JSON.stringify(v)); process.exit(1)'
}
# The worker is stopped here, so read the durable effect rows instead of the gateway.
effects_held() {
  compose exec -T project-postgres psql -U postgres -d postgres -tAc \
    "select count(*) from bp_release_effects where run_id in ('release-published','release-temporary') and state='Uncertain' and receipt is null" |
    grep -qx 2
}
effects_exactly_two() {
  compose exec -T project-postgres psql -U postgres -d postgres -tAc \
    "select count(*) from bp_release_effects where run_id in ('release-published','release-temporary') and state='Confirmed' and receipt is not null" |
    grep -qx 2
}
worker_ready() {
  compose exec -T workflow-worker node -e 'const s=require("net").connect(4310,"127.0.0.1");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))'
}
reconcile_runs() {
  compose exec -T workflow-fixture bun -e 'const r=await fetch("http://127.0.0.1:4320/fixture-reconcile",{method:"POST"}); if(!r.ok){console.error(await r.text());process.exit(1)}'
}
wait_complete() {
  compose exec -T workflow-fixture bun -e 'const r=await fetch("http://127.0.0.1:4320/fixture-status"); const v=await r.json(); if(v.published?.state==="complete" && v.temporary?.state==="complete") process.exit(0); console.error(JSON.stringify(v)); process.exit(1)'
}
verify_runs() {
  compose exec -T workflow-fixture bun -e 'const r=await fetch("http://127.0.0.1:4320/fixture-verify"); if(!r.ok){console.error(await r.text());process.exit(1)}'
}
one_effect_per_run() {
  compose exec -T staging-fixture node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db=new DatabaseSync("/data/staging.sqlite"); const count=db.prepare("select count(*) as count from effects").get().count; db.close(); if(count!==2){console.error(`expected 2 effects, found ${count}`);process.exit(1)}'
}

wait_for "the release fixture" fixture_ready
wait_for "the workflow gateway" worker_ready
start_runs
wait_for "both deployments to become uncertain" wait_uncertain
wait_for "both staging effects to be committed but unconfirmed" effects_held

# Interrupt the worker while both runs are held on the committed-but-unconfirmed
# staging effect, then restart it and reconcile by operation ID.
compose stop workflow-worker >/dev/null
effects_held
compose start workflow-worker >/dev/null
wait_for "the restarted workflow worker" worker_ready
reconcile_runs
wait_for "both workflows to complete after reconciliation" wait_complete
verify_runs
wait_for "both release effects to confirm exactly once" effects_exactly_two
one_effect_per_run

echo 'Release recovery: published and temporary workflows survived worker interruption with one verified staging effect each.'
