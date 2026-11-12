#!/bin/sh
set -eu
network="ob-rebind-$$"
postgres="ob-rebind-db-$$"
cleanup() {
  docker rm -f "$postgres" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
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
docker exec -i "$postgres" psql -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create table users (id text primary key);
create table channels (id text primary key, deleted_at timestamptz);
create table channel_memberships (channel_id text, user_id text);
create table group_messages (id text primary key, channel_id text, owner_user_id text, agent_id text, status text);
create table intelligence_channel_mappings (channel_id text, user_id text, thread_id text);
insert into users values ('owner');
SQL
for migration in deploy/openbot/product/migrations/*.sql; do
  docker exec -i "$postgres" psql -U postgres -v ON_ERROR_STOP=1 <"$migration" >/dev/null
done
docker run --rm --network "$network" --entrypoint bun -v "$PWD/test/fixtures/blueprints/distinct-business:/fixture:ro" -v "$PWD/test/integration/project-initialization.ts:/tmp/probe.ts:ro" -v "$PWD/deploy/openbot/product/feedback.ts:/app/server/src/product/feedback.ts:ro" -v "$PWD/deploy/openbot/product/routes.ts:/app/server/src/product/routes.ts:ro" "${OPENBOT_TEST_IMAGE:-openbot-blueprint-server:ab9855c19848}" /tmp/probe.ts
