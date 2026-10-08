import { createHash, randomBytes } from "node:crypto"

export class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

export const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer"
}

const TTL = 24 * 60 * 60 * 1000
const digest = token => createHash("sha256").update(token).digest("hex")

export function createSessionSecurity(db, { origin, secure, now }) {
  if (origin && new URL(origin).origin !== origin) throw new Error("APP_ORIGIN must be an origin without a path or trailing slash")
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`)
  const attempts = new Map()
  let inFlight = 0
  // Only used to equalize the missing-account verification path. This is not an account credential.
  const dummyHash = Bun.password.hashSync(randomBytes(32).toString("hex"), { algorithm: "argon2id" })
  const findSession = hash => db.prepare("SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?").get(hash, now())
  return {
    dummyHash,
    findSession,
    fromRequest(req) {
      const token = req.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith("freeland_session="))?.slice(17)
      return token && /^[a-f0-9]{64}$/.test(token) ? findSession(digest(token)) : null
    },
    checkOrigin(req) {
      if (req.headers.get("origin") !== (origin || new URL(req.url).origin)) throw new RequestError("Origin not allowed", 403)
    },
    publicUser(id) {
      return db.prepare("SELECT id,username,coins,dm_until FROM users WHERE id=?").get(id)
    },
    issue(uid) {
      const token = randomBytes(32).toString("hex")
      db.transaction(() => {
        db.prepare("DELETE FROM sessions WHERE expires<=?").run(now())
        // Bound active sessions per account; signing in rotates the oldest session.
        db.prepare("DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY expires DESC LIMIT -1 OFFSET 4)").run(uid)
        db.prepare("INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)").run(digest(token), uid, now() + TTL)
      }).immediate()
      return token
    },
    revoke(hash) { db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash) },
    cookie(token, seconds = TTL / 1000) {
      return `freeland_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${secure ? "; Secure" : ""}`
    },
    allowAuth(ip) {
      for (const [key, value] of attempts) if (value.until <= now()) attempts.delete(key)
      const entry = attempts.get(ip) || { count: 0, until: now() + 15 * 60 * 1000 }
      if (!attempts.has(ip) && attempts.size >= 10000) throw new RequestError("Please try again later", 429)
      attempts.set(ip, entry)
      if (++entry.count > 10) throw new RequestError("Too many sign-in attempts. Please try again later.", 429)
    },
    beginPasswordWork() {
      if (inFlight >= 4) throw new RequestError("Please try again shortly", 429)
      inFlight++
      return () => { inFlight-- }
    }
  }
}

export function validateAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) throw new RequestError("Invalid action")
  const { t, d } = action
  if (!["post", "like", "reshare", "buy", "sell", "buy_dm", "send_message"].includes(t) ||
      !d || typeof d !== "object" || Array.isArray(d)) throw new RequestError("Invalid action")
  if (["like", "reshare", "buy", "sell"].includes(t) && (!Number.isSafeInteger(d.id) || d.id <= 0)) throw new RequestError("Invalid post ID")
  if (["post", "send_message"].includes(t) && (typeof d.text !== "string" || !d.text.trim() || d.text.length > (t === "post" ? 280 : 500))) throw new RequestError("Invalid text")
  if (t === "reshare" && ((d.text !== undefined && (typeof d.text !== "string" || d.text.length > 280)) || (d.show_original !== undefined && typeof d.show_original !== "boolean"))) throw new RequestError("Invalid reshare")
  if (t === "send_message" && (typeof d.to_id !== "string" || d.to_id.length < 3 || d.to_id.length > 20)) throw new RequestError("Invalid recipient")
  return { t, d }
}
