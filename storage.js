import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL(".", import.meta.url))

export function openDatabase({ path, production = false } = {}) {
  if (production && (!path || !isAbsolute(path))) throw new Error("Production requires an absolute DB_PATH on a persistent private volume")
  const filename = resolve(path || fileURLToPath(new URL("./data/freeland.sqlite", import.meta.url)))
  // Never silently reuse the historical database shipped with the source tree.
  if (filename === resolve(root, "app.db")) throw new Error("The legacy repository database is not a runtime database. Use a private DB_PATH.")
  mkdirSync(dirname(filename), { recursive: true })
  return new Database(filename, { create: true })
}
