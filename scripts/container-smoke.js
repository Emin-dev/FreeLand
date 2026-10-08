import assert from "node:assert/strict"

// Only a disposable, loopback-bound CI container and synthetic data are used.
const [base, phase] = process.argv.slice(2)
assert.match(base || "", /^http:\/\/127\.0\.0\.1:\d+$/)
assert.ok(["seed", "restart", "after-backup", "restored"].includes(phase))
const origin = "https://freeland-container.example"
const username = "container_test"
const password = "synthetic-container-password"
const request = (path, options = {}) => fetch(base + path, { signal: AbortSignal.timeout(5000), ...options })

assert.equal((await request("/healthz")).status, 200)
assert.equal((await request("/")).status, 200)
assert.equal((await request("/api/session")).status, 401)
for (const path of ["/app.db", "/app.db-wal", "/var/data/freeland.sqlite", "/var/data/freeland-backup.sqlite", "/server.js", "/.env"]) {
  assert.equal((await request(path)).status, 404)
}
const body = JSON.stringify({ username, password, signup: phase === "seed" })
const rejected = await request("/api/auth", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: "https://other.example" }, body
})
assert.equal(rejected.status, 403)
const auth = await request("/api/auth", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body
})
assert.equal(auth.status, 200)
const setCookie = auth.headers.get("set-cookie")
for (const flag of ["HttpOnly", "SameSite=Strict", "Secure"]) assert.ok(setCookie.includes(flag))
const cookie = setCookie.split(";")[0]
const session = await request("/api/session", { headers: { Cookie: cookie } })
assert.equal((await session.json()).username, username)

async function post(text, expectedCoins) {
  const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers: { Cookie: cookie, Origin: origin } })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket connection timed out")), 5000)
      ws.onopen = () => { clearTimeout(timer); resolve() }
      ws.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")) }
    })
    const balance = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket update timed out")), 5000)
      ws.onmessage = event => {
        const message = JSON.parse(event.data)
        if (message.t === "balance") { clearTimeout(timer); resolve(message.d) }
      }
    })
    ws.send(JSON.stringify({ t: "post", d: { text } }))
    assert.equal((await balance).coins, expectedCoins)
  } finally { ws.close() }
}

if (phase === "seed") {
  await post("synthetic persistent container post", 110)
} else if (phase === "after-backup") {
  await post("synthetic post after backup", 120)
} else {
  const feed = await (await request("/api/feed", { headers: { Cookie: cookie } })).json()
  assert.equal(feed.filter(post => post.text === "synthetic persistent container post" && post.username === username).length, 1)
  const stats = await (await request("/api/stats", { headers: { Cookie: cookie } })).json()
  assert.equal(stats.coins, 110)
  if (phase === "restored") {
    assert.equal(feed.filter(post => post.text === "synthetic post after backup").length, 0)
    // Recovery must serve new authenticated writes, not just return old rows.
    await post("synthetic post after restore", 120)
    const recoveredFeed = await (await request("/api/feed", { headers: { Cookie: cookie } })).json()
    assert.equal(recoveredFeed.filter(post => post.text === "synthetic post after restore" && post.username === username).length, 1)
    const recoveredStats = await (await request("/api/stats", { headers: { Cookie: cookie } })).json()
    assert.equal(recoveredStats.coins, 120)
  }
  assert.equal((await request("/api/logout", { method: "POST", headers: { Cookie: cookie, Origin: origin } })).status, 200)
  assert.equal((await request("/api/session", { headers: { Cookie: cookie } })).status, 401)
}
console.log(`Container ${phase}: HTTP, origin checks, private storage and session checks passed`)
