import { expect, test } from "bun:test"
import { emptyLocalState, type SavedThreadView } from "@vimex/workbench"
import { parseConfig, type PaneCheckpoint } from "@vimex/platform-node"
import {
  mergeLocalChanges,
  mergeConfigPatch,
  navigationSeed,
  observePaneTarget,
} from "./pane-persistence"

const view = (draft: string): SavedThreadView => ({
  draft,
  cursorOffset: 0,
  folded: {},
  viewport: { kind: "tail" },
  surface: "composer",
  outbox: [],
})

test("fresh-state patches preserve another process's threads and favorites", () => {
  const before = {
    ...emptyLocalState(),
    threads: { old: view("before") },
    favoriteThreadIds: ["old"],
  }
  const latest = {
    ...before,
    threads: { ...before.threads, other: view("another pane") },
    favoriteThreadIds: ["old", "other"],
  }
  const after = {
    ...before,
    threads: { old: view("edited") },
    favoriteThreadIds: ["mine"],
  }
  const merged = mergeLocalChanges(latest, before, after)
  expect(merged.threads).toEqual({
    old: view("edited"),
    other: view("another pane"),
  })
  expect(merged.favoriteThreadIds).toEqual(["other", "mine"])
})

test("new panes inherit navigation without copying unsent work", () => {
  const source = {
    ...emptyLocalState(),
    threads: {
      thread: {
        ...view("private draft"),
        images: [{ id: "image", path: "/private/image.png", label: "image" }],
        outbox: [
          {
            id: "message",
            text: "uncertain",
            images: [],
            mentions: [],
            intent: "next-turn" as const,
            status: "failed" as const,
          },
        ],
      },
    },
  }
  const seeded = navigationSeed(source)
  expect(seeded.threads.thread).toMatchObject({
    draft: "",
    outbox: [],
    cursorOffset: 0,
  })
  expect(seeded.threads.thread?.images).toBeUndefined()
  expect(source.threads.thread.draft).toBe("private draft")
})

test("machine switches update exact conversation target while retaining local launch settings", () => {
  const checkpoint: PaneCheckpoint = {
    version: 1,
    instanceId: "instance",
    active: true,
    machines: {},
    target: {
      machine: "local",
      cwd: "/old",
      localCwd: "/launch",
      config: "/config.json",
      thread: "old",
    },
  }
  const transitioning = {
    connection: "connecting" as const,
    pendingApprovals: 0,
  }
  expect(observePaneTarget(checkpoint, transitioning)).toBe(checkpoint)
  const next = observePaneTarget(checkpoint, {
    ...transitioning,
    resumeTarget: { machine: "remote", thread: "same-id", cwd: "/remote/repo" },
  })
  expect(next.target).toEqual({
    machine: "remote",
    thread: "same-id",
    cwd: "/remote/repo",
    localCwd: "/launch",
    config: "/config.json",
  })
})

test("shared config mutations preserve unrelated machine additions", () => {
  const before = parseConfig({ machines: { one: { sshHost: "one" } } })
  const latest = parseConfig({
    machines: { ...before.machines, other: { sshHost: "other" } },
    favoriteMachines: ["other"],
  })
  const merged = mergeConfigPatch(latest, before, {
    machines: { one: { sshHost: "one", label: "Renamed" } },
    favoriteMachines: ["one"],
  })
  expect(merged.machines.other).toEqual({ sshHost: "other" })
  expect(merged.machines.one?.label).toBe("Renamed")
  expect(merged.favoriteMachines).toEqual(["other", "one"])
})
