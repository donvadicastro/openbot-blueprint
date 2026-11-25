#!/bin/sh
set -eu

# Check an explicitly selected, previously built pinned verification image
# without touching any running OpenBot installation.
: "${OPENBOT_TEST_IMAGE:?Set OPENBOT_TEST_IMAGE to the pinned server image tag}"
image=$OPENBOT_TEST_IMAGE
docker run --rm --entrypoint sh "$image" -c 'cd /app && bun run --cwd server typecheck'
