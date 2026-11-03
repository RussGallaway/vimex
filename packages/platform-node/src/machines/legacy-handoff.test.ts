import { afterEach, expect, test } from "bun:test"
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  rm,
  writeFile,
} from "node:fs/promises"
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

test("existing destination preserves prepared environment and exact dirty source state", async () => {
  const f = await fixture()
  await writeFile(join(f.source.cwd, ".gitignore"), ".env\nnode_modules/\n")
  await f.git(f.source, "add", ".gitignore")
  await f.git(f.source, "commit", "-qm", "ignore local environment")
  await f.git(f.destination, "fetch", f.source.cwd, "HEAD")
  await f.git(f.destination, "merge", "--ff-only", "FETCH_HEAD")
  await f.git(f.source, "checkout", "-b", "feature/travel")
  await writeFile(join(f.source.cwd, "tracked.txt"), "committed\n")
  await f.git(f.source, "commit", "-am", "unpublished feature")
  await writeFile(join(f.source.cwd, "tracked.txt"), "staged\n")
  await f.git(f.source, "add", "tracked.txt")
  await writeFile(join(f.source.cwd, "tracked.txt"), "working\n")
  await writeFile(join(f.source.cwd, "new.txt"), "new\n")
  await mkdir(join(f.destination.cwd, "node_modules"))
  await writeFile(join(f.destination.cwd, "node_modules", "installed"), "deps")
  await writeFile(join(f.destination.cwd, ".env"), "PORT=5555")
  const prepared = await prepareLegacyHandoff({
    ...f,
    destinationMode: "existing",
  })
  expect(prepared.cwd).toBe(await realpath(f.destination.cwd))
  expect(await f.git(f.destination, "branch", "--show-current")).toBe(
    "feature/travel",
  )
  expect(await f.git(f.destination, "rev-parse", "HEAD")).toBe(
    await f.git(f.source, "rev-parse", "HEAD"),
  )
  expect(await readFile(join(prepared.cwd, "tracked.txt"), "utf8")).toBe(
    "working\n",
  )
  expect(await f.git(f.destination, "show", ":tracked.txt")).toBe("staged")
  expect(await readFile(join(prepared.cwd, "new.txt"), "utf8")).toBe("new\n")
  expect(await readFile(join(prepared.cwd, ".env"), "utf8")).toBe("PORT=5555")
  await prepared.verifySourceUnchanged()
  await prepared.finalize()
  await prepared.cleanup()
  expect(
    await readFile(join(prepared.cwd, "node_modules", "installed"), "utf8"),
  ).toBe("deps")
}, 30000)

test("existing destination rollback restores original branch and removes only imported changes", async () => {
  const f = await fixture()
  const originalBranch = await f.git(f.destination, "branch", "--show-current")
  const originalHead = await f.git(f.destination, "rev-parse", "HEAD")
  await f.git(f.source, "checkout", "-b", "feature/new")
  await writeFile(join(f.source.cwd, "tracked.txt"), "committed\n")
  await f.git(f.source, "commit", "-am", "feature")
  await writeFile(join(f.source.cwd, "tracked.txt"), "staged\n")
  await f.git(f.source, "add", "tracked.txt")
  await writeFile(join(f.source.cwd, "tracked.txt"), "working\n")
  await writeFile(join(f.source.cwd, "new.txt"), "new\n")
  const prepared = await prepareLegacyHandoff({
    ...f,
    destinationMode: "existing",
  })
  await prepared.cleanup()
  expect(await f.git(f.destination, "branch", "--show-current")).toBe(
    originalBranch,
  )
  expect(await f.git(f.destination, "rev-parse", "HEAD")).toBe(originalHead)
  expect(await f.git(f.destination, "status", "--porcelain")).toBe("")
  expect(await readFile(join(f.destination.cwd, "tracked.txt"), "utf8")).toBe(
    "base\n",
  )
  expect(await f.git(f.destination, "branch", "--list", "feature/new")).toBe("")
}, 30000)

test("existing handoff refuses dirty checkout and ignored path collisions without modifying files", async () => {
  const f = await fixture()
  await writeFile(join(f.destination.cwd, "tracked.txt"), "local edit\n")
  await expect(
    prepareLegacyHandoff({ ...f, destinationMode: "existing" }),
  ).rejects.toThrow("must be clean")
  await f.git(f.destination, "checkout", "--", "tracked.txt")
  await writeFile(
    join(f.destination.cwd, ".git", "info", "exclude"),
    "secret.txt\n",
  )
  await writeFile(join(f.destination.cwd, "secret.txt"), "destination secret")
  await writeFile(join(f.source.cwd, "secret.txt"), "incoming")
  await f.git(f.source, "add", "secret.txt")
  await f.git(f.source, "commit", "-qm", "tracked incoming")
  await expect(
    prepareLegacyHandoff({ ...f, destinationMode: "existing" }),
  ).rejects.toThrow("ignored path")
  expect(await readFile(join(f.destination.cwd, "secret.txt"), "utf8")).toBe(
    "destination secret",
  )
}, 30000)

test("existing handoff refuses diverged or occupied source branch", async () => {
  const f = await fixture()
  await f.git(f.destination, "config", "user.email", "fixture@example.test")
  await f.git(f.destination, "config", "user.name", "Fixture")
  await writeFile(
    join(f.destination.cwd, "tracked.txt"),
    "destination commit\n",
  )
  await f.git(f.destination, "commit", "-am", "destination ahead")
  await expect(
    prepareLegacyHandoff({ ...f, destinationMode: "existing" }),
  ).rejects.toThrow("diverged or is ahead")
  await f.git(f.source, "checkout", "-b", "feature/occupied")
  await f.git(f.destination, "branch", "feature/occupied", "HEAD~1")
  await f.git(
    f.destination,
    "worktree",
    "add",
    join(f.root, "occupied"),
    "feature/occupied",
  )
  await expect(
    prepareLegacyHandoff({ ...f, destinationMode: "existing" }),
  ).rejects.toThrow("already checked out")
}, 30000)

test("existing rollback retains concurrent destination edits and releases its handoff lock", async () => {
  const f = await fixture()
  const prepared = await prepareLegacyHandoff({
    ...f,
    destinationMode: "existing",
  })
  await writeFile(join(f.destination.cwd, "tracked.txt"), "concurrent edit\n")
  await expect(prepared.verifySourceUnchanged()).rejects.toThrow(
    "Destination changed",
  )
  await expect(prepared.cleanup()).rejects.toThrow("recovery needs attention")
  expect(await readFile(join(f.destination.cwd, "tracked.txt"), "utf8")).toBe(
    "concurrent edit\n",
  )
  await expect(
    readFile(join(f.destination.cwd, ".git", "vimex-handoff.lock")),
  ).rejects.toThrow()
}, 30000)

test("existing source branch fast-forwards exactly and rollback restores its ref", async () => {
  const f = await fixture()
  const originalHead = await f.git(f.destination, "rev-parse", "HEAD")
  const originalBranch = await f.git(f.destination, "branch", "--show-current")
  await mkdir(join(f.source.cwd, "nested"))
  await writeFile(join(f.source.cwd, "nested", "file.txt"), "new commit\n")
  await f.git(f.source, "add", "nested")
  await f.git(f.source, "commit", "-qm", "unpublished commit")
  const prepared = await prepareLegacyHandoff({
    ...f,
    source: { cwd: join(f.source.cwd, "nested") },
    destinationMode: "existing",
  })
  expect(prepared.cwd).toBe(join(await realpath(f.destination.cwd), "nested"))
  expect(await f.git(f.destination, "branch", "--show-current")).toBe(
    originalBranch,
  )
  expect(await f.git(f.destination, "rev-parse", "HEAD")).not.toBe(originalHead)
  await prepared.cleanup()
  expect(await f.git(f.destination, "rev-parse", "HEAD")).toBe(originalHead)
  expect(await f.git(f.destination, "branch", "--show-current")).toBe(
    originalBranch,
  )
}, 30000)

test("existing destination rejects changed ignore rules before exposing its environment", async () => {
  const f = await fixture()
  await writeFile(join(f.source.cwd, ".gitignore"), ".env\n")
  await f.git(f.source, "add", ".gitignore")
  await f.git(f.source, "commit", "-qm", "ignore environment")
  await f.git(f.destination, "fetch", f.source.cwd, "HEAD")
  await f.git(f.destination, "merge", "--ff-only", "FETCH_HEAD")
  const originalHead = await f.git(f.destination, "rev-parse", "HEAD")
  await writeFile(join(f.destination.cwd, ".env"), "local secret")
  await f.git(f.source, "rm", ".gitignore")
  await f.git(f.source, "commit", "-qm", "remove ignore rule")
  await expect(
    prepareLegacyHandoff({ ...f, destinationMode: "existing" }),
  ).rejects.toThrow("ignore rules would expose")
  expect(await f.git(f.destination, "rev-parse", "HEAD")).toBe(originalHead)
  expect(await readFile(join(f.destination.cwd, ".env"), "utf8")).toBe(
    "local secret",
  )
}, 30000)

test("existing handoff preserves files outside an ignored symlink ancestor", async () => {
  const f = await fixture()
  const outside = join(f.root, "outside")
  await mkdir(outside)
  await writeFile(join(outside, "incoming.txt"), "outside must survive")
  await writeFile(join(f.destination.cwd, ".git", "info", "exclude"), "cache\n")
  await symlink(outside, join(f.destination.cwd, "cache"))
  expect(await f.git(f.destination, "status", "--porcelain")).toBe("")
  await mkdir(join(f.source.cwd, "cache"))
  await writeFile(join(f.source.cwd, "cache", "incoming.txt"), "incoming")
  await f.git(f.source, "add", "cache")
  await f.git(f.source, "commit", "-qm", "incoming path")
  const originalHead = await f.git(f.destination, "rev-parse", "HEAD")
  await expect(
    prepareLegacyHandoff({ ...f, destinationMode: "existing" }),
  ).rejects.toThrow("symlink ancestor")
  expect(await readFile(join(outside, "incoming.txt"), "utf8")).toBe(
    "outside must survive",
  )
  expect(await realpath(join(f.destination.cwd, "cache"))).toBe(
    await realpath(outside),
  )
  expect(await f.git(f.destination, "rev-parse", "HEAD")).toBe(originalHead)
}, 30000)

test("existing handoff lock refuses simultaneous transfer without releasing the owner lock", async () => {
  const f = await fixture()
  const prepared = await prepareLegacyHandoff({
    ...f,
    destinationMode: "existing",
  })
  const gitDir = await f.git(f.destination, "rev-parse", "--absolute-git-dir")
  await expect(
    prepareLegacyHandoff({ ...f, destinationMode: "existing" }),
  ).rejects.toThrow()
  expect(await realpath(join(gitDir, "vimex-handoff.lock"))).toBe(
    join(await realpath(gitDir), "vimex-handoff.lock"),
  )
  await prepared.verifySourceUnchanged()
  await prepared.cleanup()
  await expect(realpath(join(gitDir, "vimex-handoff.lock"))).rejects.toThrow()
}, 30000)

test("existing fast-forward refuses ignored files appearing after preflight", async () => {
  const f = await fixture()
  const sourceBranch = await f.git(f.source, "branch", "--show-current")
  await f.git(f.destination, "checkout", "-b", "prepared")
  await writeFile(
    join(f.destination.cwd, ".git", "info", "exclude"),
    "incoming.env\n",
  )
  await writeFile(join(f.source.cwd, "incoming.env"), "source value")
  await f.git(f.source, "add", "incoming.env")
  await f.git(f.source, "commit", "-qm", "incoming configuration")
  let completed = false
  const operation = prepareLegacyHandoff({ ...f, destinationMode: "existing" })
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      completed = true
    })
  let injected = false
  for (let attempt = 0; attempt < 5000 && !completed; attempt++) {
    const head = await readFile(join(f.destination.cwd, ".git", "HEAD"), "utf8")
    if (head.trim() === `ref: refs/heads/${sourceBranch}`) {
      await writeFile(
        join(f.destination.cwd, "incoming.env"),
        "local process configuration",
      )
      injected = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  const result = await operation
  if ("value" in result) await result.value.cleanup()
  expect(injected).toBe(true)
  expect("error" in result).toBe(true)
  expect(await readFile(join(f.destination.cwd, "incoming.env"), "utf8")).toBe(
    "local process configuration",
  )
}, 30000)
