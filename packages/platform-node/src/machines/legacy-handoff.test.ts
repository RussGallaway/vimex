import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareLegacyHandoff, validateLegacyRollout } from "./legacy-handoff"
import { hostOperation, runHostCommand } from "./host"

const roots: string[] = []
const originalStateHome = process.env.XDG_STATE_HOME

afterEach(async () => {
  if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalStateHome
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
function rollout(mode = "legacy") {
  return (
    JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-1", cwd: "/original", history_mode: mode },
    }) +
    "\n" +
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Keep the full conversation" }],
      },
    }) +
    "\n"
  )
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vimex-handoff-test-"))
  roots.push(root)
  process.env.XDG_STATE_HOME = join(root, "state")
  const source = { cwd: join(root, "source") }
  const destination = { cwd: join(root, "destination") }
  await mkdir(source.cwd)
  const git = async (host: typeof source, ...args: string[]) =>
    (await runHostCommand(host, ["git", ...args])).stdout
      .toString("utf8")
      .trim()
  await git(source, "init", "-q")
  await git(source, "config", "user.email", "fixture@example.test")
  await git(source, "config", "user.name", "Fixture")
  await writeFile(join(source.cwd, "tracked.txt"), "base\n")
  await git(source, "add", "tracked.txt")
  await git(source, "commit", "-qm", "base")
  await git(source, "clone", "-q", source.cwd, destination.cwd)
  await git(
    source,
    "remote",
    "add",
    "origin",
    "https://example.test/repository.git",
  )
  await git(
    destination,
    "remote",
    "set-url",
    "origin",
    "https://example.test/repository.git",
  )
  const rolloutPath = join(root, "rollout.jsonl")
  await writeFile(rolloutPath, rollout())
  return { root, source, destination, rolloutPath, threadId: "thread-1", git }
}
test("native handoff preserves full history, staging, unstaged edits, and untracked data without touching existing checkout", async () => {
  const f = await fixture()
  await writeFile(join(f.source.cwd, "tracked.txt"), "staged\n")
  await f.git(f.source, "add", "tracked.txt")
  await writeFile(join(f.source.cwd, "tracked.txt"), "working\n")
  await writeFile(join(f.source.cwd, "new file.txt"), "untracked\n")
  await writeFile(
    join(f.destination.cwd, "tracked.txt"),
    "destination untouched\n",
  )
  const sourceStatus = await f.git(f.source, "status", "--porcelain")
  const prepared = await prepareLegacyHandoff(f)
  expect(await readFile(join(prepared.cwd, "tracked.txt"), "utf8")).toBe(
    "working\n",
  )
  expect(await f.git({ cwd: prepared.cwd }, "show", ":tracked.txt")).toBe(
    "staged",
  )
  expect(await readFile(join(prepared.cwd, "new file.txt"), "utf8")).toBe(
    "untracked\n",
  )
  expect(await readFile(prepared.rolloutPath, "utf8")).toBe(rollout())
  expect(await readFile(join(f.destination.cwd, "tracked.txt"), "utf8")).toBe(
    "destination untouched\n",
  )
  expect(await f.git(f.source, "status", "--porcelain")).toBe(sourceStatus)
  await prepared.verifySourceUnchanged()
  await prepared.finalize()
  expect(await readFile(join(prepared.cwd, "tracked.txt"), "utf8")).toBe(
    "working\n",
  )
  await prepared.cleanup() // finalized successful work must never be deleted
  expect(await readFile(join(prepared.cwd, "tracked.txt"), "utf8")).toBe(
    "working\n",
  )
})
test("source edits invalidate prepared handoff; cleanup removes only the fresh worktree", async () => {
  const f = await fixture()
  const prepared = await prepareLegacyHandoff(f)
  await writeFile(join(f.source.cwd, "tracked.txt"), "new edit\n")
  await expect(prepared.verifySourceUnchanged()).rejects.toThrow(
    "changed during handoff",
  )
  await prepared.cleanup()
  expect(await readFile(join(f.destination.cwd, "tracked.txt"), "utf8")).toBe(
    "base\n",
  )
  await expect(readFile(join(prepared.cwd, "tracked.txt"))).rejects.toThrow()
})
test("paginated and dependent transcripts fail closed", () => {
  expect(() => validateLegacyRollout(rollout("paginated"), "thread-1")).toThrow(
    "Paginated",
  )
  expect(() =>
    validateLegacyRollout(
      JSON.stringify({
        type: "session_meta",
        payload: { id: "thread-1", history_base: { thread_id: "parent" } },
      }) + "\n",
      "thread-1",
    ),
  ).toThrow("depends")
  expect(() => validateLegacyRollout(rollout().trimEnd(), "thread-1")).toThrow(
    "incomplete",
  )
  expect(() => validateLegacyRollout(rollout(), "other")).toThrow("identity")
})
test("wrong repository refuses before preparing a destination", async () => {
  const f = await fixture()
  await f.git(
    f.destination,
    "remote",
    "set-url",
    "origin",
    "https://example.test/other.git",
  )
  await expect(prepareLegacyHandoff(f)).rejects.toThrow("matching repository")
})
test("remote host validation rejects SSH option injection before spawning", async () => {
  await expect(
    hostOperation({ sshHost: "-oProxyCommand=evil" }, { action: "resolve" }),
  ).rejects.toThrow("Invalid SSH host")
})

test("native fork history permits preserved ancestral metadata and compaction", () => {
  const ancestor =
    JSON.stringify({
      type: "session_meta",
      payload: { id: "ancestor", history_mode: "legacy" },
    }) + "\n"
  const compacted =
    JSON.stringify({
      type: "compacted",
      payload: {
        message: "Preserved context",
        replacement_history: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Preserved context" }],
          },
        ],
      },
    }) + "\n"
  expect(() =>
    validateLegacyRollout(rollout() + ancestor + compacted, "thread-1"),
  ).not.toThrow()
})

test("textconv configuration cannot transform the transferred patch", async () => {
  const f = await fixture()
  await writeFile(
    join(f.source.cwd, ".gitattributes"),
    "tracked.txt diff=render\n",
  )
  await f.git(f.source, "add", ".gitattributes")
  await f.git(f.source, "commit", "-qm", "attributes")
  await f.git(
    f.source,
    "config",
    "diff.render.textconv",
    "sed s/working/RENDERED/",
  )
  await writeFile(join(f.source.cwd, "tracked.txt"), "working\n")
  const prepared = await prepareLegacyHandoff(f)
  expect(await readFile(join(prepared.cwd, "tracked.txt"), "utf8")).toBe(
    "working\n",
  )
  await prepared.cleanup()
})

test("active checkout filters refuse before destination worktree creation", async () => {
  const f = await fixture()
  await writeFile(
    join(f.source.cwd, ".gitattributes"),
    "tracked.txt filter=custom\n",
  )
  await expect(prepareLegacyHandoff(f)).rejects.toThrow("active Git")
  expect(
    (await f.git(f.destination, "worktree", "list", "--porcelain")).match(
      /^worktree /gm,
    ),
  ).toHaveLength(1)
})

test("destination reconstruction mismatch rolls back its isolated worktree", async () => {
  const f = await fixture()
  await writeFile(join(f.source.cwd, "new.txt"), "must remain visible\n")
  await writeFile(
    join(f.destination.cwd, ".git", "info", "exclude"),
    "new.txt\n",
  )
  await expect(prepareLegacyHandoff(f)).rejects.toThrow("did not match")
  expect(
    (await f.git(f.destination, "worktree", "list", "--porcelain")).match(
      /^worktree /gm,
    ),
  ).toHaveLength(1)
  expect(await readFile(join(f.source.cwd, "new.txt"), "utf8")).toBe(
    "must remain visible\n",
  )
})
