# Deployment review and runbook

This repository includes a production-mode Docker image and a proposed Render
Blueprint. They preserve the Bun, SQLite, and vanilla-client stack. They do not
create a hosting account, purchase a service, or establish that a public
deployment is safe. Keep the pull request in draft until the review gates below
are resolved.

## Architecture

Serve the HTML client, HTTP API, and WebSocket endpoint from one HTTPS origin.
The image starts one Bun process on `0.0.0.0:$PORT`. A trusted host terminates
TLS and forwards HTTP and WebSocket traffic to that process. The browser uses
same-origin cookies and `wss:`. GitHub Pages alone cannot provide this backend;
do not advertise a static Pages copy as a functioning full application.

SQLite lives outside the application directory at
`/var/data/freeland.sqlite`. Its database, WAL, and SHM files must remain on the
same private persistent volume. The application has no third-party runtime
dependencies; Playwright is a development dependency only.

## Image contract

- `Dockerfile` pins Bun `1.4.2-slim` to the immutable image digest resolved by
  the passing container CI build. Re-test intentional runtime or image updates;
  a pinned digest does not receive security updates automatically.
- Only five named runtime files are copied to `/app`. `.dockerignore` also
  allowlists the build context, excluding Git history, historical databases,
  local environment files, and test artifacts.
- The process runs as the unprivileged `bun` user. Newly created database files
  use a private `077` umask. The image prepares `/var/data` for that user, but
  an external host mount replaces the image directory: verify the mounted
  directory's ownership and write access on the actual target before launch.
- `NODE_ENV=production` and the absolute `DB_PATH` are set in the image.
  `APP_ORIGIN` must be supplied at runtime, for example
  `https://your-reviewed-host.example`, without a path or trailing slash.
  HTTP origins and missing configuration fail startup.
- `GET /healthz` checks database read availability and returns only
  `{ "ok": true }` or a `503` with `{ "ok": false }`. It is a readiness probe,
  not a backup check or proof of disk capacity and write health.

Do not use an unmounted container filesystem for accounts or messages. A
container can start without a persistent mount, but its data would be lost when
that container is removed. Do not solve mount-permission problems by running
the app as root or making the database world-writable; have the operator
provision a narrowly writable directory for the image's user.

## Synthetic container verification

With Docker and the pinned Bun runtime installed, run from the repository root:

```sh
bun run test
bash scripts/test-container.sh
bun install --frozen-lockfile
bunx playwright install --with-deps chromium
bun run test:ui
```

The container check builds the actual image, verifies non-root execution and
its five-file application allowlist, and rejects missing/insecure origins and
relative database paths. It runs with a read-only root filesystem, dropped
capabilities, a private named volume, and a loopback-only published port. It
checks Secure session flags, HTTP authorization, wrong-origin rejection,
authenticated WebSocket posting, and private database file modes. It then
removes and recreates the container with the same volume and verifies that the
synthetic account, post, and balance survive. It then takes a SQLite-consistent
backup while that WAL-mode source is running, commits a later post, and restores
only the backup into a separate empty volume. It checks database integrity,
foreign keys, backup-point account/post/balance recovery, exclusion of the later
post, authenticated writes after restore, and private file modes. Cleanup touches
only resources created by that test run.

These transport checks use a synthetic HTTPS Origin header over loopback HTTP.
They do not test a real TLS certificate, reverse proxy, or browser Secure-cookie
delivery on a hosted origin. The separate Chromium suite tests the client on
its isolated development server. The test-only GitHub Actions workflow runs
all three stages and does not publish an image or deploy a service.

## Proposed Render configuration

`render.yaml` specifies Docker, one instance, `/healthz`, a 1 GB persistent disk
at `/var/data`, and the current `0.5c-512mb` paid compute plan. `APP_ORIGIN` uses
`sync: false` so an operator supplies the reviewed value; no domain is guessed.
Automatic code deploys are explicitly off. The Docker image owns its start
command; there are no conflicting native build/start commands in the Blueprint.

This is configuration for review, not approval to provision resources. Importing
or syncing a Blueprint can create paid resources, change an existing service,
and initiate deployment. Turning off automatic code deploys does not prevent
initial/manual deploys or all effects of a Blueprint sync. Confirm the account,
service, branch, origin, costs, storage, and approval before applying it.
Blueprint Auto Sync is a separate dashboard setting; review it and set it to
No before any future authorized rollout that requires manual-only changes.

Render persistent disks require paid compute, cannot be shared by multiple
service instances, and introduce restart downtime during deployment. Disk
mounts are available at runtime, not during image build or pre-deploy commands.
Keep migrations and recovery procedures separate from the build. See Render's
[Blueprint reference](https://render.com/docs/blueprint-spec),
[disk requirements](https://render.com/docs/disks), and
[Docker guide](https://render.com/docs/docker).

For an existing service, review its actual dashboard settings first. This file
does not prove that auto-deploys are disabled there, that its disk is mounted,
or that its database is private and backed up. Applying a changed plan or disk
to an existing service needs a separate impact and cost review.

## Release gates

1. Verify the exact commit passes backend, container, and Chromium CI. Review
   the resulting image digest and any base-image security findings.
2. Resolve the historical `app.db`, `app.db-wal`, and `app.db-shm` provenance
   warning in the README. They are not used or included in the image, but still
   exist in the repository and its history. Do not publish a whole repository
   directory as static files. No deletion or migration is part of this repair.
3. Approve a hosting target and any recurring compute/storage charges. Check
   its service branch, disk mount, write ownership, backup destination, and
   exact public HTTPS origin. Keep one instance with automatic deploys off.
4. Review proxy-aware abuse protection. Authentication currently uses the direct
   peer address and can share a throttle behind a proxy; do not blindly trust
   client-supplied forwarding headers. Broader rollout also needs moderation,
   recovery, resource limits, and independent security review.
5. On an authorized staging target with synthetic data, verify HTTPS and Secure
   cookies in a browser; sign up, reload, log out, and confirm logout revocation.
   Test two-account WebSocket posting and private messages through the actual
   proxy, mobile layout, and restart/redeploy persistence.
6. Complete a backup-and-restore rehearsal against a separate synthetic
   database and document downtime and rollback. Then obtain the owner's
   deployment approval for the reviewed target and exact tested commit.

## Data, backups, and rollback

No historical accounts or messages are migrated automatically. Never copy the
repository's database into the image, mount it as the live database, or paste
its contents into a public issue. Any real-data migration requires a separate
authorized plan and an appropriate private transfer path.

Use SQLite-consistent backups, such as its online backup API or `VACUUM INTO`,
with protected destination access, retention, capacity monitoring, and tested
restoration. Do not copy a live main database file alone while WAL writes are
active. Host volume snapshots alone are not a demonstrated database recovery
procedure. A persistent disk prevents routine container loss; it is not a
backup by itself.

Record the previous image digest and schema expectations before each release.
On failure, stop rollout, preserve the private volume, and assess whether the
previous image is compatible with the current schema. Reverting a commit does
not reverse data changes. A restore can lose writes made after the backup;
require explicit approval before overwriting live data or changing access.


### Repeatable synthetic backup-and-restore rehearsal

Run `bash scripts/test-container.sh` on a Docker host with the pinned Bun
runtime, or inspect that step in the exact commit's test-only GitHub Actions run.
The script uses only its own generated volume names and fixed synthetic account.
It does not read `DB_PATH`, use the historical repository databases, or connect
to a hosted service. Runtime code, image contents, and deployment settings are
unchanged by this rehearsal.

The recovery path deliberately separates persistence from backup:

1. Seed an account and post, then recreate the application on its original
   volume. Confirm the account still has 110 virtual coins.
2. With the source running in WAL mode, open a read-only SQLite connection and
   use `VACUUM INTO` to create a standalone mode-600 backup. Check
   `PRAGMA integrity_check` and `PRAGMA foreign_key_check` on that backup.
3. Commit another post to the source, raising its balance to 120. Stop the
   synthetic application before the recovery cutover.
4. Mount the source volume read-only in a network-disabled, non-root helper.
   Copy only the completed backup into a separate empty private volume, refusing
   to replace an existing file. Check the restored database before app startup.
5. Start the same image on the restored volume. Sign in, verify the original
   post and 110-coin balance, and confirm the post made after backup is absent.
   Create a new authenticated WebSocket post and verify the 120-coin balance,
   then verify logout revocation and mode 600 for database/WAL/SHM files.

This demonstrates a snapshot recovery point: writes committed after the backup
are lost on the restored copy. It is not a production backup service. The
synthetic backup shares the source volume only to simplify the isolated test;
a real backup needs an independently protected destination, retention and
capacity policy, and a reviewed recovery time/recovery point objective.

For an authorized real recovery, isolate traffic and stop writers before
cutover. Preserve the existing volume for rollback and restore to a separate
private target; do not overwrite the only copy. Use a schema-compatible image,
validate integrity and application behavior privately, and record the measured
backup timestamp, data-loss window, downtime, image digest, and rollback target.
A snapshot can revive sessions or credentials revoked after that snapshot;
include owner-approved session invalidation and account-security review before
reopening traffic. This synthetic check does not establish host-specific restore
timing, encrypted off-host storage, real TLS/proxy behavior, or deployment
approval. Release gates still apply.
