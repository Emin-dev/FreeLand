const server = Bun.serve({
  port: process.env.PORT || 3000,
  async fetch(req, srv) {
    const url = new URL(req.url)

    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) return
      return new Response("Upgrade failed", { status: 500 })
    }

    if (url.pathname === "/api/auth") {
      const { username, password, signup } = await req.json()

      if (!username || !password || username.length < 3 || username.length > 20 || password.length < 8) {
        return Response.json({ error: "Invalid credentials" }, { status: 400 })
      }

      if (signup) {
        try {
          const stmt = db.prepare("INSERT INTO users(username,password) VALUES(?,?)")
          const result = stmt.run(username, await Bun.password.hash(password))
          const user = db.prepare("SELECT id,username,coins,dm_until FROM users WHERE id=?").get(result.lastInsertRowid)
          return Response.json(user)
        } catch {
          return Response.json({ error: "Username taken" }, { status: 409 })
        }
      } else {
        const user = db.prepare("SELECT * FROM users WHERE username=?").get(username)
        if (!user || !(await Bun.password.verify(password, user.password))) {
          return Response.json({ error: "Invalid credentials" }, { status: 401 })
        }
        return Response.json({ id: user.id, username: user.username, coins: user.coins, dm_until: user.dm_until })
      }
    }

    if (url.pathname === "/api/feed") {
      const uid = parseInt(url.searchParams.get("uid"))
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

      posts.forEach(p => {
        p.like_count = db.prepare("SELECT COUNT(*) as c FROM likes WHERE post_id=?").get(p.id).c
        p.reshare_count = db.prepare("SELECT COUNT(*) as c FROM reshares WHERE post_id=?").get(p.id).c
        p.user_liked = uid ? db.prepare("SELECT COUNT(*) as c FROM likes WHERE user_id=? AND post_id=?").get(uid, p.id).c > 0 : false
        p.user_reshared = uid ? db.prepare("SELECT COUNT(*) as c FROM reshares WHERE user_id=? AND post_id=?").get(uid, p.id).c > 0 : false
        p.user_owns = uid ? db.prepare("SELECT COUNT(*) as c FROM portfolio WHERE user_id=? AND post_id=?").get(uid, p.id).c > 0 : false
      })

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
      const user = db.prepare("SELECT dm_until FROM users WHERE id=?").get(uid)

      if (!user.dm_until || user.dm_until < Date.now()) {
        return Response.json({ error: "DM access expired" }, { status: 403 })
      }

      const messages = db.prepare(`
        SELECT m.*, u.username as from_username
        FROM messages m
        JOIN users u ON m.from_id=u.id
        WHERE m.to_id=? OR m.from_id=?
        ORDER BY m.created DESC
        LIMIT 50
      `).all(uid, uid)

      return Response.json(messages)
    }

    if (url.pathname === "/") {
      return new Response(Bun.file("index.html"))
    }

    return new Response("Not Found", { status: 404 })
  },

  websocket: {
    open(ws) {
      clients.add(ws)
    },

    close(ws) {
      clients.delete(ws)
      const uid = wsToUser.get(ws)
      if (uid) {
        wsToUser.delete(ws)
        userToWs.delete(uid)
      }
    },

    message(ws, msg) {
      const { t, d } = JSON.parse(msg)
      const uid = d.uid

      if (!wsToUser.has(ws)) {
        wsToUser.set(ws, uid)
        userToWs.set(uid, ws)
      }

      if (t === "post") {
        const user = db.prepare("SELECT username FROM users WHERE id=?").get(uid)
        if (!user || !d.text || d.text.length > 280) return

        const stmt = db.prepare("INSERT INTO posts(user_id,text) VALUES(?,?)")
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
        const existing = db.prepare("SELECT id FROM likes WHERE user_id=? AND post_id=?").get(uid, d.id)

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
        const existing = db.prepare("SELECT id FROM reshares WHERE user_id=? AND post_id=?").get(uid, d.id)
        const originalPost = db.prepare("SELECT * FROM posts WHERE id=?").get(d.id)

        if (!originalPost) return

        const user = db.prepare("SELECT username FROM users WHERE id=?").get(uid)

        if (existing) {
          db.prepare("DELETE FROM reshares WHERE user_id=? AND post_id=?").run(uid, d.id)
          db.prepare("DELETE FROM posts WHERE user_id=? AND original_post_id=?").run(uid, d.id)
          db.prepare("UPDATE users SET coins=coins-2 WHERE id=?").run(uid)
          db.prepare("UPDATE users SET coins=coins-5 WHERE id=?").run(originalPost.user_id)

          const count = db.prepare("SELECT COUNT(*) as c FROM reshares WHERE post_id=?").get(d.id).c
          const newValue = calcValue(count)
          db.prepare("UPDATE posts SET value=? WHERE id=?").run(newValue, d.id)

          broadcast({ t: "update", d: { id: d.id, reshare_count: count, value: newValue, user_id: uid, reshared: false } })
          broadcast({ t: "remove", d: { uid, original_id: d.id } })
          sendToUser(uid, { t: "balance", d: { coins: getCoins(uid), msg: "Unshared! -2 coins" } })
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

        const exists = db.prepare("SELECT id FROM portfolio WHERE user_id=? AND post_id=?").get(uid, d.id)
        if (exists) {
          sendToUser(uid, { t: "error", d: { msg: "Already own this post" } })
          return
        }

        db.prepare("INSERT INTO portfolio(user_id,post_id,buy_price) VALUES(?,?,?)").run(uid, d.id, post.value)
        db.prepare("UPDATE users SET coins=coins-? WHERE id=?").run(post.value, uid)
        db.prepare("UPDATE users SET coins=coins+? WHERE id=?").run(Math.floor(post.value * 0.8), post.user_id)

        broadcast({ t: "update", d: { id: d.id, user_id: uid, owns: true } })
        sendToUser(uid, { t: "balance", d: { coins: getCoins(uid), msg: `Bought post for ${post.value} coins!` } })
        sendToUser(post.user_id, { t: "balance", d: { coins: getCoins(post.user_id), msg: `Post sold for ${Math.floor(post.value * 0.8)} coins!` } })
      }

      if (t === "sell") {
        const portfolio = db.prepare("SELECT buy_price FROM portfolio WHERE user_id=? AND post_id=?").get(uid, d.id)
        const post = db.prepare("SELECT value,show_original FROM posts WHERE id=? AND deleted=0").get(d.id)

        if (!portfolio) {
          sendToUser(uid, { t: "error", d: { msg: "You don't own this post" } })
          return
        }

        if (post.show_original === 0) {
          db.prepare("INSERT INTO listings(user_id,post_id,price) VALUES(?,?,?)").run(uid, d.id, post.value)
          sendToUser(uid, { t: "success", d: { msg: "Post listed for sale, waiting for buyer..." } })
        } else {
          db.prepare("DELETE FROM portfolio WHERE user_id=? AND post_id=?").run(uid, d.id)
          db.prepare("UPDATE users SET coins=coins+? WHERE id=?").run(post.value, uid)
          broadcast({ t: "update", d: { id: d.id, user_id: uid, owns: false } })
          sendToUser(uid, { t: "balance", d: { coins: getCoins(uid), msg: `Sold post for ${post.value} coins!` } })
        }
      }

      if (t === "buy_dm") {
        const user = db.prepare("SELECT coins FROM users WHERE id=?").get(uid)

        if (user.coins < 50) {
          sendToUser(uid, { t: "error", d: { msg: "Need 50 coins for DM access" } })
          return
        }

        const dmUntil = Date.now() + (60 * 60 * 1000)
        db.prepare("UPDATE users SET coins=coins-50, dm_until=? WHERE id=?").run(dmUntil, uid)
        sendToUser(uid, { t: "dm_active", d: { dm_until: dmUntil, coins: getCoins(uid), msg: "DM unlocked for 1 hour!" } })
      }

      if (t === "send_message") {
        const user = db.prepare("SELECT dm_until FROM users WHERE id=?").get(uid)

        if (!user.dm_until || user.dm_until < Date.now()) {
          sendToUser(uid, { t: "error", d: { msg: "DM access expired. Buy for 50 coins!" } })
          return
        }

        if (!d.to_id || !d.text || d.text.length > 500) return

        const stmt = db.prepare("INSERT INTO messages(from_id,to_id,text) VALUES(?,?,?)")
        const result = stmt.run(uid, d.to_id, d.text)

        const sender = db.prepare("SELECT username FROM users WHERE id=?").get(uid)

        const message = {
          id: result.lastInsertRowid,
          from_id: uid,
          to_id: d.to_id,
          text: d.text,
          from_username: sender.username,
          created: Date.now()
        }

        sendToUser(uid, { t: "message", d: message })
        sendToUser(d.to_id, { t: "message", d: message })
      }

      if (t === "send") {
        const user = db.prepare("SELECT coins FROM users WHERE id=?").get(uid)
        const amount = parseInt(d.amount)

        if (!user || user.coins < amount || amount <= 0) {
          sendToUser(uid, { t: "error", d: { msg: "Insufficient balance" } })
          return
        }

        const stmt = db.prepare("INSERT INTO transfers(from_id,to_id,amount) VALUES(?,?,?)")
        const result = stmt.run(uid, d.toId, amount)

        simulateTransfer(result.lastInsertRowid, uid, d.toId, amount)
      }
    }
  }
})

const { Database } = require("bun:sqlite")
const db = new Database("app.db", { create: true })

db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA foreign_keys=ON;
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    coins INTEGER DEFAULT 100,
    dm_until INTEGER DEFAULT 0,
    last_claim INTEGER DEFAULT 0,
    created INTEGER DEFAULT(strftime('%s','now'))
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS posts(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL CHECK(length(text)<=280),
    value INTEGER DEFAULT 10,
    original_post_id INTEGER,
    show_original INTEGER DEFAULT 1,
    deleted INTEGER DEFAULT 0,
    created INTEGER DEFAULT(strftime('%s','now')),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(original_post_id) REFERENCES posts(id)
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS likes(
    user_id INTEGER,
    post_id INTEGER,
    created INTEGER DEFAULT(strftime('%s','now')),
    PRIMARY KEY(user_id,post_id)
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS reshares(
    user_id INTEGER,
    post_id INTEGER,
    created INTEGER DEFAULT(strftime('%s','now')),
    PRIMARY KEY(user_id,post_id)
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS portfolio(
    user_id INTEGER,
    post_id INTEGER,
    buy_price INTEGER,
    bought INTEGER DEFAULT(strftime('%s','now')),
    PRIMARY KEY(user_id,post_id)
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS listings(
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    post_id INTEGER,
    price INTEGER,
    created INTEGER DEFAULT(strftime('%s','now'))
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS messages(
    id INTEGER PRIMARY KEY,
    from_id INTEGER,
    to_id INTEGER,
    text TEXT NOT NULL CHECK(length(text)<=500),
    created INTEGER DEFAULT(strftime('%s','now'))
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS transfers(
    id INTEGER PRIMARY KEY,
    from_id INTEGER,
    to_id INTEGER,
    amount INTEGER,
    progress INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    created INTEGER DEFAULT(strftime('%s','now'))
  )
`)

db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_value ON posts(value DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id)`)

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
  clients.forEach(ws => ws.send(str))
}

function sendToUser(uid, msg) {
  const ws = userToWs.get(uid)
  if (ws) ws.send(JSON.stringify(msg))
}

function getCoins(uid) {
  const user = db.prepare("SELECT coins FROM users WHERE id=?").get(uid)
  return user ? user.coins : 0
}

function simulateTransfer(id, fromId, toId, amount) {
  let p = 0
  const int = setInterval(() => {
    p += 10
    db.prepare("UPDATE transfers SET progress=? WHERE id=?").run(p, id)
    sendToUser(fromId, { t: "progress", d: { id, p } })
    sendToUser(toId, { t: "progress", d: { id, p } })

    if (p >= 100) {
      clearInterval(int)
      db.prepare("UPDATE users SET coins=coins-? WHERE id=?").run(amount, fromId)
      db.prepare("UPDATE users SET coins=coins+? WHERE id=?").run(amount, toId)
      db.prepare("UPDATE transfers SET status='complete' WHERE id=?").run(id)

      sendToUser(fromId, { t: "balance", d: { coins: getCoins(fromId), msg: `Sent ${amount} coins!` } })
      sendToUser(toId, { t: "balance", d: { coins: getCoins(toId), msg: `Received ${amount} coins!` } })
    }
  }, 250)
}

console.log(`FreeLand running on http://localhost:${server.port}`)
