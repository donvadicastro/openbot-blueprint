#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
scratch=$(mktemp -d)
container="openbot-chat-ui-$$"
image="openbot-blueprint-chat-ui-test:local"
chrome=${CHROME_BIN:-'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}
cleanup() {
  docker stop "$container" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT HUP INT TERM
if [ ! -x "$chrome" ]; then
  echo 'Set CHROME_BIN to a Chrome or Chromium executable.' >&2
  exit 1
fi

docker buildx build --load --target app-build \
  --build-context 'openbot-source=https://github.com/CopilotKit/OpenBot.git#ab9855c19848378c90a806426130d86699cc798c' \
  -t "$image" -f "$root/deploy/openbot/server.Dockerfile" "$root" >/dev/null

docker run -d --rm --name "$container" -p 127.0.0.1::5174 \
  -v "$root/test/integration/chat-ui/harness.html:/app/app/harness.html:ro" \
  -v "$root/test/integration/chat-ui/harness.tsx:/app/app/harness.tsx:ro" \
  -v "$root/test/integration/chat-ui/recovery.html:/app/app/recovery.html:ro" \
  -v "$root/test/integration/chat-ui/recovery.tsx:/app/app/recovery.tsx:ro" \
  --entrypoint sh "$image" -c 'cd /app/app && bun node_modules/vite/bin/vite.js --host 0.0.0.0 --port 5174 --strictPort' >/dev/null
address=$(docker port "$container" 5174/tcp)
port=${address##*:}
attempt=0
until curl -fsS "http://127.0.0.1:$port/harness.html" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then docker logs "$container" >&2; exit 1; fi
  sleep 1
done
"$chrome" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$scratch/chrome-profile" --virtual-time-budget=12000 --dump-dom \
  "http://127.0.0.1:$port/harness.html" >"$scratch/result.html" 2>"$scratch/chrome.log"
if ! rg -q 'data-test-result="PASS"' "$scratch/result.html"; then
  cat "$scratch/result.html" >&2
  cat "$scratch/chrome.log" >&2
  exit 1
fi
"$chrome" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$scratch/recovery-profile" --virtual-time-budget=12000 --dump-dom \
  "http://127.0.0.1:$port/recovery.html" >"$scratch/recovery-result.html" 2>"$scratch/recovery-chrome.log"
if ! rg -q 'data-test-result="PASS"' "$scratch/recovery-result.html"; then
  cat "$scratch/recovery-result.html" >&2
  cat "$scratch/recovery-chrome.log" >&2
  exit 1
fi
echo 'Projects page recovery control passed in Chrome.'
echo 'Chat UI fixture: QA progress, structured role fields, release evidence, approval, verified outcome, and recovery passed in Chrome.'
