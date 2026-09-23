import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PerformanceProfileRecorder } from "./performance-profile"

test("keeps a bounded rolling window and remaps operation IDs in snapshots", () => {
  let now = 0
  const recorder = new PerformanceProfileRecorder({
    maxAgeMs: 100,
    maxRecords: 3,
    now: () => now,
  })
  recorder.record({
    kind: "submit",
    phase: "accepted",
    operationId: "thread-secret-a",
    atMs: 0,
  })
  recorder.record({
    kind: "submit",
    phase: "request_sent",
    operationId: "thread-secret-a",
    atMs: 10,
  })
  recorder.record({
    kind: "navigation",
    phase: "accepted",
    operationId: "thread-secret-b",
    atMs: 20,
  })
  recorder.record({
    kind: "navigation",
    phase: "first_navigation_frame",
    operationId: "thread-secret-b",
    atMs: 30,
  })

  expect(recorder.snapshot().events).toEqual([
    { kind: "submit", phase: "request_sent", atMs: 0, operation: 1 },
    { kind: "navigation", phase: "accepted", atMs: 10, operation: 2 },
    {
      kind: "navigation",
      phase: "first_navigation_frame",
      atMs: 20,
      operation: 2,
    },
  ])
  expect(JSON.stringify(recorder.snapshot())).not.toContain("thread-secret")

  now = 125
  expect(recorder.snapshot().events).toEqual([
    {
      kind: "navigation",
      phase: "first_navigation_frame",
      atMs: 0,
      operation: 1,
    },
  ])
  now = 131
  expect(recorder.snapshot().events).toEqual([])
})

test("copies only known numeric details and known enum values", () => {
  const detail = {
    transcriptItems: 100,
    visibleBlocks: Number.NaN,
    viewportRows: 30,
    viewportColumns: -1,
    action: "half_page_up" as const,
    rawPath: "/secret/workspace",
  }
  const recorder = new PerformanceProfileRecorder({ now: () => 50 })
  recorder.record({
    kind: "navigation",
    phase: "accepted",
    atMs: 50,
    detail,
  })
  detail.transcriptItems = 1000
  recorder.record({
    kind: "submit",
    phase: "private prompt" as "accepted",
    atMs: 50,
  })

  const snapshot = recorder.snapshot()
  expect(snapshot.events).toEqual([
    {
      kind: "navigation",
      phase: "accepted",
      atMs: 0,
      detail: {
        transcriptItems: 100,
        viewportRows: 30,
        action: "half_page_up",
      },
    },
  ])
  expect(JSON.stringify(snapshot)).not.toContain("secret")
})

test("retains submit lifecycle phases and wheel actions without accepting private strings", () => {
  const recorder = new PerformanceProfileRecorder({ now: () => 100 })
  for (const [index, phase] of [
    "attempted",
    "next_thread_activity",
    "next_thread_content",
    "next_thread_content_committed",
    "next_frame_after_content_commit",
    "superseded",
  ].entries()) {
    recorder.record({
      kind: "submit",
      phase,
      atMs: index,
      operationId: "private-thread-id",
    })
  }
  recorder.record({
    kind: "navigation",
    phase: "accepted",
    atMs: 6,
    detail: { action: "wheel_up", prompt: "private prompt" },
  })
  recorder.record({
    kind: "navigation",
    phase: "first_navigation_frame",
    atMs: 7,
    detail: { action: "wheel_down" },
  })
  recorder.record({
    kind: "submit",
    phase: "private prompt",
    atMs: 8,
  })

  const snapshot = recorder.snapshot()
  expect(snapshot.events.map((event) => event.phase)).toEqual([
    "attempted",
    "next_thread_activity",
    "next_thread_content",
    "next_thread_content_committed",
    "next_frame_after_content_commit",
    "superseded",
    "accepted",
    "first_navigation_frame",
  ])
  expect(snapshot.events.at(-2)?.detail).toEqual({ action: "wheel_up" })
  expect(snapshot.events.at(-1)?.detail).toEqual({ action: "wheel_down" })
  expect(JSON.stringify(snapshot)).not.toContain("private")
})

test("exports a private JSON file and leaves no temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-performance-test-"))
  try {
    const recorder = new PerformanceProfileRecorder({
      now: () => 25,
      metadata: {
        vimexVersion: "0.1.0",
        bunVersion: "1.3.6",
        os: "darwin",
        arch: "arm64",
        viewportRows: 40,
        viewportColumns: 120,
      },
    })
    recorder.record({
      kind: "submit",
      phase: "first_content_frame",
      atMs: 25,
      operationId: "private-codex-id",
    })
    const path = join(root, "profiles", "trace.json")
    expect(await recorder.exportTo(path)).toEqual({ path, recordCount: 1 })

    const file = await readFile(path, "utf8")
    expect(JSON.parse(file)).toEqual({
      format: "vimex-performance-trace",
      version: 1,
      windowMs: 900000,
      metadata: {
        vimexVersion: "0.1.0",
        bunVersion: "1.3.6",
        os: "darwin",
        arch: "arm64",
        viewportRows: 40,
        viewportColumns: 120,
      },
      events: [
        {
          kind: "submit",
          phase: "first_content_frame",
          atMs: 0,
          operation: 1,
        },
      ],
    })
    expect(file).not.toContain("private-codex-id")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(join(root, "profiles"))).toEqual(["trace.json"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
