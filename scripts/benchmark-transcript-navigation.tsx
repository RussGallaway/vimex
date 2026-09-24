// Opt-in, credential-free connected transcript navigation benchmark.
// Run: VIMEX_NAV_ITEMS=100 VIMEX_NAV_SHAPE=mixed bun scripts/benchmark-transcript-navigation.tsx
// Opt-in capacity run: VIMEX_NAV_WORKLOAD=capacity bun scripts/benchmark-transcript-navigation.tsx
// Key dispatch is simulated in a headless renderer, not a physical terminal.
import assert from "node:assert/strict"
import os from "node:os"
import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import type { ApprovalGateway } from "@vimex/approvals"
import type { ConversationGateway } from "@vimex/conversation"
import {
  buildTranscriptNavigationFixture,
  type TranscriptNavigationFixture,
} from "@vimex/testkit"
import {
  blockKey,
  buildTranscriptBlocks,
  defaultTranscriptWindowPolicy,
  TranscriptRuntime,
} from "@vimex/transcript"
import {
  VimexController,
  type ModelCatalog,
  type RuntimeConnection,
  type RuntimeEvent,
  type ThreadWorkspace,
} from "@vimex/workbench"
import { act, Profiler } from "react"
import { ConnectedVimexRoot } from "../packages/ui-opentui-react/src"
import { transcriptBlockRenderableId } from "../packages/ui-opentui-react/src/transcript/rendered-layout"

type Shape = "mixed" | "command" | "tool" | "agent" | "edit" | "markdown"
type Harness = Awaited<ReturnType<typeof createHarness>>
type Captured = {
  atMs: number
  cells: string
  blank: boolean
  top: number
  height: number
  cursor: string
  viewport: string
  presentationRevision: number
  measuredBlocks: number
  materializedBlocks: number
  roots: number
  descendants: number
  cursorPoint: null | {
    blockKey: string
    row: number
    column: number
    viewportRow: number
    blockRows: number
  }
  cursorItemBlocks: readonly {
    key: string
    sourceSpan: { from: number; to: number }
    fragment: string | null
    rows: number | null
    probes: Readonly<Record<number, { row: number; column: number } | null>>
  }[]
}

const fixtureVersion = "transcript-navigation-v1"
const shapes: readonly Shape[] = [
  "mixed",
  "command",
  "tool",
  "agent",
  "edit",
  "markdown",
]
const round = (value: number) => Number(value.toFixed(3))
const envInt = (name: string, fallback: number, min = 1) => {
  const raw = process.env[name] ?? String(fallback)
  const parsed = Number(raw)
  assert(
    Number.isInteger(parsed) && parsed >= min,
    `${name} must be an integer >= ${min}`,
  )
  return parsed
}
const workload = process.env.VIMEX_NAV_WORKLOAD ?? "full"
assert(
  ["full", "capacity"].includes(workload),
  "VIMEX_NAV_WORKLOAD must be full or capacity",
)
const capacity = workload === "capacity"
const renderBlockTarget = capacity
  ? envInt("VIMEX_NAV_RENDER_BLOCK_TARGET", 100_000)
  : null
const canonicalItems = envInt(
  "VIMEX_NAV_ITEMS",
  capacity ? renderBlockTarget! : 100,
)
const width = envInt("VIMEX_NAV_WIDTH", 80)
const height = envInt("VIMEX_NAV_HEIGHT", 24)
const overscanRows =
  process.env.VIMEX_NAV_OVERSCAN_ROWS === undefined
    ? null
    : envInt("VIMEX_NAV_OVERSCAN_ROWS", height, 0)
assert(
  overscanRows === null || overscanRows <= 2_000,
  "VIMEX_NAV_OVERSCAN_ROWS is capped at 2,000 for this diagnostic",
)
assert(
  !capacity || overscanRows === null || overscanRows <= height,
  "Capacity runs may not use overscan larger than the viewport",
)
const recentTailBlocks =
  process.env.VIMEX_NAV_RECENT_TAIL_BLOCKS === undefined
    ? null
    : envInt("VIMEX_NAV_RECENT_TAIL_BLOCKS", 100, 0)
const recentTailRows =
  process.env.VIMEX_NAV_RECENT_TAIL_ROWS === undefined
    ? null
    : envInt("VIMEX_NAV_RECENT_TAIL_ROWS", 240)
const olderLookAheadRows =
  process.env.VIMEX_NAV_OLDER_LOOK_AHEAD_ROWS === undefined
    ? null
    : envInt("VIMEX_NAV_OLDER_LOOK_AHEAD_ROWS", 48, 0)
const boundaryUpSteps = envInt("VIMEX_NAV_BOUNDARY_UP_STEPS", 0, 0)
assert(boundaryUpSteps <= 200, "VIMEX_NAV_BOUNDARY_UP_STEPS is capped at 200")
const repeats = envInt("VIMEX_NAV_REPEATS", 6)
const intervalMs = envInt("VIMEX_NAV_REPEAT_INTERVAL_MS", 33)
const capacityActions = (
  process.env.VIMEX_NAV_CAPACITY_ACTIONS ??
  "cold-up,queued-paced-up,return-to-tail"
)
  .split(",")
  .map((value) => value.trim())
assert(
  capacityActions.every((value) =>
    ["cold-up", "queued-paced-up", "burst-up-8", "return-to-tail"].includes(
      value,
    ),
  ),
  "VIMEX_NAV_CAPACITY_ACTIONS contains an unknown action",
)
const shape = (process.env.VIMEX_NAV_SHAPE ?? "mixed") as Shape
assert(
  shapes.includes(shape),
  `VIMEX_NAV_SHAPE must be one of ${shapes.join(", ")}`,
)
assert(
  canonicalItems <= (capacity ? 150_000 : 10_000),
  `Connected ${workload} benchmark exceeds its canonical-item cap`,
)
const denseOracle = !capacity && canonicalItems <= 160
const opentuiVersion = (
  (await Bun.file(
    new URL(import.meta.resolve("@opentui/core/package.json")),
  ).json()) as { version: string }
).version
const probeOffsets = (process.env.VIMEX_NAV_PROBE_OFFSETS ?? "")
  .split(",")
  .filter(Boolean)
  .map(Number)
assert(
  probeOffsets.every((value) => Number.isInteger(value) && value >= 0),
  "VIMEX_NAV_PROBE_OFFSETS must be comma-separated nonnegative integers",
)
const profileStages = process.env.VIMEX_NAV_PROFILE_STAGES === "1"

function percentile(values: readonly number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: values.length,
    p50: round(sorted[Math.floor((sorted.length - 1) * 0.5)]!),
    p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]!),
    max: round(sorted.at(-1)!),
  }
}

function semanticPosition(value: string, order: ReadonlyMap<string, number>) {
  const point = JSON.parse(value) as
    { itemId: string; graphemeOffset: number } | undefined
  if (!point) return null
  const ordinal = order.get(point.itemId)
  assert.notEqual(
    ordinal,
    undefined,
    `Cursor item ${point.itemId} is absent from the fixture`,
  )
  return { ordinal: ordinal!, offset: point.graphemeOffset }
}

function treeCounts(scroll: ScrollBoxRenderable) {
  let roots = 0
  let descendants = 0
  const pending: Renderable[] = [...scroll.getChildren()]
  while (pending.length) {
    const node = pending.pop()!
    descendants++
    if (node.id.startsWith("transcript-block:")) roots++
    pending.push(...node.getChildren())
  }
  return { roots, descendants }
}

function createGateway(fixture: TranscriptNavigationFixture) {
  let listener: (event: RuntimeEvent) => void = () => {}
  const summary = {
    id: fixture.threadId,
    title: `Navigation ${fixture.shape} ${fixture.blockCount}`,
    cwd: "/work",
    model: "benchmark",
    reasoningEffort: "high",
    status: "working" as const,
  }
  const gateway: ConversationGateway &
    ApprovalGateway &
    RuntimeConnection &
    ModelCatalog = {
    connect: async () => {},
    restart: async () => {},
    close: async () => {},
    subscribe(next) {
      listener = next
      return () => {
        listener = () => {}
      }
    },
    listThreads: async () => [summary],
    startThread: async () => ({ summary, events: [] }),
    resumeThread: async () => ({ summary, events: [] }),
    forkThread: async () => ({ summary, events: [] }),
    startTurn: async () => [],
    steerTurn: async () => {},
    interruptTurn: async () => {},
    updateSettings: async () => {},
    renameThread: async () => {},
    resolveApproval: async () => {},
    listModels: async () => [],
  }
  return { gateway, emit: (event: RuntimeEvent) => listener(event) }
}

async function createHarness(
  fixture: TranscriptNavigationFixture,
  dense: boolean,
) {
  const { gateway, emit } = createGateway(fixture)
  const controller = new VimexController({
    conversation: gateway,
    approvals: gateway,
    connection: gateway,
    models: gateway,
    resolveDirectory: (value) => value,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
  })
  await controller.initialize("/work", undefined, fixture.threadId)
  const state = controller.getSnapshot()
  const workspace = state.workspaces[fixture.threadId]
  assert(workspace, "Workbench did not create the fixture workspace")
  // Setup-only injection. Timed actions enter through connected key input or
  // controller/gateway public boundaries after the initial native frame settles.
  const seeded: ThreadWorkspace = Object.freeze({
    ...workspace,
    canonicalGeneration: 0,
    canonicalRevision: fixture.before.canonicalRevision,
    conversation: fixture.before.conversation,
    transcript: Object.freeze({
      ...fixture.before.transcript,
      selection: undefined,
      viewport: Object.freeze({ kind: "tail" as const }),
    }),
  })
  ;(state.workspaces as Record<string, ThreadWorkspace>)[fixture.threadId] =
    seeded
  assert.equal(
    controller.getPresentationSnapshot("main").workspaces[fixture.threadId],
    seeded,
  )
  const connected = new TranscriptRuntime(
    {
      threadId: fixture.threadId,
      canonicalGeneration: seeded.canonicalGeneration,
      canonicalRevision: seeded.canonicalRevision,
      conversation: seeded.conversation,
      transcript: seeded.transcript,
      mode: "follow",
      canonicalDamage: { kind: "full" },
    },
    dense
      ? {}
      : {
          windowPolicy: {
            viewportRows: height,
            overscanRows: overscanRows ?? height,
            recentTailBlocks:
              recentTailBlocks ??
              defaultTranscriptWindowPolicy.recentTailBlocks,
            recentTailRows:
              recentTailRows ?? defaultTranscriptWindowPolicy.recentTailRows,
            olderLookAheadRows:
              olderLookAheadRows ??
              defaultTranscriptWindowPolicy.olderLookAheadRows,
          },
        },
  )
  // Setup-only injection keeps the fixture's folds and block plan identical
  // to the connected runtime before timed input begins.
  if (dense) connected.setWindowViewport = () => connected.getSnapshot()
  else if (overscanRows !== null) {
    const configure = connected.setWindowViewport.bind(connected)
    connected.setWindowViewport = (viewportRows) =>
      configure(viewportRows, overscanRows)
  }
  const runtimes = (
    controller as unknown as {
      transcriptRuntimes: Map<string, TranscriptRuntime>
    }
  ).transcriptRuntimes
  runtimes.get("main")?.dispose()
  runtimes.set("main", connected)
  const commits: number[] = []
  function Root() {
    return (
      <Profiler
        id="navigation"
        onRender={(_, __, duration) => commits.push(duration)}
      >
        <ConnectedVimexRoot controller={controller} />
      </Profiler>
    )
  }
  const setup = await testRender(<Root />, { width, height })
  const runtime = controller.transcriptRuntime("main")!
  const scroll = setup.renderer.root.findDescendantById(
    "transcript",
  ) as ScrollBoxRenderable
  assert(scroll, "Transcript scrollbox did not mount")
  const workspaceSnapshot = () =>
    controller.getSnapshot().workspaces[fixture.threadId]!
  const capture = (): Captured => {
    const frame = runtime.getSnapshot()
    const cursor = workspaceSnapshot().transcript.cursor
    const lines = setup.captureCharFrame().split("\n")
    const cells = lines
      .slice(scroll.viewport.y, scroll.viewport.y + scroll.viewport.height)
      .join("\n")
    const counts = treeCounts(scroll)
    let cursorPoint: Captured["cursorPoint"] = null
    const cursorItemBlocks: Captured["cursorItemBlocks"] = cursor
      ? frame.window.blocks.flatMap((block) => {
          if (!("item" in block) || block.key.itemId !== cursor.itemId)
            return []
          const key = blockKey(block)
          const geometry = frame.geometry.byBlockKey[key]
          return [
            {
              key,
              sourceSpan: {
                from: block.sourceSpan.from,
                to: block.sourceSpan.to,
              },
              fragment: block.fragment?.kind ?? null,
              rows: geometry?.rows ?? null,
              probes: Object.fromEntries(
                probeOffsets.map((offset) => {
                  const point = geometry?.points[offset]
                  return [
                    offset,
                    point ? { row: point.row, column: point.column } : null,
                  ]
                }),
              ),
            },
          ]
        })
      : []
    if (cursor)
      for (const block of frame.window.blocks) {
        if (!("item" in block) || block.key.itemId !== cursor.itemId) continue
        const key = blockKey(block)
        const geometry = frame.geometry.byBlockKey[key]
        const point = geometry?.points[cursor.graphemeOffset]
        const root = scroll.getRenderable(transcriptBlockRenderableId(block))
        if (!point || !root) continue
        cursorPoint = {
          blockKey: key,
          row: point.row,
          column: point.column,
          viewportRow: root.screenY + point.row - scroll.viewport.screenY,
          blockRows: geometry.rows,
        }
        break
      }
    return {
      atMs: performance.now(),
      cells,
      blank: !cells.trim(),
      top: scroll.scrollTop,
      height: scroll.scrollHeight,
      cursor: JSON.stringify(workspaceSnapshot().transcript.cursor),
      viewport: JSON.stringify(workspaceSnapshot().transcript.viewport),
      presentationRevision: frame.presentationRevision,
      measuredBlocks: frame.geometry.measuredBlockCount,
      materializedBlocks: frame.window.blocks.length,
      ...counts,
      cursorPoint,
      cursorItemBlocks,
    }
  }
  async function settle() {
    let unchanged = 0
    let last = ""
    for (let pass = 0; pass < 40 && unchanged < 3; pass++) {
      await act(async () => {
        await setup.flush()
        await setup.renderOnce()
      })
      const frame = runtime.getSnapshot()
      const signature = `${frame.presentationRevision}:${scroll.scrollTop}:${frame.window.blocks.length}:${frame.geometry.revision}`
      unchanged = signature === last ? unchanged + 1 : 0
      last = signature
    }
    assert.equal(unchanged, 3, "Native layout failed to stabilize")
    // Overscan geometry may be deferred. Every physically visible block that
    // can participate in row-to-source navigation must be exact at baseline.
    const snapshot = runtime.getSnapshot()
    const missingVisible: string[] = []
    for (const block of snapshot.window.blocks) {
      const native = scroll.getRenderable(transcriptBlockRenderableId(block))
      if (!native || native.height <= 0) continue
      if (
        native.screenY + native.height <= scroll.viewport.screenY ||
        native.screenY >= scroll.viewport.screenY + scroll.viewport.height
      )
        continue
      const key = blockKey(block)
      if (!snapshot.geometry.byBlockKey[key]) missingVisible.push(key)
    }
    assert.equal(
      missingVisible.length,
      0,
      `Visible block geometry missing in ${dense ? "dense" : "windowed"} control: ${missingVisible.slice(0, 6).join(", ")}`,
    )
  }
  await settle()
  // Input is measured with normal-mode transcript focus, as a reader would use it.
  await act(async () => {
    controller.dispatchInteraction({ type: "mode.normal" })
    controller.dispatchInteraction({ type: "focus.set", surface: "transcript" })
    controller.transcript({
      type: "cursor.move",
      target: { itemId: fixture.tailItemId, graphemeOffset: 0 },
      preferredScreenRow: 0,
      extend: false,
    })
  })
  await settle()
  return {
    controller,
    runtime,
    setup,
    scroll,
    commits,
    emit,
    capture,
    settle,
    workspaceSnapshot,
    async close() {
      await act(async () => setup.renderer.destroy())
      await controller.close()
    },
  }
}

type Action = {
  name: string
  group: string
  dispatch: (
    h: Harness,
    recordKey: (key: string, dueAt?: number) => void,
  ) => void | Promise<void>
}

async function observeAction(
  h: Harness,
  action: Action,
  order: ReadonlyMap<string, number>,
  expected?: Captured,
) {
  const before = h.capture()
  const frames: Captured[] = []
  const stageSamples: {
    operation: string
    atMs: number
    durationMs: number
  }[] = []
  const originalEmit = h.setup.renderer.emit
  const root = h.setup.renderer.root
  const originalLayout = root.calculateLayout
  let nativeLayoutPasses = 0
  let nativeLayoutMs = 0
  root.calculateLayout = function (...args) {
    const began = performance.now()
    try {
      return originalLayout.apply(this, args)
    } finally {
      nativeLayoutPasses++
      nativeLayoutMs += performance.now() - began
    }
  }
  const stageStarted = performance.now()
  const recordStage = (operation: string, began: number) => {
    if (profileStages)
      stageSamples.push({
        operation,
        atMs: round(began - stageStarted),
        durationMs: round(performance.now() - began),
      })
  }
  h.setup.renderer.emit = function (
    event: string | symbol,
    ...args: unknown[]
  ) {
    // A FRAME listener may correct geometry only AFTER these cells were painted.
    if (event === "frame") {
      const began = performance.now()
      frames.push(h.capture())
      recordStage("frame.capture", began)
    }
    const began = performance.now()
    try {
      return originalEmit.call(this, event, ...args)
    } finally {
      if (event === "frame") recordStage("frame.listeners", began)
    }
  }
  let runtimePublications = 0
  let presentationPublications = 0
  const unsubscribeRuntime = h.runtime.subscribe(() => runtimePublications++)
  const unsubscribePresentation = h.controller.subscribePresentation(
    "main",
    () => presentationPublications++,
  )
  const commitStart = h.commits.length
  const started = performance.now()
  const dispatchSubsteps: {
    operation: string
    atMs: number
    durationMs: number
  }[] = []
  const profiledReturn = capacity && action.name === "return-to-tail"
  const profiledAction = profiledReturn || profileStages
  const controllerPatch = h.controller as unknown as {
    transcript: (...args: unknown[]) => unknown
  }
  const runtimePatch = h.runtime as unknown as {
    update: (...args: unknown[]) => unknown
    reportMeasurements: (...args: unknown[]) => unknown
    setWindowViewport: (...args: unknown[]) => unknown
  }
  const scrollPatch = h.scroll as unknown as {
    scrollTo: (...args: unknown[]) => unknown
  }
  const originalTranscript = controllerPatch.transcript
  const originalScrollTo = scrollPatch.scrollTo
  const originalRuntimeUpdate = runtimePatch.update
  const originalMeasurements = runtimePatch.reportMeasurements
  const originalSetWindowViewport = runtimePatch.setWindowViewport
  const controllerStages = h.controller as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >
  const originalControllerStages = new Map<
    string,
    (...args: unknown[]) => unknown
  >()
  if (profileStages) {
    for (const operation of [
      "dispatch",
      "setState",
      "prepareWorkbenchViews",
      "syncTranscriptRuntimes",
      "notifyWorkbenchViews",
      "publishExternalObservers",
    ]) {
      const original = controllerStages[operation]
      if (!original) continue
      originalControllerStages.set(operation, original)
      controllerStages[operation] = function (...args) {
        const began = performance.now()
        try {
          return original.apply(this, args)
        } finally {
          recordStage(`workbench.${operation}`, began)
        }
      }
    }
    runtimePatch.update = function (...args) {
      const began = performance.now()
      try {
        return originalRuntimeUpdate.apply(this, args)
      } finally {
        recordStage("runtime.update", began)
      }
    }
    runtimePatch.reportMeasurements = function (...args) {
      const began = performance.now()
      try {
        return originalMeasurements.apply(this, args)
      } finally {
        recordStage("runtime.reportMeasurements", began)
      }
    }
    runtimePatch.setWindowViewport = function (...args) {
      const began = performance.now()
      try {
        return originalSetWindowViewport.apply(this, args)
      } finally {
        recordStage("runtime.setWindowViewport", began)
      }
    }
  }
  if (profiledAction) {
    controllerPatch.transcript = function (...args) {
      const at = performance.now()
      try {
        return originalTranscript.apply(this, args)
      } finally {
        dispatchSubsteps.push({
          operation: `controller.transcript:${String((args[0] as { type?: string } | undefined)?.type)}`,
          atMs: round(at - started),
          durationMs: round(performance.now() - at),
        })
      }
    }
    scrollPatch.scrollTo = function (...args) {
      const at = performance.now()
      try {
        return originalScrollTo.apply(this, args)
      } finally {
        dispatchSubsteps.push({
          operation: "native.scrollTo",
          atMs: round(at - started),
          durationMs: round(performance.now() - at),
        })
      }
    }
  }
  const keyDispatches: {
    key: string
    atMs: number
    dueAtMs: number | null
    cursor: string
    viewport: string
  }[] = []
  const recordKey = (key: string, dueAt?: number) => {
    // Keep the input path light: a full cell/tree capture here would itself
    // delay the next queued key, especially at large transcript sizes.
    const at = performance.now()
    const transcript = h.workspaceSnapshot().transcript
    keyDispatches.push({
      key,
      atMs: round(at - started),
      dueAtMs: dueAt === undefined ? null : round(dueAt - started),
      cursor: JSON.stringify(transcript.cursor),
      viewport: JSON.stringify(transcript.viewport),
    })
  }
  let dispatchedAt = started
  try {
    await act(async () => {
      await action.dispatch(h, recordKey)
      dispatchedAt = performance.now()
      await h.setup.flush()
      await h.setup.renderOnce()
    })
    await h.settle()
  } finally {
    h.setup.renderer.emit = originalEmit
    root.calculateLayout = originalLayout
    if (profiledAction) {
      controllerPatch.transcript = originalTranscript
      scrollPatch.scrollTo = originalScrollTo
    }
    if (profileStages) {
      for (const [operation, original] of originalControllerStages)
        controllerStages[operation] = original
      runtimePatch.update = originalRuntimeUpdate
      runtimePatch.reportMeasurements = originalMeasurements
      runtimePatch.setWindowViewport = originalSetWindowViewport
    }
    unsubscribeRuntime()
    unsubscribePresentation()
  }
  const ended = performance.now()
  const final = h.capture()
  const semanticDirection = [
    "cold",
    "paced-up",
    "queued-paced-up",
    "synchronous-burst",
  ].includes(action.group)
    ? "up"
    : action.group === "reverse-down"
      ? "down"
      : null
  const semanticViolations: { from: string; to: string; step: number }[] = []
  if (semanticDirection) {
    const positions = [
      before.cursor,
      ...keyDispatches.map((key) => key.cursor),
      final.cursor,
    ]
    for (let step = 1; step < positions.length; step++) {
      const from = semanticPosition(positions[step - 1]!, order)
      const to = semanticPosition(positions[step]!, order)
      if (!from || !to) continue
      const delta =
        from.ordinal === to.ordinal
          ? to.offset - from.offset
          : to.ordinal - from.ordinal
      if (
        (semanticDirection === "up" && delta > 0) ||
        (semanticDirection === "down" && delta < 0)
      )
        semanticViolations.push({
          from: positions[step - 1]!,
          to: positions[step]!,
          step,
        })
    }
  }
  assert(frames.length > 0, `${action.name}: no native paint`)
  const denseMatch = expected
    ? {
        cursor: final.cursor === expected.cursor,
        viewport: final.viewport === expected.viewport,
        cells: final.cells === expected.cells,
      }
    : null
  const sameDestination = (frame: Captured, destination: Captured) =>
    frame.cells === destination.cells &&
    frame.cursor === destination.cursor &&
    frame.viewport === destination.viewport
  const firstPaint = frames[0]!
  const firstChanged = frames.find((frame) => frame.cells !== before.cells)
  const firstDenseMatch = expected
    ? frames.find((frame) => sameDestination(frame, expected))
    : undefined
  const firstFinal = frames.find((frame) => sameDestination(frame, final))
  return {
    name: action.name,
    group: action.group,
    semanticDirection,
    semanticMonotonic: semanticViolations.length === 0,
    semanticViolations,
    inputDispatchMs: round(dispatchedAt - started),
    dispatchSubsteps,
    stageSamples,
    firstPaintMs: round(firstPaint.atMs - started),
    firstChangedPaintMs: firstChanged
      ? round(firstChanged.atMs - started)
      : null,
    firstDenseMatchPaintMs: firstDenseMatch
      ? round(firstDenseMatch.atMs - started)
      : null,
    firstFinalPaintMs: firstFinal ? round(firstFinal.atMs - started) : null,
    finalSettlementMs: round(ended - started),
    nativeFrames: frames.length,
    keyDispatches,
    actualKeyDispatchIntervalsMs: keyDispatches
      .slice(1)
      .map((key, index) => round(key.atMs - keyDispatches[index]!.atMs)),
    paintFrames: frames.map((frame) => ({
      atMs: round(frame.atMs - started),
      cells: frame.cells,
      blank: frame.blank,
      top: frame.top,
      cursor: frame.cursor,
      viewport: frame.viewport,
      presentationRevision: frame.presentationRevision,
      keysDispatched: keyDispatches.filter(
        (key) => key.atMs <= round(frame.atMs - started),
      ).length,
    })),
    blankFrames: frames.filter((frame) => frame.blank).length,
    nonDestinationFrames: frames.filter(
      (frame) => !sameDestination(frame, final),
    ).length,
    correctionFrames: frames.filter(
      (frame) => frame.presentationRevision !== firstPaint.presentationRevision,
    ).length,
    runtimePublications,
    presentationPublications,
    nativeLayoutPasses,
    nativeLayoutMs: round(nativeLayoutMs),
    denseMatch,
    denseReference: expected
      ? {
          cursor: expected.cursor,
          viewport: expected.viewport,
          cursorPoint: expected.cursorPoint,
          cursorItemBlocks: expected.cursorItemBlocks,
          top: expected.top,
          cells: expected.cells,
          cellMatch: denseMatch?.cells,
        }
      : null,
    reactCommits: h.commits.length - commitStart,
    reactCommitDurationsMs: h.commits.slice(commitStart).map(round),
    before: {
      cells: before.cells,
      top: before.top,
      cursor: before.cursor,
      viewport: before.viewport,
      cursorPoint: before.cursorPoint,
      cursorItemBlocks: before.cursorItemBlocks,
    },
    after: {
      cells: final.cells,
      top: final.top,
      cursor: final.cursor,
      viewport: final.viewport,
      measuredBlocks: final.measuredBlocks,
      materializedBlocks: final.materializedBlocks,
      roots: final.roots,
      descendants: final.descendants,
      cursorPoint: final.cursorPoint,
      cursorItemBlocks: final.cursorItemBlocks,
    },
  }
}

async function run() {
  const memoryStart = process.memoryUsage()
  const fixtureStarted = performance.now()
  const fixture = buildTranscriptNavigationFixture({
    blockCount: canonicalItems,
    shape,
  })
  assert.equal(fixture.fixtureVersion, fixtureVersion)
  assert(fixture.blockCount > 0, "Fixture produced no render blocks")
  assert(fixture.contentHash, "Fixture lacks a content hash")
  if (renderBlockTarget !== null)
    assert(
      fixture.blockCount >= renderBlockTarget,
      `Capacity fixture has ${fixture.blockCount} render blocks, below target ${renderBlockTarget}; increase VIMEX_NAV_ITEMS`,
    )
  const fixtureBuildMs = round(performance.now() - fixtureStarted)
  const memoryAfterFixture = process.memoryUsage()
  const semanticOrder = new Map(
    fixture.before.transcript.order.map((itemId, index) => [itemId, index]),
  )
  let measured: Harness | undefined
  let oracle: Harness | undefined
  try {
    const harnessStarted = performance.now()
    measured = await createHarness(fixture, false)
    const connectedStartupMs = round(performance.now() - harnessStarted)
    const memoryAfterHarness = process.memoryUsage()
    const connectedSetup = measured.capture()
    const connectedRenderBlocks = measured.runtime.getSnapshot().blocks.length
    const connectedWorkspace =
      measured.controller.getSnapshot().workspaces[fixture.threadId]!
    assert.deepEqual(
      measured.runtime.getSnapshot().blocks.map(blockKey),
      buildTranscriptBlocks({
        conversation: connectedWorkspace.conversation,
        transcript: connectedWorkspace.transcript,
      }).map(blockKey),
      "Connected runtime block plan differs from the connected transcript",
    )
    if (denseOracle) oracle = await createHarness(fixture, true)
    if (oracle) {
      const baseline = measured.capture()
      const reference = oracle.capture()
      assert.equal(
        baseline.cursor,
        reference.cursor,
        "Dense and windowed setup cursors differ",
      )
      assert.equal(
        baseline.viewport,
        reference.viewport,
        "Dense and windowed setup anchors differ",
      )
      assert.equal(
        baseline.cells,
        reference.cells,
        "Dense and windowed setup paints differ",
      )
    }
    const results: Awaited<ReturnType<typeof observeAction>>[] = []
    const runAction = async (action: Action) => {
      if (oracle) await observeAction(oracle, action, semanticOrder)
      // Oracle's full painted viewport and semantic state are captured after its
      // action. Its timing is discarded; only measured windowed timing is reported.
      const reference = oracle?.capture()
      results.push(
        await observeAction(measured!, action, semanticOrder, reference),
      )
    }
    const up: Action["dispatch"] = (h, recordKey) => {
      h.setup.mockInput.pressKey("u", { ctrl: true })
      recordKey("Ctrl-U")
    }
    const down: Action["dispatch"] = (h) =>
      h.setup.mockInput.pressKey("d", { ctrl: true })
    const brace =
      (value: "{" | "}"): Action["dispatch"] =>
      (h) =>
        h.setup.mockInput.typeText(value)
    const queuedUp: Action = {
      name: `queued-paced-up-${repeats}`,
      group: "queued-paced-up",
      dispatch: async (h, recordKey) => {
        const sequenceStarted = performance.now()
        for (let index = 0; index < repeats; index++) {
          const due = sequenceStarted + index * intervalMs
          const remaining = due - performance.now()
          if (remaining > 0) await Bun.sleep(remaining)
          up(h, () => recordKey("Ctrl-U", due))
        }
      },
    }
    const burstUp: Action = {
      name: "burst-up-8",
      group: "synchronous-burst",
      dispatch: (h, recordKey) => {
        for (let i = 0; i < 8; i++) up(h, recordKey)
      },
    }
    const returnToTail: Action = {
      name: "return-to-tail",
      group: "return",
      dispatch: (h, recordKey) => {
        h.setup.mockInput.typeText("G")
        recordKey("G")
      },
    }
    const settledDispatchStarts: number[] = []
    if (capacity) {
      for (const name of capacityActions)
        await runAction(
          name === "cold-up"
            ? { name: "cold-up", group: "cold", dispatch: up }
            : name === "queued-paced-up"
              ? queuedUp
              : name === "burst-up-8"
                ? burstUp
                : returnToTail,
        )
    } else {
      await runAction({ name: "cold-up", group: "cold", dispatch: up })
      for (let index = 0; index < repeats; index++) {
        const due = settledDispatchStarts.length
          ? settledDispatchStarts[0]! + index * intervalMs
          : performance.now()
        if (performance.now() < due) await Bun.sleep(due - performance.now())
        settledDispatchStarts.push(performance.now())
        await runAction({
          name: `paced-up-${index}`,
          group: "paced-up",
          dispatch: up,
        })
      }
      await runAction(burstUp)
      await runAction({
        ...returnToTail,
        name: "reset-before-queued",
        group: "setup",
      })
      await runAction(queuedUp)
      for (let index = 0; index < 3; index++)
        await runAction({
          name: `reverse-down-${index}`,
          group: "reverse-down",
          dispatch: down,
        })
      for (let index = 0; index < repeats; index++)
        await runAction({
          name: `brace-previous-${index}`,
          group: "brace-previous",
          dispatch: brace("{"),
        })
      for (let index = 0; index < 3; index++)
        await runAction({
          name: `brace-next-${index}`,
          group: "brace-next",
          dispatch: brace("}"),
        })
      // This setup action moves to a known foldable landmark. The measured fold
      // actions themselves enter through the user's zc/zo keybindings.
      const target = fixture.landmarks.folded
      if (target) {
        for (const h of [oracle, measured].filter((value): value is Harness =>
          Boolean(value),
        )) {
          await act(async () =>
            h.controller.transcript({
              type: "cursor.move",
              target: { itemId: target, graphemeOffset: 0 },
              preferredScreenRow: 0,
              extend: false,
            }),
          )
          await h.settle()
        }
        await runAction({
          name: "cold-fold-open",
          group: "expand",
          dispatch: (h) => h.setup.mockInput.typeText("zo"),
        })
        await runAction({
          name: "fold-close",
          group: "fold",
          dispatch: (h) => h.setup.mockInput.typeText("zc"),
        })
        await runAction({
          name: "warm-fold-open",
          group: "expand",
          dispatch: (h) => h.setup.mockInput.typeText("zo"),
        })
      }
      // Running-tail delta while detached. It exercises hidden accumulation and
      // checks that a reader's viewport stays pinned during publication.
      if (
        fixture.before.conversation.items[fixture.tailItemId]?.status ===
        "running"
      ) {
        await runAction({
          name: "detached-stream",
          group: "stream",
          dispatch: async (h) => {
            h.emit({
              type: "conversation",
              event: {
                type: "item.delta",
                threadId: fixture.threadId,
                itemId: fixture.tailItemId,
                delta: "\n\nBenchmark detached tail delta.",
              },
            })
            await h.controller.settle()
          },
        })
        await runAction({
          name: "return-to-tail",
          group: "return",
          dispatch: (h) => h.setup.mockInput.typeText("G"),
        })
      }
      if (boundaryUpSteps > 0) {
        await runAction({
          name: "boundary-reset-to-tail",
          group: "setup",
          dispatch: returnToTail.dispatch,
        })
        for (let index = 0; index < boundaryUpSteps; index++)
          await runAction({
            name: `boundary-up-${index}`,
            group: "boundary-up",
            dispatch: up,
          })
      }
    }
    assert(
      results.some((result) => result.after.top !== result.before.top),
      "Navigation workload never moved the native viewport",
    )
    const groups = [...new Set(results.map((result) => result.group))].map(
      (name) => {
        const samples = results.filter((result) => result.group === name)
        return {
          name,
          actions: samples.length,
          firstDenseMatchPaintMs: percentile(
            samples.flatMap((sample) =>
              sample.firstDenseMatchPaintMs === null
                ? []
                : [sample.firstDenseMatchPaintMs],
            ),
          ),
          firstFinalPaintMs: percentile(
            samples.flatMap((sample) =>
              sample.firstFinalPaintMs === null
                ? []
                : [sample.firstFinalPaintMs],
            ),
          ),
          finalSettlementMs: percentile(
            samples.map((sample) => sample.finalSettlementMs),
          ),
          nonDestinationFrames: samples.reduce(
            (sum, sample) => sum + sample.nonDestinationFrames,
            0,
          ),
          blankFrames: samples.reduce(
            (sum, sample) => sum + sample.blankFrames,
            0,
          ),
        }
      },
    )
    const memoryAfterWorkload = process.memoryUsage()
    const retainedPaintCellBytes = results.reduce(
      (total, action) =>
        total +
        action.paintFrames.reduce(
          (paintTotal, frame) => paintTotal + frame.cells.length * 2,
          0,
        ),
      0,
    )
    if (capacity) Bun.gc(true)
    const memoryAfterGc = capacity ? process.memoryUsage() : null
    console.log(
      JSON.stringify({
        benchmark: "connected-transcript-navigation",
        workload,
        status: results.some(
          (result) => result.blankFrames > 0 || !result.semanticMonotonic,
        )
          ? "failed"
          : "diagnostic",
        failureReason: results.some((result) => result.blankFrames > 0)
          ? "blank-painted-frame"
          : results.some((result) => !result.semanticMonotonic)
            ? "semantic-direction-reversal"
            : null,
        denseDisagreements: results
          .filter(
            (result) =>
              result.denseMatch &&
              Object.values(result.denseMatch).some((match) => !match),
          )
          .map((result) => ({ name: result.name, match: result.denseMatch })),
        denseComparisonQualification:
          "Fully mounted render is a diagnostic control, not an independent correctness oracle. A dense/windowed disagreement requires semantic and placement adjudication.",
        boundary: "workbench-connected-react-opentui-input",
        machine: {
          platform: process.platform,
          arch: process.arch,
          cpus: os.cpus().length,
          bun: Bun.version,
          opentui: opentuiVersion,
        },
        renderer: "headless OpenTUI testRender; simulated key dispatch",
        frameClassification:
          "nonDestinationFrames includes coherent prior paints as well as intermediate paints; no claim that every such frame is visually broken",
        fixture: {
          version: fixture.fixtureVersion,
          shape: fixture.shape,
          canonicalItems: fixture.requestedBlockCount,
          transcriptItems: fixture.transcriptItemCount,
          actualRenderBlocks: fixture.blockCount,
          connectedRenderBlocks,
          hash: fixture.contentHash,
          denseOracle,
          renderBlockTarget,
        },
        startup: {
          fixtureBuildMs,
          connectedStartupMs,
          mountedRootsAfterSetup: connectedSetup.roots,
          materializedBlocksAfterSetup: connectedSetup.materializedBlocks,
          memoryBytes: {
            beforeFixture: memoryStart,
            afterFixture: memoryAfterFixture,
            afterConnectedHarness: memoryAfterHarness,
            afterWorkload: memoryAfterWorkload,
            afterGc: memoryAfterGc,
          },
          retainedPaintCellBytes,
        },
        viewport: { width, height },
        windowPolicy: {
          overscanRows: overscanRows ?? "viewport-default",
          recentTailBlocks:
            recentTailBlocks ?? defaultTranscriptWindowPolicy.recentTailBlocks,
          recentTailRows:
            recentTailRows ?? defaultTranscriptWindowPolicy.recentTailRows,
          olderLookAheadRows:
            olderLookAheadRows ??
            defaultTranscriptWindowPolicy.olderLookAheadRows,
          overrideIsBenchmarkOnly:
            overscanRows !== null ||
            recentTailBlocks !== null ||
            recentTailRows !== null ||
            olderLookAheadRows !== null,
        },
        repeat: {
          requestedIntervalMs: intervalMs,
          pacing:
            "paced-up settles each key; queued-paced-up dispatches at the requested cadence without intermediate settle or explicit render; compare actual intervals and paint keysDispatched",
          settledActualDispatchIntervalsMs: settledDispatchStarts
            .slice(1)
            .map((at, i) => round(at - settledDispatchStarts[i]!)),
          burst: "8 synchronous key events in one React act",
          capacityActions: capacity ? capacityActions : null,
          boundaryUpSteps: capacity ? null : boundaryUpSteps,
        },
        groups,
        actions: results,
      }),
    )
    if (
      results.some(
        (result) => result.blankFrames > 0 || !result.semanticMonotonic,
      )
    )
      process.exitCode = 1
  } finally {
    if (oracle) await oracle.close()
    if (measured) await measured.close()
  }
}

await run()
