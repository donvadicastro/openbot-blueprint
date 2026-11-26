#!/bin/sh
set -eu
network="ob-rebind-$$"
postgres="ob-rebind-db-$$"
barrier_directory=$(mktemp -d /tmp/obr-ready.XXXXXX)
readiness_provider_pid=
cleanup() {
  if [ -n "$readiness_provider_pid" ]; then kill -TERM "$readiness_provider_pid" >/dev/null 2>&1 || true; wait "$readiness_provider_pid" >/dev/null 2>&1 || true; fi
  docker rm -f "$postgres" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$barrier_directory"
}
trap cleanup EXIT
docker network create "$network" >/dev/null
docker run -d --rm --name "$postgres" --network "$network" --network-alias postgres -e POSTGRES_PASSWORD=probe pgvector/pgvector:pg17 >/dev/null
attempt=0
until docker exec "$postgres" pg_isready -U postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 30 ]; then exit 1; fi
  sleep 1
done
sleep 2
export LIVE_WORKFLOW_MODEL="${LIVE_WORKFLOW_MODEL:-}"
export LIVE_REAL_READINESS="${LIVE_REAL_READINESS:-}"
export LIVE_SKIP_LEAD="${LIVE_SKIP_LEAD:-}"
export LIVE_READINESS="${LIVE_READINESS:-}"
export LIVE_TEMP_PLAN="${LIVE_TEMP_PLAN:-}"
export LIVE_FEEDBACK="${LIVE_FEEDBACK:-}"
export LIVE_RELEASE_SUMMARY="${LIVE_RELEASE_SUMMARY:-}"
export LIVE_SWE_QA="${LIVE_SWE_QA:-}"
export LIVE_SWE_PM="${LIVE_SWE_PM:-}"
export LIVE_SKIP_PHASE="${LIVE_SKIP_PHASE:-}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-}"
docker exec -i "$postgres" psql -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create table users (id text primary key);
create table channels (id text primary key, deleted_at timestamptz);
create table channel_memberships (channel_id text, user_id text);
create table group_messages (id text primary key, channel_id text, owner_user_id text, agent_id text, status text);
create table intelligence_channel_mappings (channel_id text, user_id text, thread_id text);
create table blueprint_team_setup (thread_id text primary key, user_id text not null, submission jsonb not null);
create table channel_agents (channel_id text, agent_id text);
create table group_bot_threads (channel_id text, owner_user_id text, agent_id text, thread_id text);
create table work_items (kind text, key text, claimed_by text, finished_at timestamptz, lease_until timestamptz, payload jsonb, primary key(kind,key));
insert into users values ('owner');
SQL
for migration in deploy/openbot/product/migrations/*.sql; do
  docker exec -i "$postgres" psql -U postgres -v ON_ERROR_STOP=1 <"$migration" >/dev/null
done
if [ "$LIVE_REAL_READINESS" = 1 ]; then
  [ -n "$LIVE_WORKFLOW_MODEL" ] && [ "$LIVE_READINESS" = 1 ] || { echo 'Real readiness requires LIVE_WORKFLOW_MODEL and LIVE_READINESS=1.' >&2; exit 1; }
  npm run build --silent
  node "$PWD/test/integration/live-readiness-provider.mjs" "$postgres" "$barrier_directory" >"$barrier_directory/launcher.log" 2>&1 &
  readiness_provider_pid=$!
fi
docker run --rm --network "$network" --entrypoint bun -e LIVE_WORKFLOW_MODEL -e LIVE_REAL_READINESS -e LIVE_SKIP_LEAD -e LIVE_READINESS -e LIVE_TEMP_PLAN -e LIVE_FEEDBACK -e LIVE_RELEASE_SUMMARY -e LIVE_SWE_QA -e LIVE_SWE_PM -e LIVE_SKIP_PHASE -e OPENAI_BASE_URL -v "$barrier_directory:/tmp/live-readiness-provider:ro" -v "$PWD/test/integration/live-workflow-turn.ts:/app/server/live-workflow-turn.ts:ro" -v "$PWD/test/fixtures/blueprints/distinct-business:/fixture:ro" -v "$PWD/blueprints/software-development:/swe-fixture:ro" -v "$PWD/deploy/openbot/product/migrations:/app/server/src/product/migrations:ro" -v "$PWD/test/integration/project-initialization.ts:/tmp/probe.ts:ro" -v "$PWD/deploy/openbot/product/migrations/024-workspace-command.sql:/tmp/workspace-command-migration.sql:ro" -v "$PWD/deploy/openbot/product/access.ts:/app/server/src/product/access.ts:ro" -v "$PWD/deploy/openbot/product/channel-context.ts:/app/server/src/product/channel-context.ts:ro" -v "$PWD/deploy/openbot/product/native-context.ts:/app/server/src/product/native-context.ts:ro" -v "$PWD/deploy/openbot/product/module.ts:/app/server/src/product/module.ts:ro" -v "$PWD/deploy/openbot/product/native-feedback-tool.ts:/app/server/src/product/native-feedback-tool.ts:ro" -v "$PWD/deploy/openbot/product/native-workflow-tool.ts:/app/server/src/product/native-workflow-tool.ts:ro" -v "$PWD/deploy/openbot/product/native-project-tool.ts:/app/server/src/product/native-project-tool.ts:ro" -v "$PWD/deploy/openbot/product/native-action.ts:/app/server/src/product/native-action.ts:ro" -v "$PWD/deploy/openbot/product/native-workspace-tool.ts:/app/server/src/product/native-workspace-tool.ts:ro" -v "$PWD/deploy/openbot/product/delegation-guard.ts:/app/server/src/product/delegation-guard.ts:ro" -v "$PWD/deploy/openbot/product/workspace-actions.ts:/app/server/src/product/workspace-actions.ts:ro" -v "$PWD/deploy/openbot/product/workspace.ts:/app/server/src/product/workspace.ts:ro" -v "$PWD/deploy/openbot/product/feedback.ts:/app/server/src/product/feedback.ts:ro" -v "$PWD/deploy/openbot/product/legacy-projects.ts:/app/server/src/product/legacy-projects.ts:ro" -v "$PWD/deploy/openbot/product/routes.ts:/app/server/src/product/routes.ts:ro" -v "$PWD/deploy/openbot/product/chat-events.ts:/app/server/src/product/chat-events.ts:ro" -v "$PWD/deploy/openbot/product/workflow-decision.ts:/app/server/src/product/workflow-decision.ts:ro" -v "$PWD/deploy/openbot/product/workflow-reconcile.ts:/app/server/src/product/workflow-reconcile.ts:ro" -v "$PWD/deploy/openbot/product/work-query.ts:/app/server/src/product/work-query.ts:ro" -v "$PWD/deploy/openbot/product/store.ts:/app/server/src/product/store.ts:ro" -v "$PWD/deploy/openbot/product/projects.ts:/app/server/src/product/projects.ts:ro" -v "$PWD/deploy/openbot/product/readiness.ts:/app/server/src/product/readiness.ts:ro" -v "$PWD/deploy/openbot/product/native-readiness.ts:/app/server/src/product/native-readiness.ts:ro" -v "$PWD/deploy/openbot/product/readiness-workspace.ts:/app/server/src/product/readiness-workspace.ts:ro" -v "$PWD/deploy/openbot/product/readiness-gate.ts:/app/server/src/product/readiness-gate.ts:ro" -v "$PWD/deploy/openbot/product/workflow-activity-routes.ts:/app/server/src/product/workflow-activity-routes.ts:ro" -v "$PWD/deploy/openbot/product/actions.ts:/app/server/src/product/actions.ts:ro" -v "$PWD/deploy/openbot/product/phase-executor.ts:/app/server/src/product/phase-executor.ts:ro" -v "$PWD/deploy/openbot/product/phase-mcp.ts:/app/server/src/product/phase-mcp.ts:ro" -v "$PWD/deploy/openbot/product/release-preflight.ts:/app/server/src/product/release-preflight.ts:ro" -v "$PWD/deploy/openbot/product/release-proposal.ts:/app/server/src/product/release-proposal.ts:ro" -v "$PWD/deploy/openbot/product/release-approval.ts:/app/server/src/product/release-approval.ts:ro" -v "$PWD/deploy/openbot/product/release-effect.ts:/app/server/src/product/release-effect.ts:ro" -v "$PWD/deploy/openbot/product/release-deployment.ts:/app/server/src/product/release-deployment.ts:ro" -v "$PWD/deploy/openbot/product/staging-target.ts:/app/server/src/product/staging-target.ts:ro" -v "$PWD/deploy/openbot/product/phase-clarification.ts:/app/server/src/product/phase-clarification.ts:ro" -v "$PWD/deploy/openbot/product/phase-transition.ts:/app/server/src/product/phase-transition.ts:ro" -v "$PWD/deploy/openbot/product/phase-retry.ts:/app/server/src/product/phase-retry.ts:ro" -v "$PWD/deploy/openbot/product/phase-result.ts:/app/server/src/product/phase-result.ts:ro" -v "$PWD/deploy/openbot/product/phase-workspace.ts:/app/server/src/product/phase-workspace.ts:ro" -v "$PWD/deploy/openbot/product/swe-candidate.ts:/app/server/src/product/swe-candidate.ts:ro" -v "$PWD/deploy/openbot/product/swe-brief.ts:/app/server/src/product/swe-brief.ts:ro" -v "$PWD/deploy/openbot/product/swe-qa.ts:/app/server/src/product/swe-qa.ts:ro" -v "$PWD/deploy/openbot/product/qa-progress.ts:/app/server/src/product/qa-progress.ts:ro" -v "$PWD/deploy/openbot/product/phase-output.ts:/app/server/src/product/phase-output.ts:ro" -v "$PWD/deploy/openbot/product/phase-activity.ts:/app/server/src/product/phase-activity.ts:ro" -v "$PWD/deploy/openbot/product/workflow-engine.ts:/app/server/src/product/workflow-engine.ts:ro" -v "$PWD/deploy/openbot/product/workflow-inputs.ts:/app/server/src/product/workflow-inputs.ts:ro" -v "$PWD/deploy/openbot/product/workflow-routing.ts:/app/server/src/product/workflow-routing.ts:ro" "${OPENBOT_TEST_IMAGE:-openbot-blueprint-server:ab9855c19848}" /tmp/probe.ts
docker run --rm --network "$network" --entrypoint bun -v "$PWD/test/fixtures/blueprints/distinct-business:/fixture:ro" -v "$PWD/test/integration/feedback-restart.ts:/tmp/feedback-restart.ts:ro" -v "$PWD/deploy/openbot/product/feedback.ts:/app/server/src/product/feedback.ts:ro" "${OPENBOT_TEST_IMAGE:-openbot-blueprint-server:ab9855c19848}" /tmp/feedback-restart.ts
# Restore a logical snapshot into a separate disposable database and compare
# durable project data, including VM bindings and unconfirmed effects.
snapshot=$(mktemp)
trap 'rm -f "$snapshot"; cleanup' EXIT
docker exec "$postgres" pg_dump -U postgres -Fc postgres > "$snapshot"
docker exec "$postgres" createdb -U postgres restored
docker exec -i "$postgres" pg_restore -U postgres -d restored --exit-on-error < "$snapshot"
for table in bp_projects bp_project_vms bp_artifact_revisions bp_workflow_runs bp_release_effects; do
  original=$(docker exec "$postgres" psql -U postgres -d postgres -Atqc "select count(*) || ':' || md5(coalesce(string_agg(row_to_json(t)::text, ',' order by row_to_json(t)::text), '')) from $table t")
  restored=$(docker exec "$postgres" psql -U postgres -d restored -Atqc "select count(*) || ':' || md5(coalesce(string_agg(row_to_json(t)::text, ',' order by row_to_json(t)::text), '')) from $table t")
  if [ "$original" != "$restored" ]; then echo "Restored $table records differ" >&2; exit 1; fi
done
original=$(docker exec "$postgres" psql -U postgres -d postgres -Atqc "select coalesce(string_agg(row_to_json(v)::text, ',' order by project_id), '') from bp_project_vms v")
restored=$(docker exec "$postgres" psql -U postgres -d restored -Atqc "select coalesce(string_agg(row_to_json(v)::text, ',' order by project_id), '') from bp_project_vms v")
[ "$original" = "$restored" ] || { echo 'Restored VM bindings differ' >&2; exit 1; }
original=$(docker exec "$postgres" psql -U postgres -d postgres -Atqc "select coalesce(string_agg(row_to_json(e)::text, ',' order by project_id,run_id), '') from bp_release_effects e")
restored=$(docker exec "$postgres" psql -U postgres -d restored -Atqc "select coalesce(string_agg(row_to_json(e)::text, ',' order by project_id,run_id), '') from bp_release_effects e")
[ "$original" = "$restored" ] || { echo 'Restored release effect states differ' >&2; exit 1; }
uncertain=$(docker exec "$postgres" psql -U postgres -d restored -Atqc "select count(*) from bp_release_effects where state='Uncertain'")
[ "$uncertain" -gt 0 ] || { echo 'Restored snapshot lost its uncertain release effect' >&2; exit 1; }
echo 'Verified disposable project database snapshot restores artifact, workflow, release and VM binding records.'
docker run --rm --network "$network" --entrypoint bun -v "$PWD/test/integration/restored-uncertain.ts:/tmp/restored-uncertain.ts:ro" -v "$PWD/deploy/openbot/product/phase-activity.ts:/app/server/src/product/phase-activity.ts:ro" -v "$PWD/deploy/openbot/product/workflow-inputs.ts:/app/server/src/product/workflow-inputs.ts:ro" -v "$PWD/deploy/openbot/product/readiness-gate.ts:/app/server/src/product/readiness-gate.ts:ro" -v "$PWD/deploy/openbot/product/access.ts:/app/server/src/product/access.ts:ro" -v "$PWD/deploy/openbot/product/store.ts:/app/server/src/product/store.ts:ro" "${OPENBOT_TEST_IMAGE:-openbot-blueprint-server:ab9855c19848}" /tmp/restored-uncertain.ts
