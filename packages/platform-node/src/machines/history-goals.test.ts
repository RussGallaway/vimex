import { expect, test } from "bun:test"
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertNoStoredGoals } from "./history-goals"
import { runHostCommand } from "./host"

async function fixture(ids: string[] = [], invalidSchema = false, wal = false) {
  const root = await mkdtemp(join(tmpdir(), "vimex-history-goals-"))
  const path = join(root, "goals_1.sqlite")
  await runHostCommand({ cwd: root }, [
    "python3",
    "-c",
    `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1])
if sys.argv[4]=='true': c.execute('PRAGMA journal_mode=WAL')
c.execute('CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY NOT NULL, goal_id TEXT NOT NULL, objective TEXT NOT NULL, status TEXT NOT NULL, token_budget INTEGER, tokens_used INTEGER NOT NULL DEFAULT 0, time_used_seconds INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)')
for id in json.loads(sys.argv[2]): c.execute('INSERT INTO thread_goals VALUES (?,?,?,?,?,?,?,?,?)',(id,'goal','PRIVATE OBJECTIVE','paused',None,0,0,1,1))
if sys.argv[3]=='true': c.execute('ALTER TABLE thread_goals ADD COLUMN future_version TEXT')
c.commit()
if sys.argv[4]=='true':
 import os
 os._exit(0)
c.close()`,
    path,
    JSON.stringify(ids),
    String(invalidSchema),
    String(wal),
  ])
  return { root, path, close: () => rm(root, { recursive: true, force: true }) }
}
const check = (root: string, ids = ["parent", "child"]) =>
  assertNoStoredGoals({}, root, ids, "0.166.0")

test("goal guard rejects selected archived/active goal state without exposing objectives", async () => {
  const f = await fixture(["child"])
  try {
    await expect(check(f.root)).rejects.toThrow("stored goal state")
    try {
      await check(f.root)
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE OBJECTIVE")
    }
  } finally {
    await f.close()
  }
})

test("goal guard ignores unrelated threads and does not change the database", async () => {
  const f = await fixture(["unrelated"])
  try {
    const before = await readFile(f.path)
    const files = await readdir(f.root)
    await check(f.root)
    expect(await readFile(f.path)).toEqual(before)
    expect(await readdir(f.root)).toEqual(files)
  } finally {
    await f.close()
  }
})

test("missing goal store is safe; unknown schema and store versions fail closed", async () => {
  const f = await fixture([], true)
  try {
    await expect(check(f.root)).rejects.toThrow(
      "Unsupported Codex goal store schema",
    )
    await rm(f.path)
    await check(f.root)
    await writeFile(join(f.root, "goals_2.sqlite"), "future")
    await expect(check(f.root)).rejects.toThrow(
      "Unsupported Codex goal store version",
    )
  } finally {
    await f.close()
  }
})

test("goal guard rejects symlink stores, unknown servers, and unbounded IDs", async () => {
  const f = await fixture()
  try {
    await rm(f.path)
    const other = join(f.root, "other.sqlite")
    await writeFile(other, "private")
    await symlink(other, f.path)
    await expect(check(f.root)).rejects.toThrow("without symlinks")
    await expect(
      assertNoStoredGoals({}, f.root, ["parent"], "0.167.0"),
    ).rejects.toThrow("supported Codex")
    await expect(
      check(
        f.root,
        Array.from({ length: 65 }, (_, i) => `id${i}`),
      ),
    ).rejects.toThrow("Invalid session-tree")
    await expect(check(f.root, ["x' OR 1=1"])).rejects.toThrow(
      "Invalid session-tree",
    )
  } finally {
    await f.close()
  }
})

// An open native server commonly keeps committed goals in WAL. A reader must
// include them; immutable=1 would silently miss that state. SQLite may update
// shared-memory reader bookkeeping, but neither the database nor WAL is changed.
test("goal guard reads committed WAL goals without mutating goal data", async () => {
  const f = await fixture(["child"], false, true)
  try {
    const database = await readFile(f.path)
    const wal = await readFile(`${f.path}-wal`)
    await expect(check(f.root)).rejects.toThrow("stored goal state")
    expect(await readFile(f.path)).toEqual(database)
    expect(await readFile(`${f.path}-wal`)).toEqual(wal)
  } finally {
    await f.close()
  }
})
