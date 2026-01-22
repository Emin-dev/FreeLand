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
          const user = db.prepare("SELECT id,username,coins FROM users WHERE id=?").get(result.lastInsertRowid)
          return Response.json(user)
        } catch {
          return Response.json({ error: "Username taken" }, { status: 409 })
        }
      } else {
        const user = db.prepare("SELECT * FROM users WHERE username=?").get(username)
        if (!user || !(await Bun.password.verify(password, user.password))) {
          return Response.json({ error: "Invalid credentials" }, { status: 401 })
        }
        return Response.json({ id: user.id, username: user.username, coins: user.coins })
      }
    }

    if (url.pathname === "/api/feed") {
      const posts = db.prepare(`
        SELECT p.*, u.username 
        FROM posts p 
        JOIN users u ON p.user_id=u.id 
        ORDER BY p.created DESC 
        LIMIT 100
      `).all()
      return Response.json(posts)
    }

    if (url.pathname === "/api/stats") {
      const uid = parseInt(url.searchParams.get("uid"))
      const user = db.prepare("SELECT coins FROM users WHERE id=?").get(uid)
      const postCount = db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id=?").get(uid)
      const portfolio = db.prepare(`
        SELECT SUM(p.value) as total, SUM(pf.buy_price) as invested
        FROM portfolio pf
        JOIN posts p ON pf.post_id=p.id
        WHERE pf.user_id=?
      `).get(uid)

      const totalValue = portfolio.total || 0
      const invested = portfolio.invested || 1
      const roi = Math.round(((totalValue - invested) / invested) * 100)

      return Response.json({
        coins: user.coins,
        post_count: postCount.c,
        portfolio_value: totalValue,
        roi
      })
    }

    if (url.pathname === "/api/leaderboard") {
      const richest = db.prepare("SELECT username,coins FROM users ORDER BY coins DESC LIMIT 10").all()
      const valuable = db.prepare("SELECT text,value FROM posts ORDER BY value DESC LIMIT 10").all()
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
          likes: 0,
          reshares: 0,
          created: Date.now()
        }

        broadcast({ t: "new", d: post })
        sendToUser(uid, { t: "balance", d: { coins: getCoins(uid), msg: "+10 coins for posting!" } })
      }

      if (t === "like") {
        db.prepare("UPDATE posts SET likes=likes+1 WHERE id=?").run(d.id)
        const post = db.prepare("SELECT likes FROM posts WHERE id=?").get(d.id)
        broadcast({ t: "update", d: { id: d.id, likes: post.likes } })
      }

      if (t === "reshare") {
        const post = db.prepare("SELECT user_id,reshares FROM posts WHERE id=?").get(d.id)
        if (!post) return

        db.prepare("UPDATE posts SET reshares=reshares+1 WHERE id=?").run(d.id)

        const newReshares = post.reshares + 1
        const newValue = calcValue(newReshares)

        db.prepare("UPDATE posts SET value=? WHERE id=?").run(newValue, d.id)
        db.prepare("UPDATE users SET coins=coins+2 WHERE id=?").run(uid)
        db.prepare("UPDATE users SET coins=coins+5 WHERE id=?").run(post.user_id)

        broadcast({ t: "update", d: { id: d.id, reshares: newReshares, value: newValue } })
        sendToUser(uid, { t: "balance", d: { coins: getCoins(uid), msg: "+2 coins for reshare!" } })
        sendToUser(post.user_id, { t: "balance", d: { coins: getCoins(post.user_id), msg: "+5 coins from reshare!" } })
      }

      if (t === "buy") {
        const post = db.prepare("SELECT value,user_id FROM posts WHERE id=?").get(d.id)
        const user = db.prepare("SELECT coins FROM users WHERE id=?").get(uid)

        if (!post || !user || user.coins < post.value || post.user_id === uid) {
          sendToUser(uid, { t: "error", d: { msg: "Cannot buy this post" } })
          return
        }

        try {
          db.prepare("INSERT INTO portfolio(user_id,post_id,buy_price) VALUES(?,?,?)").run(uid, d.id, post.value)
          db.prepare("UPDATE users SET coins=coins-? WHERE id=?").run(post.value, uid)
          db.prepare("UPDATE users SET coins=coins+? WHERE id=?").run(Math.floor(post.value * 0.8), post.user_id)

          sendToUser(uid, { t: "balance", d: { coins: getCoins(uid), msg: `Bought post for ${post.value} coins!` } })
          sendToUser(post.user_id, { t: "balance", d: { coins: getCoins(post.user_id), msg: `Post sold for ${Math.floor(post.value * 0.8)} coins!` } })
        } catch {
          sendToUser(uid, { t: "error", d: { msg: "Already own this post" } })
        }
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
    likes INTEGER DEFAULT 0,
    reshares INTEGER DEFAULT 0,
    created INTEGER DEFAULT(strftime('%s','now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
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
