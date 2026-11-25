#!/bin/sh
set -eu

# Runs a fixture specialist through the real Temporal worker and product database.
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
scratch=$(mktemp -d)
export COMPOSE_PROJECT_NAME="obadapter-$$"
export APP_PORT=$((20000 + $$ % 30000))
export WORKFLOW_WORKER_IMAGE="${COMPOSE_PROJECT_NAME}-workflow-worker:latest"
export WORKFLOW_POSTGRES_PASSWORD="temporary-test-password"
export WORKFLOW_ACTIVITY_TOKEN="temporary-activity-token-0123456789abcdef"
export WORKFLOW_ENGINE_TOKEN="temporary-engine-token-0123456789abcdef"
vm_directory=
vm_pid=
restore_provider_url=
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
  workflow-fixture:
    image: ${OPENBOT_TEST_IMAGE:-openbot-blueprint-server:ab9855c19848}
    entrypoint: ["bun", "/fixture-test/workflow-adapter-fixture.ts"]
    environment:
      WORKFLOW_ACTIVITY_TOKEN: \${WORKFLOW_ACTIVITY_TOKEN}
      WORKFLOW_ENGINE_TOKEN: \${WORKFLOW_ENGINE_TOKEN}
      WORKFLOW_ENGINE_URL: http://workflow-worker:4310
    volumes:
      - "$root/test/integration/workflow-adapter-fixture.ts:/fixture-test/workflow-adapter-fixture.ts:ro"
      - "$root/test/fixtures/blueprints/distinct-business:/fixture:ro"
    depends_on:
      project-postgres:
        condition: service_healthy
    networks: [workflow]
  workflow-worker:
    environment:
      OPENBOT_WORKFLOW_ACTIVITY_URL: http://workflow-fixture:4320
    depends_on:
      workflow-fixture:
        condition: service_started
EOF
compose() { docker compose -p "$COMPOSE_PROJECT_NAME" -f "$root/docker-compose.yml" -f "$scratch/override.yml" "$@"; }
cleanup() { docker rm -f "${COMPOSE_PROJECT_NAME}-restored-worker" "${COMPOSE_PROJECT_NAME}-restored-activity" "${COMPOSE_PROJECT_NAME}-temporal-restore" >/dev/null 2>&1 || true; docker network disconnect "${COMPOSE_PROJECT_NAME}-restore" "${COMPOSE_PROJECT_NAME}-workflow-postgres-1" >/dev/null 2>&1 || true; docker network disconnect "${COMPOSE_PROJECT_NAME}-restore" "${COMPOSE_PROJECT_NAME}-project-postgres-1" >/dev/null 2>&1 || true; docker network rm "${COMPOSE_PROJECT_NAME}-restore" >/dev/null 2>&1 || true; compose down -v --remove-orphans >/dev/null 2>&1 || true; if [ -n "$vm_pid" ]; then kill -TERM "$vm_pid" 2>/dev/null || true; wait "$vm_pid" 2>/dev/null || true; fi; if [ -n "$vm_directory" ]; then rm -rf "$vm_directory"; fi; rm -rf "$scratch"; }
trap cleanup EXIT HUP INT TERM
compose up -d --build workflow-worker
attempt=0
while :; do
  state=$(compose exec -T workflow-fixture bun -e 'try { const r=await fetch("http://127.0.0.1:4320/fixture-status"); const v=await r.json(); if(v.engineState==="uncertain" && v.turns===0 && v.effects===0) console.log("blocked"); } catch {}' 2>/dev/null || true)
  if [ "$state" = blocked ]; then break; fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then
    echo 'The feedback conflict did not hold the workflow.' >&2
    compose logs --tail 35 workflow-fixture workflow-worker >&2
    exit 1
  fi
  sleep 1
done
compose exec -T workflow-fixture bun -e 'const r=await fetch("http://127.0.0.1:4320/fixture-clarify",{method:"POST"}); if(!r.ok) process.exit(1)'
attempt=0
while :; do
  state=$(compose exec -T workflow-fixture bun -e 'try { const r=await fetch("http://127.0.0.1:4320/fixture-status"); const v=await r.json(); if(v.decision==="Pending" && v.decisionKind==="clarification" && v.turns===1 && v.effects===0) console.log("waiting"); } catch {}' 2>/dev/null || true)
  if [ "$state" = waiting ]; then break; fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then
    echo 'The disposable workflow did not reach its decision.' >&2
    compose logs --tail 35 workflow-fixture workflow-worker >&2
    exit 1
  fi
  sleep 1
done
# Stop the original worker before collecting both independently consistent
# snapshots, so this fixture has no in-flight product or Temporal activity.
compose stop workflow-worker >/dev/null
if [ "${OPENBOT_TEST_REAL_VM_RESTORE:-0}" = 1 ]; then
  npm run build --silent
  binding=$(compose exec -T project-postgres psql -U postgres -At -F '|' -c "select p.installation_id,p.id from bp_projects p join bp_workflow_runs r on r.project_id=p.id join bp_work_items w on (w.project_id,w.id)=(r.project_id,r.work_item_id) where w.request='Handle a service request.'")
  restore_install=${binding%%|*}
  restore_project=${binding#*|}
  case "$restore_install:$restore_project" in *[!a-zA-Z0-9:-]*|:*|*:) echo 'Invalid disposable VM binding.' >&2; exit 1;; esac
  vm_directory=$(mktemp -d /tmp/obrestore.XXXXXX)
  node "$root/test/integration/restored-vm-provider.mjs" "$vm_directory" "$restore_install" "$restore_project" >"$scratch/vm-provider.log" 2>&1 &
  vm_pid=$!
  attempt=0
  until [ -s "$vm_directory/provider.json" ]; do
    if ! kill -0 "$vm_pid" 2>/dev/null; then cat "$scratch/vm-provider.log" >&2; exit 1; fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 300 ]; then echo 'Restored VM provider did not become ready.' >&2; cat "$scratch/vm-provider.log" >&2; exit 1; fi
    sleep 1
  done
  vm_id=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).id' "$vm_directory/provider.json")
  vm_revision=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).revision' "$vm_directory/provider.json")
  vm_port=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).port' "$vm_directory/provider.json")
  case "$vm_id:$vm_revision:$vm_port" in *[!a-zA-Z0-9:-]*|::*|:*|*:) echo 'Invalid restored VM metadata.' >&2; exit 1;; esac
  compose exec -T project-postgres psql -U postgres -v ON_ERROR_STOP=1 -qc "update bp_project_vms set provider_id='$vm_id',source_revision='$vm_revision',state='Ready' where project_id='$restore_project'"
  restore_provider_url="http://host.docker.internal:$vm_port"
  echo 'Restored a disposable VM and held and reconciled its previously uncertain action.'
fi
compose exec -T project-postgres pg_dump -U postgres -Fc postgres > "$scratch/project.dump"
compose exec -T project-postgres createdb -U postgres project_restore_probe
compose exec -T project-postgres pg_restore -U postgres -d project_restore_probe --exit-on-error < "$scratch/project.dump"
# Capture the persisted Temporal database while the workflow is waiting, then
# restore it into a separate disposable database without touching the live one.
compose exec -T workflow-postgres pg_dump -U temporal -Fc temporal > "$scratch/temporal.dump"
compose exec -T workflow-postgres createdb -U temporal temporal_restore_probe
compose exec -T workflow-postgres pg_restore -U temporal -d temporal_restore_probe --exit-on-error < "$scratch/temporal.dump"
original=$(compose exec -T workflow-postgres psql -U temporal -d temporal -Atqc "select count(*) from executions")
restored=$(compose exec -T workflow-postgres psql -U temporal -d temporal_restore_probe -Atqc "select count(*) from executions")
[ "$original" = "$restored" ] && [ "$restored" -gt 0 ] || { echo 'Temporal history snapshot did not restore the waiting execution.' >&2; exit 1; }
echo 'Restored a disposable Temporal database snapshot containing the waiting execution.'
compose exec -T workflow-postgres pg_dump -U temporal -Fc temporal_visibility > "$scratch/visibility.dump"
compose exec -T workflow-postgres createdb -U temporal visibility_restore_probe
compose exec -T workflow-postgres pg_restore -U temporal -d visibility_restore_probe --exit-on-error < "$scratch/visibility.dump"
# The snapshot contains ephemeral membership for the old cluster. Remove it
# only from the disposable restored database before starting its new server.
compose exec -T workflow-postgres psql -U temporal -d temporal_restore_probe -v ON_ERROR_STOP=1 -qc 'delete from cluster_membership'
# Temporal checks the database name stored in schema_version at startup.
compose exec -T workflow-postgres psql -U temporal -d temporal_restore_probe -v ON_ERROR_STOP=1 -qc "update schema_version set db_name='temporal_restore_probe' where db_name='temporal'"
compose exec -T workflow-postgres psql -U temporal -d visibility_restore_probe -v ON_ERROR_STOP=1 -qc "update schema_version set db_name='visibility_restore_probe' where db_name='temporal_visibility'"
docker network create --internal "${COMPOSE_PROJECT_NAME}-restore" >/dev/null
docker network connect --alias restore-postgres "${COMPOSE_PROJECT_NAME}-restore" "${COMPOSE_PROJECT_NAME}-workflow-postgres-1"
docker network connect --alias restore-project-postgres "${COMPOSE_PROJECT_NAME}-restore" "${COMPOSE_PROJECT_NAME}-project-postgres-1"
docker run -d --name "${COMPOSE_PROJECT_NAME}-temporal-restore" --network "${COMPOSE_PROJECT_NAME}-restore" \
  -e DB=postgres12 -e DB_PORT=5432 -e POSTGRES_USER=temporal -e POSTGRES_PWD="$WORKFLOW_POSTGRES_PASSWORD" \
  -e SQL_PASSWORD="$WORKFLOW_POSTGRES_PASSWORD" -e POSTGRES_SEEDS=restore-postgres -e BIND_ON_IP=0.0.0.0 \
  -e DBNAME=temporal_restore_probe -e VISIBILITY_DBNAME=visibility_restore_probe \
  -e SKIP_DB_CREATE=true -e SKIP_SCHEMA_SETUP=true -e SKIP_DEFAULT_NAMESPACE_CREATION=true \
  temporalio/auto-setup:1.29.7 >/dev/null
attempt=0
until docker exec "${COMPOSE_PROJECT_NAME}-temporal-restore" temporal operator cluster health --address 127.0.0.1:7233 >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 90 ]; then echo 'The restored Temporal instance did not become healthy.' >&2; docker logs --tail 30 "${COMPOSE_PROJECT_NAME}-temporal-restore" >&2; exit 1; fi
  sleep 1
done
docker exec "${COMPOSE_PROJECT_NAME}-temporal-restore" temporal workflow list --address 127.0.0.1:7233 --namespace default > "$scratch/restored-workflows.txt"
if ! grep -q 'openbot-' "$scratch/restored-workflows.txt"; then echo 'The restored Temporal instance did not expose the waiting workflow.' >&2; cat "$scratch/restored-workflows.txt" >&2; exit 1; fi
echo 'A separate Temporal instance started from the restored databases and exposed the workflow.'
workflow_id=$(grep -o 'openbot-[a-f0-9]*' "$scratch/restored-workflows.txt" | head -1)
[ -n "$workflow_id" ] || { echo 'Restored workflow identifier is missing.' >&2; exit 1; }
docker run -d --name "${COMPOSE_PROJECT_NAME}-restored-activity" --network "${COMPOSE_PROJECT_NAME}-restore" \
  -e WORKFLOW_ACTIVITY_TOKEN="$WORKFLOW_ACTIVITY_TOKEN" -e WORKFLOW_ENGINE_TOKEN="$WORKFLOW_ENGINE_TOKEN" \
  -e RESTORED_VM_PROVIDER_URL="$restore_provider_url" \
  -e WORKFLOW_ENGINE_URL="http://${COMPOSE_PROJECT_NAME}-restored-worker:4310" \
  -v "$root/test/integration/restored-product-fixture.ts:/tmp/restored-product-fixture.ts:ro" \
  -v "$root/test/fixtures/blueprints/distinct-business:/fixture:ro" \
  --entrypoint bun "${OPENBOT_TEST_IMAGE:-openbot-blueprint-server:ab9855c19848}" /tmp/restored-product-fixture.ts >/dev/null
if [ -n "$restore_provider_url" ]; then docker network connect bridge "${COMPOSE_PROJECT_NAME}-restored-activity"; fi
docker run -d --name "${COMPOSE_PROJECT_NAME}-restored-worker" --network "${COMPOSE_PROJECT_NAME}-restore" \
  -e TEMPORAL_ADDRESS="${COMPOSE_PROJECT_NAME}-temporal-restore:7233" -e TEMPORAL_NAMESPACE=default \
  -e TEMPORAL_TASK_QUEUE=openbot-business -e OPENBOT_WORKFLOW_ACTIVITY_URL="http://${COMPOSE_PROJECT_NAME}-restored-activity:4320" \
  -e WORKFLOW_ACTIVITY_TOKEN="$WORKFLOW_ACTIVITY_TOKEN" -e WORKFLOW_ENGINE_TOKEN="$WORKFLOW_ENGINE_TOKEN" \
  "$WORKFLOW_WORKER_IMAGE" >/dev/null
attempt=0
until docker exec "${COMPOSE_PROJECT_NAME}-temporal-restore" temporal workflow query --address 127.0.0.1:7233 --namespace default \
  --workflow-id "$workflow_id" --type snapshot > "$scratch/restored-snapshot.txt" 2>/dev/null && grep -q 'waiting' "$scratch/restored-snapshot.txt"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then echo 'The restored worker could not replay the waiting workflow.' >&2; docker logs --tail 30 "${COMPOSE_PROJECT_NAME}-restored-worker" >&2; exit 1; fi
  sleep 1
done
echo 'A separate worker replayed the restored workflow and recovered its decision wait.'
docker exec "${COMPOSE_PROJECT_NAME}-restored-activity" bun -e 'const r=await fetch("http://127.0.0.1:4320/fixture-answer",{method:"POST"}); if(!r.ok) process.exit(1)'
attempt=0
while :; do
  state=$(docker exec "${COMPOSE_PROJECT_NAME}-restored-activity" bun -e 'try { const v=await (await fetch("http://127.0.0.1:4320/fixture-status")).json(); if(v.kind==="choice" && v.turns===2 && v.effects===1) console.log("waiting"); } catch {}' 2>/dev/null || true)
  [ "$state" = waiting ] && break
  attempt=$((attempt+1)); if [ "$attempt" -ge 90 ]; then echo 'Restored product did not reach its next decision.' >&2; docker logs --tail 30 "${COMPOSE_PROJECT_NAME}-restored-activity" >&2; exit 1; fi
  sleep 1
done
docker exec "${COMPOSE_PROJECT_NAME}-restored-activity" bun -e 'const r=await fetch("http://127.0.0.1:4320/fixture-answer",{method:"POST"}); if(!r.ok) process.exit(1)'
attempt=0
while :; do
  state=$(docker exec "${COMPOSE_PROJECT_NAME}-restored-activity" bun -e 'try { const v=await (await fetch("http://127.0.0.1:4320/fixture-status")).json(); if(v.state==="Completed" && v.turns===2 && v.effects===1) console.log("complete"); } catch {}' 2>/dev/null || true)
  [ "$state" = complete ] && break
  attempt=$((attempt+1)); if [ "$attempt" -ge 90 ]; then echo 'Restored product workflow did not complete.' >&2; docker logs --tail 30 "${COMPOSE_PROJECT_NAME}-restored-activity" >&2; exit 1; fi
  sleep 1
done
compose exec -T workflow-fixture bun -e 'const v=await (await fetch("http://127.0.0.1:4320/fixture-status")).json(); if(v.decision!=="Pending" || v.turns!==1 || v.effects!==0) process.exit(1)'
echo 'Restored product and Temporal completed the workflow with one fixture effect while the original remained waiting.'
if [ -n "$restore_provider_url" ]; then
  node -e 'const [port,installationId,projectId]=process.argv.slice(1); const r=await fetch(`http://127.0.0.1:${port}/run`,{method:"POST",headers:{authorization:"Bearer restore-fixture-provider-token-0123456789","content-type":"application/json"},body:JSON.stringify({installationId,projectId,operationKey:"restore-verification",argv:["sh","-c","cat restored-workflow"]})}); const v=await r.json(); if(!r.ok||v.status!=="completed"||v.exitCode!==0||v.stdout!=="x") throw Error("Restored VM workflow effect was not exactly once.");' "$vm_port" "$restore_install" "$restore_project"
  echo 'The restored product and Temporal worker used the restored VM and produced one real guest effect.'
fi



compose stop workflow-worker >/dev/null
compose exec -T workflow-fixture bun -e 'const r=await fetch("http://127.0.0.1:4320/fixture-answer",{method:"POST"}); if(!r.ok) process.exit(1)'
compose start workflow-worker >/dev/null
compose exec -T workflow-fixture bun -e 'await fetch("http://127.0.0.1:4320/fixture-retry",{method:"POST"})'
attempt=0
while :; do
  compose exec -T workflow-fixture bun -e 'await fetch("http://127.0.0.1:4320/fixture-retry",{method:"POST"})' >/dev/null 2>&1 || true
  state=$(compose exec -T workflow-fixture bun -e 'try { const r=await fetch("http://127.0.0.1:4320/fixture-status"); const v=await r.json(); if(v.decision==="Pending" && v.decisionKind==="choice" && v.turns===2 && v.effects===1) console.log("waiting"); } catch {}' 2>/dev/null || true)
  if [ "$state" = waiting ]; then break; fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then
    echo 'The specialist did not continue after clarification.' >&2
    compose logs --tail 35 workflow-fixture workflow-worker >&2
    exit 1
  fi
  sleep 1
done
compose stop workflow-worker >/dev/null
compose exec -T workflow-fixture bun -e 'const r=await fetch("http://127.0.0.1:4320/fixture-answer",{method:"POST"}); if(!r.ok) process.exit(1)'
compose start workflow-worker >/dev/null
attempt=0
while :; do
  compose exec -T workflow-fixture bun -e 'await fetch("http://127.0.0.1:4320/fixture-retry",{method:"POST"})' >/dev/null 2>&1 || true
  state=$(compose exec -T workflow-fixture bun -e 'try { const r=await fetch("http://127.0.0.1:4320/fixture-status"); const v=await r.json(); if(v.state==="Completed" && v.turns===2 && v.effects===1) console.log("complete"); } catch {}' 2>/dev/null || true)
  if [ "$state" = complete ]; then break; fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then
    echo 'The disposable workflow did not complete.' >&2
    compose logs --tail 35 workflow-fixture workflow-worker >&2
    exit 1
  fi
  sleep 1
done
compose exec -T workflow-fixture bun -e 'const r=await fetch("http://127.0.0.1:4320/fixture-start-safe-retry",{method:"POST"}); if(!r.ok) process.exit(1)'
attempt=0
while :; do
  state=$(compose exec -T workflow-fixture bun -e 'try { const r=await fetch("http://127.0.0.1:4320/fixture-safe-retry-status"); const v=await r.json(); if(v.state==="Running" && v.turns===1 && v.retries===1) console.log("waiting"); } catch {}' 2>/dev/null || true)
  if [ "$state" = waiting ]; then break; fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then echo 'The safe retry did not enter its delay.' >&2; compose logs --tail 35 workflow-fixture workflow-worker >&2; exit 1; fi
  sleep 1
done
compose stop workflow-worker >/dev/null
compose exec -T workflow-fixture bun -e 'const v=await (await fetch("http://127.0.0.1:4320/fixture-safe-retry-status")).json(); if(v.turns!==1 || v.retries!==1) process.exit(1)'
compose start workflow-worker >/dev/null
for decision_kind in clarification choice; do
  attempt=0
  while :; do
    state=$(compose exec -T workflow-fixture bun -e 'try { const v=await (await fetch("http://127.0.0.1:4320/fixture-safe-retry-status")).json(); if(v.kind===process.argv[1] && v.retries===1) console.log("waiting"); } catch {}' "$decision_kind" 2>/dev/null || true)
    [ "$state" = waiting ] && break
    attempt=$((attempt+1)); if [ "$attempt" -ge 120 ]; then echo "Temporary workflow did not reach $decision_kind." >&2; compose logs --tail 35 workflow-fixture workflow-worker >&2; exit 1; fi
    sleep 1
done
  compose stop workflow-worker >/dev/null
  compose exec -T workflow-fixture bun -e 'const r=await fetch("http://127.0.0.1:4320/fixture-safe-retry-answer",{method:"POST"}); if(!r.ok) process.exit(1)'
  compose start workflow-worker >/dev/null
done
attempt=0
while :; do
  state=$(compose exec -T workflow-fixture bun -e 'try { const v=await (await fetch("http://127.0.0.1:4320/fixture-safe-retry-status")).json(); if(v.state==="Completed" && v.turns===3 && v.retries===1) console.log("complete"); } catch {}' 2>/dev/null || true)
  [ "$state" = complete ] && break
  attempt=$((attempt+1)); if [ "$attempt" -ge 120 ]; then echo 'The temporary workflow did not complete after worker replacement.' >&2; compose logs --tail 35 workflow-fixture workflow-worker >&2; exit 1; fi
  sleep 1
done
echo 'Published and temporary workflows survived decision waits and worker replacement; the temporary retry did not repeat a failed turn.'
