import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../server.js"
import { openDatabase } from "../storage.js"

// No inherited DB_PATH, production configuration, or repository database is used.
const directory = mkdtempSync(join(tmpdir(), "freeland-ui-"))
const app = createApp({ db: openDatabase({ path: join(directory, "synthetic.sqlite") }), port: 4318 })
const close = () => { app.close(); rmSync(directory, { recursive: true, force: true }); process.exit(0) }
process.on("SIGTERM", close)
process.on("SIGINT", close)
console.log("Synthetic FreeLand browser server ready on loopback:4318")
