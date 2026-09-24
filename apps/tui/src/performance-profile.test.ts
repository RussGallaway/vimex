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
  expect(recorder.snapshot().buffer).toEqual({
    maxRecords: 3,
    evictedByAge: 0,
    evictedByCapacity: 1,
  })

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
  expect(recorder.snapshot().buffer).toEqual({
    maxRecords: 3,
    evictedByAge: 3,
    evictedByCapacity: 1,
  })
})

test("groups navigation bursts and reports paired frame sample counts", () => {
  const recorder = new PerformanceProfileRecorder({ now: () => 100 })
  const add = (
    phase: string,
    operationId: string,
    atMs: number,
    burstId = "private-burst-id",
  ) =>
    recorder.record({
      kind: "navigation",
      phase,
      operationId,
      burstId,
      atMs,
    })
  add("input", "private-input-1", 0)
  add("input", "private-input-2", 5)
  add("accepted", "private-input-2", 6)
  add("state_published", "private-input-2", 7)
  add("frame_callback_start", "private-input-2", 10)
  add("next_renderer_frame", "private-input-2", 15)
  add("accepted", "private-input-3", 16)
  add("state_published", "private-input-3", 17)
  const snapshot = recorder.snapshot()
  expect(snapshot.navigationBursts).toEqual([
    {
      burst: 1,
      inputCount: 2,
      acceptedCount: 2,
      publicationCount: 2,
      firstInputAtMs: 0,
      lastInputAtMs: 5,
      firstPublicationAtMs: 7,
      lastPublicationAtMs: 17,
      firstFrameAfterPublicationAtMs: 15,
      truncatedAtStart: false,
      mayContinueAfterExport: true,
    },
  ])
  expect(snapshot.audit.navigation).toEqual({
    inputs: 2,
    accepted: 2,
    published: 2,
    frameCallbacksStarted: 1,
    publicationsDuringFrame: 0,
    frames: 1,
    superseded: 0,
    operationsWithInputAndFrame: 1,
    operationsWithPublicationAndFrame: 1,
    operationsWithCallbackAndFrame: 1,
    bursts: 1,
    burstsWithPublicationAndFrame: 0,
  })
  expect(JSON.stringify(snapshot)).not.toContain("private")
})

test("flags a burst when its opening input was evicted", () => {
  const recorder = new PerformanceProfileRecorder({
    maxRecords: 3,
    now: () => 20,
  })
  for (const [phase, atMs] of [
    ["input", 0],
    ["input", 1],
    ["state_published", 2],
    ["next_renderer_frame", 3],
  ] as const)
    recorder.record({
      kind: "navigation",
      phase,
      atMs,
      operationId: "private-operation",
      burstId: "private-burst",
    })
  expect(recorder.snapshot().navigationBursts).toEqual([
    {
      burst: 1,
      inputCount: 1,
      acceptedCount: 0,
      publicationCount: 1,
      firstInputAtMs: 0,
      lastInputAtMs: 0,
      firstPublicationAtMs: 1,
      lastPublicationAtMs: 1,
      firstFrameAfterPublicationAtMs: 2,
      frameAfterLastPublicationAtMs: 2,
      truncatedAtStart: true,
      mayContinueAfterExport: true,
    },
  ])
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
    "frame_already_running_at_publication",
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
    "frame_already_running_at_publication",
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
      version: 2,
      windowMs: 900000,
      buffer: {
        maxRecords: 4096,
        evictedByAge: 0,
        evictedByCapacity: 0,
      },
      audit: {
        navigation: {
          inputs: 0,
          accepted: 0,
          published: 0,
          frameCallbacksStarted: 0,
          publicationsDuringFrame: 0,
          frames: 0,
          superseded: 0,
          operationsWithInputAndFrame: 0,
          operationsWithPublicationAndFrame: 0,
          operationsWithCallbackAndFrame: 0,
          bursts: 0,
          burstsWithPublicationAndFrame: 0,
        },
      },
      metadata: {
        vimexVersion: "0.1.0",
        bunVersion: "1.3.6",
        os: "darwin",
        arch: "arm64",
        viewportRows: 40,
        viewportColumns: 120,
      },
      navigationBursts: [],
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
