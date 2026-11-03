import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonStore } from "@vimex/platform-node"
import {
  createHandoffDestinations,
  parseHandoffDestinationState,
  type HandoffDestinationState,
} from "./handoff-destinations"

async function fixture() {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "vimex-destinations-")),
  )
  const repo = join(dir, "repo")
  const worktree = join(dir, "prepared space")
  await mkdir(repo)
  const git = async (cwd: string, ...args: string[]) => {
    const proc = Bun.spawn(
      ["git", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args],
      { stdout: "pipe", stderr: "pipe" },
    )
    const result = await proc.exited
    if (result) throw new Error(await new Response(proc.stderr).text())
    return await new Response(proc.stdout).text()
  }
  await git(repo, "init", "-b", "main")
  await git(repo, "config", "user.email", "test@example.invalid")
  await git(repo, "config", "user.name", "Fixture")
  await git(repo, "remote", "add", "origin", "https://example.invalid/repo.git")
  await writeFile(join(repo, "file"), "fixture\n")
  await git(repo, "add", "file")
  await git(repo, "commit", "-m", "initial")
  await git(repo, "worktree", "add", "-b", "prepared", worktree)
  const statePath = join(dir, "preferences.json")
  const store = new JsonStore(statePath, parseHandoffDestinationState)
  const create = (base = repo, overrideStore = store) =>
    createHandoffDestinations({
      target: (id) => ({ id, executable: "codex", mode: "daemon" }),
      directory: async () => base,
      store: overrideStore,
    })
  const input = { sourceId: "local", targetId: "devbox", cwd: repo }
  return {
    dir,
    repo,
    worktree,
    store,
    create,
    input,
    git,
    close: () => rm(dir, { recursive: true, force: true }),
  }
}

test("handoff destinations discover worktrees and browse canonical directories without modifying Git", async () => {
  const f = await fixture()
  try {
    const destinations = f.create()
    const listed = await destinations.list(f.input)
    expect(listed.entries.map((entry) => entry.cwd)).toContain(f.worktree)
    expect(
      listed.entries.find((entry) => entry.cwd === f.worktree),
    ).toMatchObject({ kind: "worktree", branch: "prepared", dirty: false })
    await writeFile(join(f.worktree, "file"), "changed\n")
    const browsed = await destinations.list({ ...f.input, directory: f.dir })
    expect(browsed.directory).toBe(f.dir)
    expect(
      browsed.entries.find((entry) => entry.cwd === f.worktree)?.dirty,
    ).toBe(true)
    expect(await f.git(f.repo, "branch", "--show-current")).toBe("main\n")
    await expect(
      destinations.list({ ...f.input, directory: join(f.dir, "missing") }),
    ).rejects.toThrow("does not exist")
  } finally {
    await f.close()
  }
})

test("favorites and committed destination persist per machine and origin across restart", async () => {
  const f = await fixture()
  try {
    const destinations = f.create()
    await destinations.setFavorite({
      ...f.input,
      destinationCwd: f.worktree,
      favorite: true,
    })
    await destinations.remember({ ...f.input, destinationCwd: f.worktree })
    const restarted = f.create("/missing-configured-root")
    const list = await restarted.list(f.input)
    expect(list.preferredCwd).toBe(f.worktree)
    expect(
      list.entries.find((entry) => entry.cwd === f.worktree)?.favorite,
    ).toBe(true)
    const otherMachine = await f
      .create()
      .list({ ...f.input, targetId: "another" })
    expect(otherMachine.preferredCwd).toBeUndefined()
    expect(otherMachine.entries.some((entry) => entry.favorite)).toBe(false)
    await destinations.setFavorite({
      ...f.input,
      destinationCwd: f.worktree,
      favorite: false,
    })
    expect(
      (await destinations.list(f.input)).entries.some(
        (entry) => entry.favorite,
      ),
    ).toBe(false)
  } finally {
    await f.close()
  }
})

test("favorite persistence fails without changing listed preferences and rejects non-worktree roots", async () => {
  const f = await fixture()
  try {
    const destinations = createHandoffDestinations({
      target: (id) => ({ id, executable: "codex", mode: "daemon" }),
      directory: async () => f.repo,
      store: {
        read: async () => ({}),
        write: async (_state: HandoffDestinationState) => {
          throw new Error("disk full")
        },
      },
    })
    await expect(
      destinations.setFavorite({
        ...f.input,
        destinationCwd: f.worktree,
        favorite: true,
      }),
    ).rejects.toThrow("disk full")
    expect(
      (await destinations.list(f.input)).entries.some(
        (entry) => entry.favorite,
      ),
    ).toBe(false)
    await expect(
      destinations.setFavorite({
        ...f.input,
        destinationCwd: f.dir,
        favorite: true,
      }),
    ).rejects.toThrow("worktree root")
    expect(() =>
      parseHandoffDestinationState({ bad: { favorites: ["relative"] } }),
    ).toThrow()
  } finally {
    await f.close()
  }
})

test("saved favorite remains usable when configured directory disappears before first handoff", async () => {
  const f = await fixture()
  try {
    await f
      .create()
      .setFavorite({ ...f.input, destinationCwd: f.worktree, favorite: true })
    const listing = await f.create(join(f.dir, "missing")).list(f.input)
    expect(listing.directory).toBe(f.worktree)
    expect(
      listing.entries.find((entry) => entry.cwd === f.worktree)?.favorite,
    ).toBe(true)
  } finally {
    await f.close()
  }
})

test("destination preference loading retries after a transient read failure", async () => {
  const f = await fixture()
  try {
    let reads = 0
    const destinations = createHandoffDestinations({
      target: (id) => ({ id, executable: "codex", mode: "daemon" }),
      directory: async () => f.repo,
      store: {
        read: async () => {
          if (++reads === 1) throw new Error("temporary read failure")
          return {}
        },
        write: async () => {},
      },
    })
    await expect(destinations.list(f.input)).rejects.toThrow(
      "temporary read failure",
    )
    expect(
      (await destinations.list(f.input)).entries.some(
        (entry) => entry.cwd === f.worktree,
      ),
    ).toBe(true)
    expect(reads).toBe(2)
  } finally {
    await f.close()
  }
})
