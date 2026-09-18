import { test, expect } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonStore } from "./json-store"
import { defaultConfig, parseConfig } from "../config"

test("atomic writes serialize snapshots and use private file permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vimex-store-"))
  try {
    const path = join(directory, "state.json")
    const store = new JsonStore(path, (v) => v as { draft: string })
    expect(await store.read({ draft: "" })).toEqual({ draft: "" })
    await Promise.all([store.write({ draft: "first" }), store.write({ draft: "last\n👨‍👩‍👧‍👦" })])
    expect(await store.read({ draft: "" })).toEqual({ draft: "last\n👨‍👩‍👧‍👦" })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, "utf8")).draft).toContain("last")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("corrupt state is surfaced rather than silently replacing the user's draft", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vimex-store-"))
  try {
    const path = join(directory, "state.json")
    await writeFile(path, "{broken")
    await expect(new JsonStore(path, v => v).read({})).rejects.toThrow("Unable to load")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("config defaults and invalid settings", () => {
  expect(parseConfig({})).toEqual(defaultConfig)
  expect(parseConfig({ theme: "nord" }).theme).toBe("nord")
  for (const bad of [{ version: 2 }, { insertEnter: "yes" }, { composerMaxHeight: 8 }, { foldTools: "true" }, { surprise: true }, { keybindings: [] }]) {
    expect(() => parseConfig(bad)).toThrow()
  }
})
