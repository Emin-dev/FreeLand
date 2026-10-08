#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# This script creates and removes only its own disposable synthetic resources.
prefix="freeland-test-${GITHUB_RUN_ID:-local}-$$"
image="$prefix:local"
container="$prefix-app"
volume="$prefix-data"
restore_volume="$prefix-restore"
cleanup() {
  docker logs "$container" 2>/dev/null || true
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" "$restore_volume" >/dev/null 2>&1 || true
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
    --mount "type=volume,source=${1:-$volume},target=/var/data" \
    -e APP_ORIGIN=https://freeland-container.example "$image" >/dev/null
}
wait_ready() {
  for _ in $(seq 1 30); do
    if docker exec "$container" bun -e 'const r = await fetch("http://127.0.0.1:3000/healthz", { signal: AbortSignal.timeout(2000) }); process.exit(r.ok ? 0 : 1)' >/dev/null 2>&1; then
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
test "$(docker exec "$container" stat -c '%a' /var/data/freeland.sqlite-shm)" = 600

# Recreate the container, preserving only its private volume. Merely restarting
# the same container would not catch accidental writes to the container layer.
docker stop --time 5 "$container" >/dev/null
docker rm "$container" >/dev/null
start_app
wait_ready
bun scripts/container-smoke.js "$(base_url)" restart
# A consistent backup is taken while the WAL-mode source is still running.
# Copying the live main database alone would miss uncheckpointed transactions.
docker exec "$container" bun -e '
  import assert from "node:assert/strict";
  import { Database } from "bun:sqlite";
  import { statSync } from "node:fs";
  process.umask(0o077);
  const source = new Database("/var/data/freeland.sqlite", { readonly: true });
  assert.equal(source.query("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.ok(statSync("/var/data/freeland.sqlite-wal").size > 0);
  source.query("VACUUM INTO ?").run("/var/data/freeland-backup.sqlite");
  source.close();
  const backup = new Database("/var/data/freeland-backup.sqlite", { readonly: true });
  assert.deepEqual(backup.query("PRAGMA integrity_check").values(), [["ok"]]);
  assert.deepEqual(backup.query("PRAGMA foreign_key_check").values(), []);
  assert.equal(backup.query("SELECT coins FROM users WHERE username = ?").get("container_test").coins, 110);
  backup.close();
  assert.equal(statSync("/var/data/freeland-backup.sqlite").mode & 0o777, 0o600);
'
# This committed write must not appear after restoring the earlier snapshot.
bun scripts/container-smoke.js "$(base_url)" after-backup
docker stop --time 5 "$container" >/dev/null
docker rm "$container" >/dev/null

docker volume create "$restore_volume" >/dev/null
# Copy only the completed backup into a separate empty volume. The original
# volume is read-only to the helper and is never overwritten during recovery.
docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges --entrypoint bun \
  --mount "type=volume,source=$volume,target=/backup,readonly" \
  --mount "type=volume,source=$restore_volume,target=/var/data" "$image" -e '
  import assert from "node:assert/strict";
  import { Database } from "bun:sqlite";
  import { constants, copyFileSync, readdirSync, statSync } from "node:fs";
  process.umask(0o077);
  assert.deepEqual(readdirSync("/var/data"), []);
  copyFileSync("/backup/freeland-backup.sqlite", "/var/data/freeland.sqlite", constants.COPYFILE_EXCL);
  assert.equal(statSync("/var/data/freeland.sqlite").mode & 0o777, 0o600);
  const restored = new Database("/var/data/freeland.sqlite", { readonly: true });
  assert.deepEqual(restored.query("PRAGMA integrity_check").values(), [["ok"]]);
  assert.deepEqual(restored.query("PRAGMA foreign_key_check").values(), []);
  restored.close();
'
start_app "$restore_volume"
wait_ready
bun scripts/container-smoke.js "$(base_url)" restored
for file in freeland.sqlite freeland.sqlite-wal freeland.sqlite-shm; do
  test "$(docker exec "$container" stat -c '%a' "/var/data/$file")" = 600
done
echo "Container image, durable storage and independent-volume backup/restore passed"
