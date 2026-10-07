import { Database } from "bun:sqlite"
import { createSessionSecurity, validateAction, RequestError, securityHeaders } from "./security.js"
import { openDatabase } from "./storage.js"

// An isolated in-memory database is the default for embedding and tests.
export function createApp({ db = new Database(":memory:"), port = 3000, hostname = "127.0.0.1", origin, secure = false, now = Date.now } = {}) {
  const security = createSessionSecurity(db, { origin, secure, now })

  // Database setup
  db.exec(`PRAGMA journal_mode=WAL`)
  db.exec(`PRAGMA synchronous=NORMAL`)
  db.exec(`PRAGMA foreign_keys=ON`)

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      coins INTEGER DEFAULT 100,
      dm_until INTEGER DEFAULT 0,
      created INTEGER DEFAULT(strftime('%s','now') * 1000)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS posts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      value INTEGER DEFAULT 10,
      original_post_id INTEGER,
      show_original INTEGER DEFAULT 1,
      deleted INTEGER DEFAULT 0,
      created INTEGER DEFAULT(strftime('%s','now') * 1000),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(original_post_id) REFERENCES posts(id)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS likes(
      user_id INTEGER,
      post_id INTEGER,
      created INTEGER DEFAULT(strftime('%s','now') * 1000),
      PRIMARY KEY(user_id,post_id)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS reshares(
      user_id INTEGER,
      post_id INTEGER,
      created INTEGER DEFAULT(strftime('%s','now') * 1000),
      PRIMARY KEY(user_id,post_id)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio(
      user_id INTEGER,
      post_id INTEGER,
      buy_price INTEGER,
      bought INTEGER DEFAULT(strftime('%s','now') * 1000),
      PRIMARY KEY(user_id,post_id)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER,
      to_id INTEGER,
      text TEXT NOT NULL,
      created INTEGER DEFAULT(strftime('%s','now') * 1000)
    )
  `)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created DESC)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_value ON posts(value DESC)`)


  const clients = new Set()
  const userToWs = new Map()

  function calcValue(reshares) {
    let v = 10
    for (let i = 0; i < reshares; i++) {
      v += 5 * Math.pow(0.95, i)
    }
    return Math.min(Math.floor(v), 1000)
  }

  function broadcast(msg) {
    const str = JSON.stringify(msg)
    clients.forEach(ws => {
      try {
        if (ws.readyState === 1) {
          ws.send(str)
        }
      } catch (e) {
        console.error("Broadcast error:", e)
      }
    })
  }

  function sendToUser(uid, msg) {
    for (const ws of userToWs.get(uid) || []) {
      if (!security.findSession(ws.data.sessionHash)) {
        ws.close(1008, "Session expired")
        continue
      }
      if (ws.readyState === 1) ws.send(JSON.stringify(msg))
    }
  }

  function getCoins(uid) {
    try {
      const user = db.prepare("SELECT coins FROM users WHERE id=?").get(uid)
      return user ? user.coins : 0
    } catch (e) {
      return 0
    }
  }

  const server = Bun.serve({
    port,
    hostname,
    maxRequestBodySize: 4096,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { ...securityHeaders, ...headers } })

      try {
        const allowedMethods = ["/api/auth", "/api/logout"].includes(url.pathname) ? ["POST"] : ["GET"]
        if (!allowedMethods.includes(req.method)) return json({ error: "Method not allowed" }, 405, { Allow: allowedMethods.join(", ") })
        const session = security.fromRequest(req)
        if (["/api/stats", "/api/portfolio", "/api/messages", "/api/session"].includes(url.pathname) && !session) {
          return json({ error: "Sign in required" }, 401)
        }
        if (url.pathname === "/api/session") return json(security.publicUser(session.user_id))
        if (url.pathname === "/api/logout") {
          security.checkOrigin(req)
          if (session) {
            security.revoke(session.token_hash)
            for (const ws of userToWs.get(session.user_id) || []) {
              if (ws.data.sessionHash === session.token_hash) ws.close(1008, "Signed out")
            }
          }
          return json({ ok: true }, 200, { "Set-Cookie": security.cookie("", 0) })
        }
        if (url.pathname === "/ws") {
          security.checkOrigin(req)
          if (!session) return json({ error: "Sign in required" }, 401)
          if ((userToWs.get(session.user_id)?.size || 0) >= 10) return json({ error: "Too many connections" }, 429)
          if (srv.upgrade(req, { data: { uid: session.user_id, sessionHash: session.token_hash, window: now(), messages: 0 } })) return
          return json({ error: "WebSocket upgrade required" }, 400)
        }

        if (url.pathname === "/api/auth") {
          security.checkOrigin(req)
          if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "JSON required" }, 415)
          security.allowAuth(srv.requestIP(req)?.address || "unknown")
          let data
          try { data = await req.json() } catch { return json({ error: "Invalid JSON" }, 400) }
          const { username, password, signup = false } = data || {}
          if (typeof username !== "string" || username.length < 3 || username.length > 20 || username.trim() !== username ||
              typeof password !== "string" || password.length < 8 || Buffer.byteLength(password) > 72 || typeof signup !== "boolean") {
            return json({ error: "Username: 3–20 characters. Password: at least 8 characters, at most 72 UTF-8 bytes." }, 400)
          }
          const release = security.beginPasswordWork()
          try {
            let user
            if (signup) {
              const hashedPassword = await Bun.password.hash(password, { algorithm: "argon2id" })
              try {
                const result = db.prepare("INSERT INTO users(username,password,coins) VALUES(?,?,100)").run(username, hashedPassword)
                user = security.publicUser(result.lastInsertRowid)
              } catch (error) {
                if (error.code?.startsWith("SQLITE_CONSTRAINT")) return json({ error: "Username already taken" }, 409)
                throw error
              }
            } else {
              const stored = db.prepare("SELECT id,password FROM users WHERE username=?").get(username)
              // A dummy hash keeps unknown-account attempts on the password verification path.
              const verified = await Bun.password.verify(password, stored?.password || security.dummyHash)
              if (!stored || !verified) return json({ error: "Invalid username or password" }, 401)
              user = security.publicUser(stored.id)
            }
            if (session) security.revoke(session.token_hash)
            const token = security.issue(user.id)
            return json(user, 200, { "Set-Cookie": security.cookie(token) })
          } finally {
            release()
          }
        }

        if (url.pathname === "/api/feed") {
          const uid = session?.user_id || 0

          const posts = db.prepare(`
            SELECT 
              p.*, 
              u.username,
              CASE WHEN p.original_post_id IS NOT NULL AND p.show_original=1 THEN op.text ELSE NULL END as original_text,
              CASE WHEN p.original_post_id IS NOT NULL AND p.show_original=1 THEN ou.username ELSE NULL END as original_author
            FROM posts p 
            JOIN users u ON p.user_id=u.id 
            LEFT JOIN posts op ON p.original_post_id=op.id
            LEFT JOIN users ou ON op.user_id=ou.id
            WHERE p.deleted=0
            ORDER BY p.created DESC 
            LIMIT 100
          `).all()

          // Add engagement data
          posts.forEach(p => {
            p.like_count = db.prepare("SELECT COUNT(*) as c FROM likes WHERE post_id=?").get(p.id).c
            p.reshare_count = db.prepare("SELECT COUNT(*) as c FROM reshares WHERE post_id=?").get(p.id).c

            if (uid) {
              p.user_liked = db.prepare("SELECT COUNT(*) as c FROM likes WHERE user_id=? AND post_id=?").get(uid, p.id).c > 0
              p.user_reshared = db.prepare("SELECT COUNT(*) as c FROM reshares WHERE user_id=? AND post_id=?").get(uid, p.id).c > 0
              p.user_owns = db.prepare("SELECT COUNT(*) as c FROM portfolio WHERE user_id=? AND post_id=?").get(uid, p.id).c > 0
            } else {
              p.user_liked = false
              p.user_reshared = false
              p.user_owns = false
            }
          })

          return json(posts)
        }

        if (url.pathname === "/api/stats") {
          const uid = session.user_id
          const user = db.prepare("SELECT coins,dm_until FROM users WHERE id=?").get(uid)
          const postCount = db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id=? AND deleted=0").get(uid)
          const portfolio = db.prepare(`
            SELECT SUM(p.value) as total, SUM(pf.buy_price) as invested
            FROM portfolio pf
            JOIN posts p ON pf.post_id=p.id
            WHERE pf.user_id=? AND p.deleted=0
          `).get(uid)

          const totalValue = portfolio.total || 0
          const invested = portfolio.invested || 0
          const roi = invested > 0 ? Math.round(((totalValue - invested) / invested) * 100) : 0

          return json({
            coins: user.coins,
            post_count: postCount.c,
            portfolio_value: totalValue,
            roi,
            dm_active: user.dm_until && user.dm_until > now()
          })
        }

        if (url.pathname === "/api/portfolio") {
          const uid = session.user_id
          const items = db.prepare(`
            SELECT 
              pf.*,
              p.text,
              p.value as current_value,
              u.username as author
            FROM portfolio pf
            JOIN posts p ON pf.post_id=p.id
            JOIN users u ON p.user_id=u.id
            WHERE pf.user_id=? AND p.deleted=0
            ORDER BY pf.bought DESC
          `).all(uid)

          return json(items)
        }

        if (url.pathname === "/api/leaderboard") {
          const richest = db.prepare("SELECT username,coins FROM users ORDER BY coins DESC LIMIT 10").all()
          const valuable = db.prepare("SELECT text,value FROM posts WHERE deleted=0 ORDER BY value DESC LIMIT 10").all()
          const traders = db.prepare(`
            SELECT u.username, COUNT(*) as trades
            FROM portfolio pf
            JOIN users u ON pf.user_id=u.id
            GROUP BY pf.user_id
            ORDER BY trades DESC
            LIMIT 10
          `).all()
          return json({ richest, valuable, traders })
        }

        if (url.pathname === "/api/messages") {
          const uid = session.user_id
          const messages = db.prepare(`
            SELECT 
              m.*,
              uf.username as from_username,
              ut.username as to_username
            FROM messages m
            JOIN users uf ON m.from_id=uf.id
            JOIN users ut ON m.to_id=ut.id
            WHERE m.from_id=? OR m.to_id=?
            ORDER BY m.created DESC
            LIMIT 50
          `).all(uid, uid)

          return json(messages)
        }

        if (url.pathname === "/") {
          return new Response(Bun.file(new URL("./index.html", import.meta.url)), { headers: { ...securityHeaders, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } })
        }

        return new Response("Not Found", { status: 404 })
      } catch (e) {
        if (!(e instanceof RequestError)) console.error("Request failed")
        return json({ error: e instanceof RequestError ? e.message : "Request failed" }, e instanceof RequestError ? e.status : 500)
      }
    },

    websocket: {
      maxPayloadLength: 4096,
      idleTimeout: 120,
      open(ws) {
        clients.add(ws)
        const sockets = userToWs.get(ws.data.uid) || new Set()
        sockets.add(ws)
        userToWs.set(ws.data.uid, sockets)
      },

      close(ws) {
        clients.delete(ws)
        const sockets = userToWs.get(ws.data.uid)
        sockets?.delete(ws)
        if (!sockets?.size) userToWs.delete(ws.data.uid)
      },

      message(ws, msg) {
        try {
          const session = security.findSession(ws.data.sessionHash)
          if (!session) { ws.close(1008, "Sign in required"); return }
          if (now() - ws.data.window >= 10_000) { ws.data.window = now(); ws.data.messages = 0 }
          if (++ws.data.messages > 30) throw new RequestError("Too many actions. Please wait.", 429)
          let action
          try { action = JSON.parse(msg) } catch { throw new RequestError("Invalid JSON") }
          const { t, d } = validateAction(action)
          const uid = session.user_id
          // Queue notifications until the entire synchronous mutation commits.
          const outbox = []
          const broadcast = data => outbox.push(() => broadcastCommitted(data))
          const sendToUser = (id, data) => outbox.push(() => sendCommitted(id, data))
          db.transaction(() => {
            if (["like", "reshare", "buy", "sell"].includes(t) && !db.prepare("SELECT 1 FROM posts WHERE id=? AND deleted=0").get(d.id)) {
              throw new RequestError("Post not found", 404)
            }
            if (t === "post") {
              const user = db.prepare("SELECT username FROM users WHERE id=?").get(uid)
              if (!user || !d.text || d.text.length > 280) {
                sendToUser(uid, { t: "error", d: { msg: "Invalid post" } })
                return
              }

              const stmt = db.prepare("INSERT INTO posts(user_id,text,value) VALUES(?,?,10)")
              const result = stmt.run(uid, d.text)

              db.prepare("UPDATE users SET coins=coins+10 WHERE id=?").run(uid)

              const post = {
                id: result.lastInsertRowid,
                user_id: uid,
                username: user.username,
                text: d.text,
                value: 10,
                like_count: 0,
                reshare_count: 0,
                created: now(),
                original_post_id: null,
                original_text: null,
                original_author: null,
                show_original: 1,
                deleted: 0,
                user_liked: false,
                user_reshared: false,
                user_owns: false
              }

              broadcast({ t: "new", d: post })
              sendToUser(uid, { t: "balance", d: { coins: getCoins(uid), msg: "+10 coins for posting!" } })
            }

            if (t === "like") {
              const existing = db.prepare("SELECT 1 FROM likes WHERE user_id=? AND post_id=?").get(uid, d.id)

              if (existing) {
                db.prepare("DELETE FROM likes WHERE user_id=? AND post_id=?").run(uid, d.id)
                const count = db.prepare("SELECT COUNT(*) as c FROM likes WHERE post_id=?").get(d.id).c
                broadcast({ t: "update", d: { id: d.id, like_count: count, user_id: uid, liked: false } })
              } else {
                db.prepare("INSERT INTO likes(user_id,post_id) VALUES(?,?)").run(uid, d.id)
                const count = db.prepare("SELECT COUNT(*) as c FROM likes WHERE post_id=?").get(d.id).c
                broadcast({ t: "update", d: { id: d.id, like_count: count, user_id: uid, liked: true } })
              }
            }

            if (t === "reshare") {
              const existing = db.prepare("SELECT 1 FROM reshares WHERE user_id=? AND post_id=?").get(uid, d.id)
              const originalPost = db.prepare("SELECT * FROM posts WHERE id=?").get(d.id)

              if (!originalPost) {
                sendToUser(uid, { t: "error", d: { msg: "Post not found" } })
                return
              }

              const user = db.prepare("SELECT username FROM users WHERE id=?").get(uid)

              if (existing) {
                const authorCoins = getCoins(originalPost.user_id)
                if (getCoins(uid) < (uid === originalPost.user_id ? 7 : 2) || authorCoins < 5) {
                  throw new RequestError("Cannot undo this reshare after its rewards have been spent")
                }
                db.prepare("DELETE FROM reshares WHERE user_id=? AND post_id=?").run(uid, d.id)
                db.prepare("UPDATE posts SET deleted=1 WHERE user_id=? AND original_post_id=?").run(uid, d.id)
                db.prepare("UPDATE users SET coins=coins-2 WHERE id=?").run(uid)
                db.prepare("UPDATE users SET coins=coins-5 WHERE id=?").run(originalPost.user_id)

                const count = db.prepare("SELECT COUNT(*) as c FROM reshares WHERE post_id=?").get(d.id).c
                const newValue = calcValue(count)
                db.prepare("UPDATE posts SET value=? WHERE id=?").run(newValue, d.id)

                broadcast({ t: "update", d: { id: d.id, reshare_count: count, value: newValue, user_id: uid, reshared: false } })
                broadcast({ t: "remove", d: { uid, original_id: d.id } })
                sendToUser(uid, { t: "balance", d: { coins: getCoins(uid), msg: "Unshared" } })
              } else {
                db.prepare("INSERT INTO reshares(user_id,post_id) VALUES(?,?)").run(uid, d.id)

                const showOriginal = d.show_original !== false
                const reshareText = d.text || ""
                const stmt = db.prepare("INSERT INTO posts(user_id,text,original_post_id,show_original,value) VALUES(?,?,?,?,?)")
                const result = stmt.run(uid, reshareText, d.id, showOriginal ? 1 : 0, originalPost.value)

                db.prepare("UPDATE users SET coins=coins+2 WHERE id=?").run(uid)
                db.prepare("UPDATE users SET coins=coins+5 WHERE id=?").run(originalPost.user_id)

                const count = db.prepare("SELECT COUNT(*) as c FROM reshares WHERE post_id=?").get(d.id).c
                const newValue = calcValue(count)
                db.prepare("UPDATE posts SET value=? WHERE id=?").run(newValue, d.id)

                const originalUser = db.prepare("SELECT username FROM users WHERE id=?").get(originalPost.user_id)

                const newPost = {
                  id: result.lastInsertRowid,
                  user_id: uid,
                  username: user.username,
                  text: reshareText,
                  value: originalPost.value,
                  like_count: 0,
                  reshare_count: 0,
                  original_post_id: d.id,
                  original_text: showOriginal ? originalPost.text : null,
                  original_author: showOriginal ? originalUser.username : null,
                  show_original: showOriginal ? 1 : 0,
                  created: now(),
                  user_liked: false,
                  user_reshared: false,
                  user_owns: false
                }

                broadcast({ t: "new", d: newPost })
                broadcast({ t: "update", d: { id: d.id, reshare_count: count, value: newValue, user_id: uid, reshared: true } })
                sendToUser(uid, { t: "balance", d: { coins: getCoins(uid), msg: "+2 coins for reshare!" } })
                sendToUser(originalPost.user_id, { t: "balance", d: { coins: getCoins(originalPost.user_id), msg: "+5 coins from reshare!" } })
              }
            }

            if (t === "buy") {
              const post = db.prepare("SELECT value,user_id FROM posts WHERE id=? AND deleted=0").get(d.id)
              const user = db.prepare("SELECT coins FROM users WHERE id=?").get(uid)

              if (!post || !user || user.coins < post.value || post.user_id === uid) {
                sendToUser(uid, { t: "error", d: { msg: "Cannot buy this post" } })
                return
              }

              const exists = db.prepare("SELECT 1 FROM portfolio WHERE user_id=? AND post_id=?").get(uid, d.id)
              if (exists) {
                sendToUser(uid, { t: "error", d: { msg: "Already own this post" } })
                return
              }

              db.prepare("INSERT INTO portfolio(user_id,post_id,buy_price) VALUES(?,?,?)").run(uid, d.id, post.value)
              db.prepare("UPDATE users SET coins=coins-? WHERE id=?").run(post.value, uid)
              db.prepare("UPDATE users SET coins=coins+? WHERE id=?").run(Math.floor(post.value * 0.8), post.user_id)

              broadcast({ t: "update", d: { id: d.id, user_id: uid, owns: true } })
              sendToUser(uid, { t: "balance", d: { coins: getCoins(uid), msg: `Bought for ${post.value} coins!` } })
              sendToUser(post.user_id, { t: "balance", d: { coins: getCoins(post.user_id), msg: `Post sold for ${Math.floor(post.value * 0.8)} coins!` } })
            }

            if (t === "sell") {
              const portfolio = db.prepare("SELECT buy_price FROM portfolio WHERE user_id=? AND post_id=?").get(uid, d.id)
              const post = db.prepare("SELECT value,show_original FROM posts WHERE id=? AND deleted=0").get(d.id)

              if (!portfolio || !post) {
                sendToUser(uid, { t: "error", d: { msg: "You don't own this post" } })
                return
              }

              db.prepare("DELETE FROM portfolio WHERE user_id=? AND post_id=?").run(uid, d.id)
              db.prepare("UPDATE users SET coins=coins+? WHERE id=?").run(post.value, uid)

              broadcast({ t: "update", d: { id: d.id, user_id: uid, owns: false } })
              sendToUser(uid, { t: "balance", d: { coins: getCoins(uid), msg: `Sold for ${post.value} coins!` } })
            }

            if (t === "buy_dm") {
              const user = db.prepare("SELECT coins FROM users WHERE id=?").get(uid)

              if (!user || user.coins < 50) {
                sendToUser(uid, { t: "error", d: { msg: "Need 50 coins for DM" } })
                return
              }

              const dmUntil = now() + (60 * 60 * 1000)
              db.prepare("UPDATE users SET coins=coins-50, dm_until=? WHERE id=?").run(dmUntil, uid)

              sendToUser(uid, { t: "dm_active", d: { dm_until: dmUntil, coins: getCoins(uid), msg: "DM unlocked!" } })
            }

            if (t === "send_message") {
              const user = db.prepare("SELECT dm_until FROM users WHERE id=?").get(uid)

              if (!user || !user.dm_until || user.dm_until <= now()) {
                sendToUser(uid, { t: "error", d: { msg: "DM access required" } })
                return
              }

              const toUser = db.prepare("SELECT id FROM users WHERE username=?").get(d.to_id)

              if (!toUser) {
                sendToUser(uid, { t: "error", d: { msg: "User not found" } })
                return
              }

              const stmt = db.prepare("INSERT INTO messages(from_id,to_id,text) VALUES(?,?,?)")
              const result = stmt.run(uid, toUser.id, d.text)

              const fromUsername = db.prepare("SELECT username FROM users WHERE id=?").get(uid).username

              const message = {
                id: result.lastInsertRowid,
                from_id: uid,
                to_id: toUser.id,
                from_username: fromUsername,
                text: d.text,
                created: now()
              }

              sendToUser(uid, { t: "message", d: message })
              if (toUser.id !== uid) sendToUser(toUser.id, { t: "message", d: message })
              sendToUser(uid, { t: "success", d: { msg: "Message sent!" } })
            }
          }).immediate()
          for (const deliver of outbox) deliver()
        } catch (e) {
          // Never trust or address an error to a client-supplied uid.
          if (!(e instanceof RequestError)) console.error("WebSocket action failed")
          ws.send(JSON.stringify({ t: "error", d: { msg: e instanceof RequestError ? e.message : "Unable to complete action" } }))
        }
      }
    }
  })
  const broadcastCommitted = broadcast
  const sendCommitted = sendToUser
  return { server, db, close() { server.stop(true); db.close() } }
}

if (import.meta.main) {
  const production = process.env.NODE_ENV === "production"
  const origin = process.env.APP_ORIGIN
  if (production && (!origin || !origin.startsWith("https://"))) throw new Error("Production requires an HTTPS APP_ORIGIN")
  const db = openDatabase({ path: process.env.DB_PATH, production })
  const { server } = createApp({ db, port: Number(process.env.PORT || 3000), hostname: production ? "0.0.0.0" : "127.0.0.1", origin, secure: production })
  console.log(`FreeLand listening on port ${server.port}`)
}
