#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
docker run --rm --entrypoint bun -v "$root/test/integration/remote-agui.ts:/app/server/remote-agui-fixture.ts:ro" "${OPENBOT_TEST_IMAGE:-openbot-blueprint-server:qa-verify}" /app/server/remote-agui-fixture.ts
