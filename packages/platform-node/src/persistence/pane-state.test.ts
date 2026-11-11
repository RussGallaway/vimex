import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emptyLocalState } from "@vimex/workbench"
import {
  PaneStateStore,
  paneIdentity,
  parsePaneCheckpoint,
  type PaneCheckpoint,
} from "./pane-state"

const identity = {
  server: "unix:///rex.sock",
  session: "session:one",
  block: "block:one",
}
const checkpoint = (thread: string): PaneCheckpoint => ({
  version: 1,
  instanceId: "instance-one",
  active: true,
  target: { machine: "local", thread, cwd: "/project", localCwd: "/project" },
  machines: { local: emptyLocalState() },
})

test("checkpoints retain an optional concrete SSH endpoint", () => {
  const saved = checkpoint("thread")
  expect(parsePaneCheckpoint(saved).target.sshHost).toBeUndefined()
  expect(
    parsePaneCheckpoint({
      ...saved,
      target: {
        ...saved.target,
        machine: "worker",
        sshHost: "user@original-host",
      },
    }).target.sshHost,
  ).toBe("user@original-host")
  expect(() =>
    parsePaneCheckpoint({ ...saved, target: { ...saved.target, sshHost: "" } }),
  ).toThrow()
})

test("identity requires an explicit server, session and exact block", () => {
  expect(paneIdentity({ REX_SESSION: "one", REX_BLOCK: "two" })).toBeUndefined()
  expect(
    paneIdentity({
      REX_SERVER: "server",
      REX_SESSION: "one",
      REX_BLOCK: "two",
    }),
  ).toEqual({ server: "server", session: "one", block: "two" })
})

test("pane checkpoints survive new store instances and never alias other identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-pane-"))
  try {
    const a = new PaneStateStore(identity, root)
    expect(await a.read()).toBeUndefined()
    const b = new PaneStateStore({ ...identity, block: "block:two" }, root)
    await Promise.all([
      a.write(checkpoint("first")),
      b.write(checkpoint("second")),
    ])
    expect(await new PaneStateStore(identity, root).read()).toEqual(
      checkpoint("first"),
    )
    expect((await b.read())?.target.thread).toBe("second")
    for (const other of [
      { ...identity, server: "another" },
      { ...identity, session: "another" },
    ])
      expect(await new PaneStateStore(other, root).read()).toBeUndefined()
    const release = await a.acquire()
    expect(await new PaneStateStore(identity, root).acquire()).toBeUndefined()
    const otherRelease = await b.acquire()
    expect(otherRelease).toBeDefined()
    await otherRelease!()
    await release!()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("corrupt, incompatible, or incorrectly bound checkpoints fail without overwriting", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-pane-corrupt-"))
  try {
    const store = new PaneStateStore(identity, root)
    await store.write(checkpoint("first"))
    const envelope = JSON.parse(await readFile(store.path, "utf8"))
    for (const bad of [
      "{broken",
      JSON.stringify({
        ...envelope,
        identity: { ...identity, block: "wrong" },
      }),
      JSON.stringify({
        ...envelope,
        checkpoint: { ...checkpoint("x"), version: 99 },
      }),
      JSON.stringify({
        ...envelope,
        checkpoint: { ...checkpoint("x"), machines: { local: { version: 1 } } },
      }),
    ]) {
      await writeFile(store.path, bad)
      await expect(store.read()).rejects.toThrow()
      expect(await readFile(store.path, "utf8")).toBe(bad)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
