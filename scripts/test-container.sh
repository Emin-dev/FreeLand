#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# This script creates and removes only its own disposable synthetic resources.
prefix="freeland-test-${GITHUB_RUN_ID:-local}-$$"
image="$prefix:local"
container="$prefix-app"
volume="$prefix-data"
cleanup() {
  docker logs "$container" 2>/dev/null || true
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --pull --tag "$image" .
test "$(docker run --rm --entrypoint id "$image" -u)" != 0
docker run --rm --entrypoint bun "$image" -e '
  import { readdirSync } from "node:fs";
  const actual = readdirSync("/app").sort();
  const expected = ["index.html", "package.json", "security.js", "server.js", "storage.js"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Unexpected runtime image contents");
'

expect_start_failure() {
  local expected="$1"
  shift
  local output status
  set +e
  output=$(timeout 20s docker run --rm "$@" "$image" 2>&1)
  status=$?
  set -e
  if [[ "$status" == 0 || "$status" == 124 || "$output" != *"$expected"* ]]; then
    printf '%s\n' "$output"
    echo "Expected startup to reject invalid production configuration" >&2
    exit 1
  fi
}
expect_start_failure "HTTPS APP_ORIGIN"
expect_start_failure "HTTPS APP_ORIGIN" -e APP_ORIGIN=http://freeland-container.example
expect_start_failure "absolute DB_PATH" -e APP_ORIGIN=https://freeland-container.example -e DB_PATH=relative.sqlite

docker volume create "$volume" >/dev/null
start_app() {
  docker run --detach --name "$container" --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges \
    --publish 127.0.0.1::3000 \
    --mount "type=volume,source=$volume,target=/var/data" \
    -e APP_ORIGIN=https://freeland-container.example "$image" >/dev/null
}
wait_ready() {
  for _ in $(seq 1 30); do
    if docker exec "$container" bun -e 'const r = await fetch("http://127.0.0.1:3000/healthz"); process.exit(r.ok ? 0 : 1)' >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  echo "Container did not become ready" >&2
  exit 1
}
base_url() { printf 'http://%s' "$(docker port "$container" 3000/tcp)"; }
start_app
wait_ready
bun scripts/container-smoke.js "$(base_url)" seed
test "$(docker exec "$container" stat -c '%a' /var/data/freeland.sqlite)" = 600
test "$(docker exec "$container" stat -c '%a' /var/data/freeland.sqlite-wal)" = 600

# Recreate the container, preserving only its private volume. Merely restarting
# the same container would not catch accidental writes to the container layer.
docker stop --time 5 "$container" >/dev/null
docker rm "$container" >/dev/null
start_app
wait_ready
bun scripts/container-smoke.js "$(base_url)" restart
echo "Container image, fail-closed startup, realtime writes and durable storage passed"
