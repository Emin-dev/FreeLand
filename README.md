# FreeLand

A small social-trading prototype built with **Bun, SQLite, and vanilla HTML/CSS/JavaScript**. Publish short posts, like and reshare them, collect posts in a virtual portfolio, and unlock direct messaging with in-app coins.

**Coins and portfolio returns are game mechanics.** There are no payments, withdrawals, real assets, or investment services. This is a learning project, not a production financial platform.

## Run locally

Install [Bun 1.4.2](https://bun.com/docs/installation) or a newer compatible stable release, then:

```sh
bun run dev
```

Open http://localhost:3000 and create a test account. No third-party runtime packages or package-install step are required to run the app. `bun run start` runs without watch mode; `bun run test` runs the backend regression suite. Browser testing uses the development-only Playwright dependency pinned in `bun.lock`.

Development listens on loopback and creates `data/freeland.sqlite`. The app never automatically opens the historical `app.db` in the repository. Use synthetic accounts while evaluating the prototype.

## How it works

- Posts are limited to 280 characters; direct messages to 500.
- A new account starts with 100 virtual coins. Posting earns 10; resharing earns 2 and rewards the original author with 5.
- Buying a post deducts its current virtual value and credits the author 80% of that value. Selling returns its current virtual value to the holder. This intentionally simplified economy can create coins and is not a real marketplace.
- DM access costs 50 coins for one hour. Message history remains readable by its sender and recipient after the sending entitlement expires.
- The feed and leaderboard are public, including usernames, posts, and virtual coin rankings. Private messages, portfolio details, and account stats require a session.

## Security boundaries

Passwords are hashed using Bun's Argon2id implementation. Verification also accepts existing bcrypt hashes in an explicitly managed private database. Passwords must have at least 8 characters and no more than 72 UTF-8 bytes for legacy compatibility.

Sign-in creates a random 256-bit session token in an `HttpOnly`, `SameSite=Strict` cookie. Only its SHA-256 digest is stored server-side. Sessions expire after 24 hours; an account keeps at most five active sessions. Logout revokes the current session and closes its WebSockets.

HTTP private reads and every WebSocket mutation derive the account from a verified session. Client-supplied `uid` fields cannot select another account. Mutating HTTP requests and WebSocket upgrades require the exact configured origin. Cookies are also `Secure` in production.

Coin and portfolio changes commit together in SQLite transactions. Realtime notifications are emitted only after commit. Requests and WebSocket payloads are bounded, action fields are validated, and database error details are not returned to clients. Basic process-local throttles limit authentication attempts and socket actions.

The original inline client script and event handlers are retained, so the content security policy still allows inline scripts and styles. These safeguards do not substitute for an independent security review, abuse controls, account recovery, moderation, or production operations.

## Configuration and deployment considerations

See `.env.example`. Bun automatically loads a local `.env` file.

| Variable | Development | Production requirement |
| --- | --- | --- |
| `PORT` | `3000` | Service port, usually supplied by the host |
| `APP_ORIGIN` | Request origin | Exact public HTTPS origin, without a trailing slash |
| `DB_PATH` | `data/freeland.sqlite` | Absolute path on a private persistent volume |
| `NODE_ENV` | Unset | `production` enables Secure cookies and configuration checks |

Production startup fails if the HTTPS origin or absolute database path is missing. Terminate TLS at a trusted proxy and preserve WebSocket upgrades. This implementation targets one Bun process; socket broadcasts and throttles are process-local. It uses the directly connected peer for authentication throttling rather than trusting arbitrary forwarding headers, so a reverse proxy may share one limit across clients. Add trusted-proxy-aware edge throttling before a broader rollout.

The `Dockerfile` packages only runtime source files, runs as an unprivileged user, and exposes a minimal database readiness check at `/healthz`. The proposed `render.yaml` supplies private persistent storage, requires an operator-provided HTTPS origin, and turns automatic code deploys off. Applying that Blueprint can still create paid resources and initiate a deployment. No hosting account or live service is configured by this change.

Read the [deployment review and runbook](docs/DEPLOYMENT.md) before using it. A hosting target, costs, mount permissions, backups, and end-to-end HTTPS/WebSocket behavior must still be reviewed and authorized. GitHub Pages can serve static HTML but cannot run this backend.

### Historical storage warning

The repository already tracks `app.db`, `app.db-wal`, and `app.db-shm`. Their contents have not been inspected or reused by this repair. Ignore rules prevent accidental addition of new runtime files, but do not remove already-tracked files or erase Git history. Do not assume those historical files are sanitized or safe to publish. The owner should assess their provenance and approve any separate removal, history cleanup, or affected-account response before public deployment. Do not paste database contents into issues or pull requests.

A separate migration plan is required to carry any existing accounts or data into a private runtime database. Starting this version with the default path creates an empty database; it is not an automatic migration.

## Verification

```sh
bun run test

# Production-mode image checks with a disposable synthetic volume (requires Docker):
bash scripts/test-container.sh

# Optional Chromium UI smoke tests, also run in GitHub Actions:
bun install --frozen-lockfile
bunx playwright install --with-deps chromium
bun run test:ui
```

The suite uses fresh in-memory SQLite databases and synthetic accounts only. It covers unauthenticated access, forged identities, exact-origin checks, cookie flags, legacy bcrypt compatibility, session expiry/revocation, multi-tab delivery, malformed payloads, safe errors, trade consistency, transaction rollback, storage-route denial, and client script syntax.

The Chromium smoke tests cover signup/login, repeated clicks, session restoration, multi-tab sockets, posts, likes, reshares, trades, private messages, logout failure/revocation, expired-session UI handling, and mobile layout. They start a separate loopback server with a temporary synthetic database and never use `DB_PATH` or production credentials. Screenshots and a report are retained as CI artifacts for seven days.

The container suite checks fail-closed startup, non-root execution, image contents, Secure session flags, authenticated realtime posting, private file permissions, and data persistence after container recreation. The test-only GitHub Actions workflow has read-only repository permissions and no deployment or secret-dependent steps. A passing test suite does not establish production readiness, external hosting behavior, or historical data safety.

## Project layout

- `server.js`: HTTP routes, SQLite schema, realtime actions, and transactions
- `security.js`: sessions, origin checks, validation, and basic throttles
- `storage.js`: explicit runtime database selection
- `index.html`: responsive single-page client
- `test/security.test.js`: synthetic security and compatibility regressions
- `browser/` and `playwright.config.cjs`: isolated Chromium smoke tests
- `Dockerfile`, `.dockerignore`, and `render.yaml`: reviewed deployment inputs
- `scripts/`: disposable production-mode container checks
- `docs/DEPLOYMENT.md`: release gates, hosting review, storage, and recovery guidance

## Contributing

Keep the Bun/SQLite/vanilla stack, use synthetic fixtures, and run `bun test` before proposing changes. Never commit account databases, session tokens, `.env` files, or personal message content. No license file is currently provided; do not assume reuse rights beyond those granted by the repository's owner.
