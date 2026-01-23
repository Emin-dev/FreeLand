const { Database } = require("bun:sqlite")

const db = new Database("app.db", { create: true })

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

console.log("✅ Database initialized")

const clients = new Set()
const wsToUser = new Map()
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
  let sent = 0
  clients.forEach(ws => {
    try {
      if (ws.readyState === 1) {
        ws.send(str)
        sent++
      }
    } catch (e) {
      console.error("Broadcast error:", e)
    }
  })
  console.log(`📡 Broadcast to ${sent}/${clients.size} clients`)
}

function sendToUser(uid, msg) {
  const ws = userToWs.get(uid)
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(msg))
      console.log(`📨 Sent to user ${uid}:`, msg.t)
    } catch (e) {
      console.error("Send error:", e)
    }
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
  port: process.env.PORT || 3000,
  async fetch(req, srv) {
    const url = new URL(req.url)

    try {
      if (url.pathname === "/ws") {
        if (srv.upgrade(req)) return
        return new Response("Upgrade failed", { status: 500 })
      }

      if (url.pathname === "/api/auth") {
        const { username, password, signup } = await req.json()

        if (!username || !password || username.length < 3 || username.length > 20 || password.length < 8) {
          return Response.json({ error: "Username: 3-20 chars, Password: min 8 chars" }, { status: 400 })
        }

        if (signup) {
          try {
            // Hash password
            const hashedPassword = await Bun.password.hash(password, {
              algorithm: "bcrypt",
              cost: 10
            })

            const stmt = db.prepare("INSERT INTO users(username,password,coins) VALUES(?,?,100)")
            const result = stmt.run(username, hashedPassword)

            const user = db.prepare("SELECT id,username,coins,dm_until FROM users WHERE id=?").get(result.lastInsertRowid)

            console.log("✅ User created:", user.username, "ID:", user.id)
            return Response.json(user)
          } catch (e) {
            console.error("Signup error:", e.message)
            return Response.json({ error: "Username already taken" }, { status: 409 })
          }
        } else {
          // Login
          const user = db.prepare("SELECT * FROM users WHERE username=?").get(username)

          if (!user) {
            console.log("❌ User not found:", username)
            return Response.json({ error: "Invalid username or password" }, { status: 401 })
          }

          // Verify password
          const verified = await Bun.password.verify(password, user.password, "bcrypt")

          if (!verified) {
            console.log("❌ Invalid password for:", username)
            return Response.json({ error: "Invalid username or password" }, { status: 401 })
          }

          console.log("✅ User logged in:", user.username, "ID:", user.id)
          return Response.json({ 
            id: user.id, 
            username: user.username, 
            coins: user.coins, 
            dm_until: user.dm_until 
          })
        }
      }

      if (url.pathname === "/api/feed") {
        const uid = parseInt(url.searchParams.get("uid")) || 0

        const posts = db.prepare(`
          SELECT 
            p.*, 
            u.username,
            CASE WHEN p.original_post_id IS NOT NULL THEN op.text ELSE NULL END as original_text,
            CASE WHEN p.original_post_id IS NOT NULL THEN ou.username ELSE NULL END as original_author
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

        console.log(`📰 Feed loaded: ${posts.length} posts for user ${uid}`)
        return Response.json(posts)
      }

      if (url.pathname === "/api/stats") {
        const uid = parseInt(url.searchParams.get("uid"))
        const user = db.prepare("SELECT coins,dm_until FROM users WHERE id=?").get(uid)
        const postCount = db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id=? AND deleted=0").get(uid)
        const portfolio = db.prepare(`
          SELECT SUM(p.value) as total, SUM(pf.buy_price) as invested
          FROM portfolio pf
          JOIN posts p ON pf.post_id=p.id
          WHERE pf.user_id=? AND p.deleted=0
        `).get(uid)

        const totalValue = portfolio.total || 0
        const invested = portfolio.invested || 1
        const roi = invested > 0 ? Math.round(((totalValue - invested) / invested) * 100) : 0

        return Response.json({
          coins: user.coins,
          post_count: postCount.c,
          portfolio_value: totalValue,
          roi,
          dm_active: user.dm_until && user.dm_until > Date.now()
        })
      }

      if (url.pathname === "/api/portfolio") {
        const uid = parseInt(url.searchParams.get("uid"))
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

        return Response.json(items)
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
        return Response.json({ richest, valuable, traders })
      }

      if (url.pathname === "/api/messages") {
        const uid = parseInt(url.searchParams.get("uid"))
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

        return Response.json(messages)
      }

      if (url.pathname === "/") {
        return new Response(Bun.file("index.html"))
      }

      return new Response("Not Found", { status: 404 })
    } catch (e) {
      console.error("❌ Server error:", e)
      return Response.json({ error: e.message }, { status: 500 })
    }
  },

  websocket: {
    open(ws) {
      clients.add(ws)
      console.log(`✅ WebSocket connected, total: ${clients.size}`)
    },

    close(ws) {
      clients.delete(ws)
      const uid = wsToUser.get(ws)
      if (uid) {
        wsToUser.delete(ws)
        userToWs.delete(uid)
        console.log(`❌ User ${uid} disconnected`)
      }
      console.log(`Total connections: ${clients.size}`)
    },

    message(ws, msg) {
      try {
        const { t, d } = JSON.parse(msg)
        const uid = d.uid

        // Map user to websocket
        if (!wsToUser.has(ws)) {
          wsToUser.set(ws, uid)
          userToWs.set(uid, ws)
          console.log(`🔗 User ${uid} mapped to WebSocket`)
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
            created: Date.now(),
            original_post_id: null,
            original_text: null,
            original_author: null,
            show_original: 1,
            deleted: 0,
            user_liked: false,
            user_reshared: false,
            user_owns: false
          }

          console.log(`📝 Post created by ${user.username}: "${d.text.slice(0, 50)}..."`)
          broadcast({ t: "new", d: post })
          sendToUser(uid, { t: "balance", d: { coins: getCoins(uid), msg: "+10 coins for posting!" } })
        }

        if (t === "like") {
          const existing = db.prepare("SELECT 1 FROM likes WHERE user_id=? AND post_id=?").get(uid, d.id)

          if (existing) {
            db.prepare("DELETE FROM likes WHERE user_id=? AND post_id=?").run(uid, d.id)
            const count = db.prepare("SELECT COUNT(*) as c FROM likes WHERE post_id=?").get(d.id).c
            console.log(`💔 Unlike post ${d.id} by user ${uid}`)
            broadcast({ t: "update", d: { id: d.id, like_count: count, user_id: uid, liked: false } })
          } else {
            db.prepare("INSERT INTO likes(user_id,post_id) VALUES(?,?)").run(uid, d.id)
            const count = db.prepare("SELECT COUNT(*) as c FROM likes WHERE post_id=?").get(d.id).c
            console.log(`❤️ Like post ${d.id} by user ${uid}`)
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
            db.prepare("DELETE FROM reshares WHERE user_id=? AND post_id=?").run(uid, d.id)
            db.prepare("UPDATE posts SET deleted=1 WHERE user_id=? AND original_post_id=?").run(uid, d.id)
            db.prepare("UPDATE users SET coins=coins-2 WHERE id=?").run(uid)
            db.prepare("UPDATE users SET coins=coins-5 WHERE id=?").run(originalPost.user_id)

            const count = db.prepare("SELECT COUNT(*) as c FROM reshares WHERE post_id=?").get(d.id).c
            const newValue = calcValue(count)
            db.prepare("UPDATE posts SET value=? WHERE id=?").run(newValue, d.id)

            console.log(`🔄 Unreshare post ${d.id} by user ${uid}`)
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
              created: Date.now(),
              user_liked: false,
              user_reshared: false,
              user_owns: false
            }

            console.log(`🔄 Reshare post ${d.id} by ${user.username}`)
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

          console.log(`📈 User ${uid} bought post ${d.id} for ${post.value}`)
          broadcast({ t: "update", d: { id: d.id, user_id: uid, owns: true } })
          sendToUser(uid, { t: "balance", d: { coins: getCoins(uid), msg: `Bought for ${post.value} coins!` } })
          sendToUser(post.user_id, { t: "balance", d: { coins: getCoins(post.user_id), msg: `Post sold for ${Math.floor(post.value * 0.8)} coins!` } })
        }

        if (t === "sell") {
          const portfolio = db.prepare("SELECT buy_price FROM portfolio WHERE user_id=? AND post_id=?").get(uid, d.id)
          const post = db.prepare("SELECT value,show_original FROM posts WHERE id=? AND deleted=0").get(d.id)

          if (!portfolio) {
            sendToUser(uid, { t: "error", d: { msg: "You don't own this post" } })
            return
          }

          db.prepare("DELETE FROM portfolio WHERE user_id=? AND post_id=?").run(uid, d.id)
          db.prepare("UPDATE users SET coins=coins+? WHERE id=?").run(post.value, uid)

          console.log(`📉 User ${uid} sold post ${d.id} for ${post.value}`)
          broadcast({ t: "update", d: { id: d.id, user_id: uid, owns: false } })
          sendToUser(uid, { t: "balance", d: { coins: getCoins(uid), msg: `Sold for ${post.value} coins!` } })
        }

        if (t === "buy_dm") {
          const user = db.prepare("SELECT coins FROM users WHERE id=?").get(uid)

          if (user.coins < 50) {
            sendToUser(uid, { t: "error", d: { msg: "Need 50 coins for DM" } })
            return
          }

          const dmUntil = Date.now() + (60 * 60 * 1000)
          db.prepare("UPDATE users SET coins=coins-50, dm_until=? WHERE id=?").run(dmUntil, uid)

          console.log(`💬 User ${uid} unlocked DM`)
          sendToUser(uid, { t: "dm_active", d: { dm_until: dmUntil, coins: getCoins(uid), msg: "DM unlocked!" } })
        }

        if (t === "send_message") {
          const user = db.prepare("SELECT dm_until FROM users WHERE id=?").get(uid)

          if (!user || !user.dm_until || user.dm_until < Date.now()) {
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
            created: Date.now()
          }

          console.log(`💬 Message from ${fromUsername} to user ${toUser.id}`)
          sendToUser(uid, { t: "message", d: message })
          sendToUser(toUser.id, { t: "message", d: message })
          sendToUser(uid, { t: "success", d: { msg: "Message sent!" } })
        }
      } catch (e) {
        console.error("❌ WebSocket error:", e)
        sendToUser(d?.uid, { t: "error", d: { msg: "Error: " + e.message } })
      }
    }
  }
})

console.log(`🚀 FreeLand running on http://localhost:${server.port}`)
console.log(`📁 Database: app.db`)
console.log(`👥 Ready for multi-user connections`)
