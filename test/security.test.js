import { afterEach, beforeEach, expect, test } from "bun:test"
import { Script } from "node:vm"
import { createApp } from "../server.js"
import { openDatabase } from "../storage.js"

let app, base, time, sockets
const password = "synthetic-test-password"
beforeEach(() => {
  time = Date.now()
  sockets = []
  app = createApp({ port: 0, now: () => time })
  base = `http://127.0.0.1:${app.server.port}`
})
afterEach(() => { for (const ws of sockets) ws.close(); app.close() })

async function request(path, { cookie, origin = base, method = "GET", body, raw } = {}) {
  return fetch(base + path, {
    method,
    headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined || raw !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)
  })
}
async function signup(username) {
  const response = await request("/api/auth", { method: "POST", body: { username, password, signup: true } })
  expect(response.status).toBe(200)
  return { user: await response.json(), cookie: response.headers.get("set-cookie").split(";")[0], response }
}
async function socket(cookie, origin = base) {
  const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers: { Cookie: cookie, Origin: origin } })
  sockets.push(ws)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  return ws
}
function next(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener("message", handler); reject(new Error(`Timed out waiting for ${type}`)) }, 2000)
    function handler(event) {
      const message = JSON.parse(event.data)
      if (message.t === type) { clearTimeout(timer); ws.removeEventListener("message", handler); resolve(message.d) }
    }
    ws.addEventListener("message", handler)
  })
}
async function act(ws, t, d, response = "balance") {
  const result = next(ws, response)
  ws.send(JSON.stringify({ t, d }))
  return result
}
function coins(id) { return app.db.prepare("SELECT coins FROM users WHERE id=?").get(id).coins }

// All accounts, posts, messages, and databases in this suite are synthetic.
test("private reads and WebSocket upgrades reject unauthenticated identity claims", async () => {
  for (const path of ["/api/messages", "/api/stats", "/api/portfolio", "/api/session", "/ws"]) {
    expect((await request(path + "?uid=1")).status).toBe(401)
    expect((await request(path, { cookie: "freeland_session=" + "a".repeat(64) })).status).toBe(401)
  }
})

test("auth issues opaque HttpOnly sessions, hashes tokens, and verifies login", async () => {
  const alice = await signup("alice")
  const header = alice.response.headers.get("set-cookie")
  expect(header).toContain("HttpOnly")
  expect(header).toContain("SameSite=Strict")
  expect(header).toContain("Max-Age=86400")
  const session = app.db.prepare("SELECT * FROM sessions").get()
  expect(session.token_hash).not.toBe(alice.cookie.split("=")[1])
  expect(Object.keys(alice.user).sort()).toEqual(["coins", "dm_until", "id", "username"])
  expect((await request("/api/auth", { method: "POST", body: { username: "alice", password: "wrong-password" } })).status).toBe(401)
  expect((await request("/api/auth", { method: "POST", body: { username: "unknown", password } })).status).toBe(401)
  const login = await request("/api/auth", { method: "POST", body: { username: "alice", password } })
  expect(login.status).toBe(200)
  expect(login.headers.get("set-cookie")).not.toBe(header)
  expect((await request("/api/session", { cookie: alice.cookie })).headers.get("cache-control")).toBe("no-store")
})

test("legacy bcrypt hashes remain usable without opening historical storage", async () => {
  app.db.prepare("INSERT INTO users(username,password) VALUES(?,?)").run("legacy", await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 }))
  expect((await request("/api/auth", { method: "POST", body: { username: "legacy", password } })).status).toBe(200)
})

test("private data is scoped to the session despite a forged query uid", async () => {
  const alice = await signup("alice"), bob = await signup("bob"), carol = await signup("carol")
  app.db.prepare("INSERT INTO messages(from_id,to_id,text) VALUES(?,?,?)").run(bob.user.id, carol.user.id, "private synthetic message")
  app.db.prepare("UPDATE users SET coins=777 WHERE id=?").run(bob.user.id)
  const response = await request(`/api/messages?uid=${bob.user.id}`, { cookie: alice.cookie })
  expect(await response.json()).toEqual([])
  expect((await (await request(`/api/stats?uid=${bob.user.id}`, { cookie: alice.cookie })).json()).coins).toBe(100)
  expect(await (await request(`/api/portfolio?uid=${bob.user.id}`, { cookie: alice.cookie })).json()).toEqual([])
})

test("cross-origin auth, logout and socket upgrades fail, including missing origins", async () => {
  const alice = await signup("alice")
  for (const origin of ["https://other.example", "null", ""]) {
    expect((await request("/api/auth", { origin, method: "POST", body: { username: "alice", password } })).status).toBe(403)
    expect((await request("/api/logout", { origin, method: "POST", cookie: alice.cookie })).status).toBe(403)
    expect((await request("/ws", { origin, cookie: alice.cookie })).status).toBe(403)
  }
  expect((await request("/api/session", { cookie: alice.cookie })).status).toBe(200)
})

test("production cookies are Secure and proxy deployments use the configured public origin", async () => {
  app.close()
  app = createApp({ port: 0, secure: true, origin: "https://freeland.example", now: () => time })
  base = `http://127.0.0.1:${app.server.port}`
  const response = await request("/api/auth", { origin: "https://freeland.example", method: "POST", body: { username: "alice", password, signup: true } })
  expect(response.status).toBe(200)
  expect(response.headers.get("set-cookie")).toContain("; Secure")
  expect((await request("/api/logout", { method: "POST" })).status).toBe(403)
})

test("logout revokes the exact session and closes its sockets", async () => {
  const alice = await signup("alice"), ws = await socket(alice.cookie)
  const closed = new Promise(resolve => ws.addEventListener("close", resolve, { once: true }))
  const result = await request("/api/logout", { cookie: alice.cookie, method: "POST" })
  expect(result.status).toBe(200)
  expect(result.headers.get("set-cookie")).toContain("Max-Age=0")
  expect((await closed).code).toBe(1008)
  expect((await request("/api/session", { cookie: alice.cookie })).status).toBe(401)
  expect((await request("/ws", { cookie: alice.cookie })).status).toBe(401)
})

test("expired sessions fail HTTP and existing WebSocket writes", async () => {
  const alice = await signup("alice"), ws = await socket(alice.cookie)
  time += 24 * 60 * 60 * 1000
  expect((await request("/api/messages", { cookie: alice.cookie })).status).toBe(401)
  const closed = new Promise(resolve => ws.addEventListener("close", resolve, { once: true }))
  ws.send(JSON.stringify({ t: "post", d: { text: "must not save" } }))
  expect((await closed).code).toBe(1008)
  expect(app.db.prepare("SELECT COUNT(*) AS count FROM posts").get().count).toBe(0)
})

test("forged socket uid cannot impersonate another account or redirect private replies", async () => {
  const alice = await signup("alice"), bob = await signup("bob")
  const ws = await socket(alice.cookie)
  await act(ws, "post", { uid: bob.user.id, text: "synthetic post" })
  const post = app.db.prepare("SELECT * FROM posts").get()
  expect(post.user_id).toBe(alice.user.id)
  expect(coins(alice.user.id)).toBe(110)
  expect(coins(bob.user.id)).toBe(100)
  await act(ws, "buy_dm", { uid: bob.user.id }, "dm_active")
  const message = await act(ws, "send_message", { uid: bob.user.id, to_id: "bob", text: "synthetic DM" }, "message")
  expect(message.from_id).toBe(alice.user.id)
  expect(message.to_id).toBe(bob.user.id)
  expect(coins(alice.user.id)).toBe(60)
  expect(coins(bob.user.id)).toBe(100)
})

test("two sockets retain the same account's private notifications when one closes", async () => {
  const alice = await signup("alice")
  const first = await socket(alice.cookie), second = await socket(alice.cookie)
  const firstBalance = next(first, "balance")
  await act(second, "post", { text: "first synthetic post" })
  expect((await firstBalance).coins).toBe(110)
  const closed = new Promise(resolve => first.addEventListener("close", resolve, { once: true }))
  first.close(); await closed
  expect((await act(second, "post", { text: "second synthetic post" })).coins).toBe(120)
})

test("malformed and oversized action values return safe errors without losing the socket", async () => {
  const alice = await signup("alice"), ws = await socket(alice.cookie)
  for (const raw of ["{", "null", "[]", '{"t":"post"}', JSON.stringify({ t: "post", d: { text: {} } }), JSON.stringify({ t: "send_message", d: { text: "x".repeat(501), to_id: "alice" } }), JSON.stringify({ t: "buy", d: { id: "1" } }), JSON.stringify({ t: "like", d: { id: -1 } }), JSON.stringify({ t: "unknown", d: {} })]) {
    const error = next(ws, "error"); ws.send(raw)
    expect((await error).msg).not.toMatch(/ReferenceError|SQLITE|SELECT|undefined/)
  }
  expect((await act(ws, "post", { text: "still connected" })).coins).toBe(110)
})

test("transactions roll back all balance and portfolio changes after a database failure", async () => {
  const alice = await signup("alice"), bob = await signup("bob"), ws = await socket(alice.cookie)
  const post = app.db.prepare("INSERT INTO posts(user_id,text,value) VALUES(?,?,?)").run(bob.user.id, "synthetic post", 10)
  app.db.exec(`CREATE TRIGGER synthetic_failure BEFORE UPDATE OF coins ON users WHEN NEW.id=${bob.user.id} BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`)
  const error = await act(ws, "buy", { id: Number(post.lastInsertRowid) }, "error")
  expect(error.msg).toBe("Unable to complete action")
  expect(coins(alice.user.id)).toBe(100)
  expect(coins(bob.user.id)).toBe(100)
  expect(app.db.prepare("SELECT COUNT(*) AS count FROM portfolio").get().count).toBe(0)
})

test("buy, sell, reshare and like flows stay consistent and reject nonexistent/deleted posts", async () => {
  const alice = await signup("alice"), bob = await signup("bob")
  const ws = await socket(alice.cookie)
  const id = Number(app.db.prepare("INSERT INTO posts(user_id,text,value) VALUES(?,?,?)").run(bob.user.id, "synthetic post", 10).lastInsertRowid)
  await act(ws, "buy", { id })
  expect(coins(alice.user.id)).toBe(90)
  expect((await act(ws, "buy", { id }, "error")).msg).toBe("Already own this post")
  await act(ws, "sell", { id })
  expect(coins(alice.user.id)).toBe(100)
  await act(ws, "reshare", { id, text: "synthetic comment", show_original: true })
  expect(coins(alice.user.id)).toBe(102)
  await act(ws, "reshare", { id })
  expect(coins(alice.user.id)).toBe(100)
  await act(ws, "like", { id }, "update")
  expect(app.db.prepare("SELECT COUNT(*) AS count FROM likes").get().count).toBe(1)
  app.db.prepare("UPDATE posts SET deleted=1 WHERE id=?").run(id)
  for (const t of ["like", "reshare", "buy", "sell"]) expect((await act(ws, t, { id }, "error")).msg).toBe("Post not found")
  expect((await act(ws, "like", { id: 9999 }, "error")).msg).toBe("Post not found")
})

test("auth types, body sizes and methods are validated; sign-in attempts are bounded", async () => {
  expect((await request("/api/auth")).status).toBe(405)
  expect((await request("/api/feed", { method: "POST" })).status).toBe(405)
  expect((await request("/api/auth", { method: "POST", raw: "{" })).status).toBe(400)
  expect((await request("/api/auth", { method: "POST", body: { username: {}, password } })).status).toBe(400)
  expect((await request("/api/auth", { method: "POST", body: { username: "alice", password: "ä".repeat(40) } })).status).toBe(400)
  for (let i = 0; i < 7; i++) await request("/api/auth", { method: "POST", body: null })
  expect((await request("/api/auth", { method: "POST", body: null })).status).toBe(429)
  expect((await request("/api/auth", { method: "POST", raw: "x".repeat(5000) })).status).toBe(413)
})

test("repository storage and source files are never served; production storage is explicit", async () => {
  for (const path of ["/app.db", "/app.db-wal", "/app.db-shm", "/data/freeland.sqlite", "/server.js", "/.env"]) expect((await request(path)).status).toBe(404)
  expect(() => openDatabase({ production: true })).toThrow("absolute DB_PATH")
  expect(() => openDatabase({ path: "app.db", production: true })).toThrow("absolute DB_PATH")
  expect(() => openDatabase({ path: new URL("../app.db", import.meta.url).pathname })).toThrow("legacy repository database")
  const response = await request("/")
  expect(response.status).toBe(200)
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
  const html = await response.text()
  expect(html).toContain("virtual coins only")
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  expect(() => new Script(script)).not.toThrow()
  expect(script).not.toContain("?uid=")
  expect(script).not.toContain("localStorage")
})

test("undoing spent reshare rewards cannot make either account balance negative", async () => {
  const alice = await signup("alice"), bob = await signup("bob"), ws = await socket(alice.cookie)
  const id = Number(app.db.prepare("INSERT INTO posts(user_id,text,value) VALUES(?,?,?)").run(bob.user.id, "synthetic post", 10).lastInsertRowid)
  await act(ws, "reshare", { id })
  app.db.prepare("UPDATE users SET coins=0 WHERE id=?").run(bob.user.id)
  expect((await act(ws, "reshare", { id }, "error")).msg).toContain("rewards have been spent")
  expect(coins(alice.user.id)).toBe(102)
  expect(coins(bob.user.id)).toBe(0)
  expect(app.db.prepare("SELECT COUNT(*) AS count FROM reshares").get().count).toBe(1)
})

test("portfolio and feed personalization follow the session even with another user's uid", async () => {
  const alice = await signup("alice"), bob = await signup("bob")
  const id = Number(app.db.prepare("INSERT INTO posts(user_id,text,value) VALUES(?,?,?)").run(alice.user.id, "synthetic post", 10).lastInsertRowid)
  app.db.prepare("INSERT INTO portfolio(user_id,post_id,buy_price) VALUES(?,?,?)").run(bob.user.id, id, 10)
  app.db.prepare("INSERT INTO likes(user_id,post_id) VALUES(?,?)").run(bob.user.id, id)
  expect(await (await request(`/api/portfolio?uid=${bob.user.id}`, { cookie: alice.cookie })).json()).toEqual([])
  const publicFeed = await (await request(`/api/feed?uid=${bob.user.id}`)).json()
  expect(publicFeed[0].user_liked).toBe(false)
  expect(publicFeed[0].user_owns).toBe(false)
  const bobFeed = await (await request(`/api/feed?uid=${alice.user.id}`, { cookie: bob.cookie })).json()
  expect(bobFeed[0].user_liked).toBe(true)
  expect(bobFeed[0].user_owns).toBe(true)
})
