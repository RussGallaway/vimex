import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  emptyLocalState,
  type LocalState,
  type SavedThreadView,
} from "@vimex/workbench"
import { PaneStateStore, type PaneCheckpoint } from "./pane-state"
import { importPaneState } from "./import-pane-state"

const identity = {
  server: "unix:///rex.sock",
  session: "session:one",
  block: "block:one",
}
const view = (draft = ""): SavedThreadView => ({
  draft,
  cursorOffset: 0,
  folded: {},
  viewport: { kind: "tail" },
  surface: "composer",
  outbox: [],
})
const checkpoint = (state = emptyLocalState()): PaneCheckpoint => ({
  version: 1,
  instanceId: "one",
  active: false,
  target: {
    machine: "local",
    thread: "thread",
    cwd: "/project",
    localCwd: "/project",
  },
  machines: { local: state },
})

test("explicit import copies recoverable work and images without changing legacy files", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-import-"))
  try {
    const sourceImage = join(root, "legacy.png")
    await writeFile(sourceImage, "image bytes")
    const image = { id: "image", label: "image", path: sourceImage }
    const legacy: LocalState = {
      version: 1,
      threads: {
        thread: {
          ...view("saved draft"),
          images: [image],
          outbox: [
            {
              id: "uncertain",
              text: "pending",
              images: [image],
              intent: "next-turn",
              status: "sending",
            },
          ],
        },
      },
      favoriteThreadIds: ["thread"],
    }
    const original = JSON.stringify(legacy)
    await writeFile(join(root, "views.json"), original)
    const store = new PaneStateStore(identity, root)
    await store.write(
      checkpoint({
        version: 1,
        threads: { thread: view(), other: view("keep mine") },
      }),
    )
    expect(await importPaneState(identity, root)).toEqual({
      machine: "local",
      threads: 1,
      images: 1,
    })
    const saved = (await store.read())!
    const imported = saved.machines.local!.threads.thread!
    expect(saved.active).toBe(false)
    expect(imported.draft).toBe("saved draft")
    expect(saved.machines.local!.threads.other!.draft).toBe("keep mine")
    const copied = imported.images![0]!.path
    expect(copied.startsWith(join(store.directory, "images"))).toBe(true)
    expect(imported.outbox[0]!.images![0]!.path).toBe(copied)
    expect(imported.outbox[0]!.status).toBe("sending")
    expect(await readFile(copied, "utf8")).toBe("image bytes")
    expect(await readFile(sourceImage, "utf8")).toBe("image bytes")
    expect(await readFile(join(root, "views.json"), "utf8")).toBe(original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("import refuses live ownership and conflicting unsent work without partial writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-import-conflict-"))
  try {
    const store = new PaneStateStore(identity, root)
    await store.write(
      checkpoint({ version: 1, threads: { thread: view("pane draft") } }),
    )
    await writeFile(
      join(root, "views.json"),
      JSON.stringify({ version: 1, threads: { thread: view("legacy draft") } }),
    )
    const before = await readFile(store.path, "utf8")
    const release = await store.acquire()
    await expect(importPaneState(identity, root)).rejects.toThrow("Quit it")
    await release!()
    await expect(importPaneState(identity, root)).rejects.toThrow(
      "different unsent work",
    )
    expect(await readFile(store.path, "utf8")).toBe(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("failed attachment copy removes new copies and leaves checkpoint intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-import-failed-"))
  try {
    const store = new PaneStateStore(identity, root)
    await store.write(checkpoint())
    const existing = join(root, "exists.png")
    await writeFile(existing, "image")
    await writeFile(
      join(root, "views.json"),
      JSON.stringify({
        version: 1,
        threads: {
          thread: {
            ...view("legacy"),
            images: [
              { id: "one", label: "one", path: existing },
              { id: "two", label: "two", path: join(root, "missing.png") },
            ],
          },
        },
      }),
    )
    const before = await readFile(store.path, "utf8")
    await expect(importPaneState(identity, root)).rejects.toThrow()
    expect(await readFile(store.path, "utf8")).toBe(before)
    expect(await readdir(join(store.directory, "images"))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("import selects only the checkpoint machine and requires an existing checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-import-remote-"))
  try {
    await expect(importPaneState(identity, root)).rejects.toThrow("Open Vimex")
    const store = new PaneStateStore(identity, root)
    const saved = checkpoint()
    await store.write({
      ...saved,
      target: { ...saved.target, machine: "worker" },
    })
    await writeFile(join(root, "views.json"), "{corrupt local must not be read")
    await writeFile(
      join(root, "views-worker.json"),
      JSON.stringify({ version: 1, threads: { remote: view("remote") } }),
    )
    expect((await importPaneState(identity, root)).machine).toBe("worker")
    expect((await store.read())!.machines.worker!.threads.remote!.draft).toBe(
      "remote",
    )
    expect((await store.read())!.machines.local).toEqual(emptyLocalState())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
