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
import { flushSync } from "@opentui/react"
import { ConnectedVimexRoot } from "../packages/ui-opentui-react/src"
import {
  navigationDetailExperimentEnabled,
  navigationDetailGate,
} from "../packages/ui-opentui-react/src/transcript/experiments/navigation-detail"
import {
  navigationMeasurementBudget,
  navigationMeasurementBudgetEnabled,
} from "../packages/ui-opentui-react/src/transcript/experiments/navigation-measurement-budget"
import { subscribeNavigationTrace } from "../packages/ui-opentui-react/src/transcript/navigation/trace"
import {
  getPreparedRuntimeGeometryDiagnostics,
  transcriptBlockRenderableId,
} from "../packages/ui-opentui-react/src/transcript/native-layout/rendered-layout"

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
  windowKeys: string
  pendingMeasurements: number
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
  ["full", "held", "capacity"].includes(workload),
  "VIMEX_NAV_WORKLOAD must be full, held, or capacity",
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
const reversal = process.env.VIMEX_NAV_REVERSAL === "1"
const repeats = envInt("VIMEX_NAV_REPEATS", 6)
const warmRepeats = envInt("VIMEX_NAV_WARM_REPEATS", repeats)
const traceNavigation = process.env.VIMEX_NAV_TRACE === "1"
const traceLimit = envInt("VIMEX_NAV_TRACE_LIMIT", 50_000)
const traceFromKey = envInt("VIMEX_NAV_TRACE_FROM_KEY", 0, 0)
const traceToKey = envInt("VIMEX_NAV_TRACE_TO_KEY", Number.MAX_SAFE_INTEGER, 0)
assert(traceToKey >= traceFromKey, "Navigation trace key range is reversed")
const traceCells = process.env.VIMEX_NAV_TRACE_CELLS !== "0"
const traceFromSequence =
  process.env.VIMEX_NAV_TRACE_FROM_SEQUENCE === undefined
    ? null
    : envInt("VIMEX_NAV_TRACE_FROM_SEQUENCE", 0, 0)
const traceToSequence =
  process.env.VIMEX_NAV_TRACE_TO_SEQUENCE === undefined
    ? Number.MAX_SAFE_INTEGER
    : envInt("VIMEX_NAV_TRACE_TO_SEQUENCE", Number.MAX_SAFE_INTEGER, 0)
assert(
  traceFromSequence === null || traceToSequence >= traceFromSequence,
  "Navigation trace sequence range is reversed",
)
const intervalMs = envInt("VIMEX_NAV_REPEAT_INTERVAL_MS", 33)
const independentSender = process.env.VIMEX_NAV_INDEPENDENT_SENDER === "1"
const kittyHeldInput = process.env.VIMEX_NAV_KITTY_HELD_INPUT === "1"
assert(
  !kittyHeldInput || independentSender,
  "Kitty held input requires independent sender",
)
const landingKeys = (
  process.env.VIMEX_NAV_LANDING_KEYS ??
  process.env.VIMEX_NAV_LANDING_KEY ??
  ""
)
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean)
const landingKey = landingKeys[0]
const landingIntervalMs = envInt("VIMEX_NAV_LANDING_INTERVAL_MS", 33)
assert(landingKeys.length <= 32, "At most 32 landing probes are supported")
const landingFocus = process.env.VIMEX_NAV_LANDING_FOCUS ?? "transcript"
const landingDelayMs = envInt("VIMEX_NAV_LANDING_DELAY_MS", 0, 0)
const unfoldAll = process.env.VIMEX_NAV_UNFOLD_ALL === "1"
const initialViewportIndex =
  process.env.VIMEX_NAV_INITIAL_VIEWPORT_INDEX === undefined
    ? undefined
    : envInt("VIMEX_NAV_INITIAL_VIEWPORT_INDEX", 0, 0)
const landingTargetIndex =
  process.env.VIMEX_NAV_LANDING_TARGET_INDEX === undefined
    ? undefined
    : envInt("VIMEX_NAV_LANDING_TARGET_INDEX", 0, 0)
assert(
  landingTargetIndex === undefined || Boolean(landingKey),
  "Landing target requires landing probes",
)
assert(
  ["transcript", "composer"].includes(landingFocus),
  "Invalid landing focus",
)
assert(
  landingKeys.every((key) =>
    ["u", "d", "y", "e", "wheel-up", "wheel-down"].includes(key),
  ),
  "Invalid landing key",
)
assert(
  !landingKey || (independentSender && kittyHeldInput && workload === "held"),
  "Landing probe requires held workload and independent Kitty sender",
)
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
const denseOracle = !capacity && !landingKey && canonicalItems <= 160
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
  const initialItemId =
    initialViewportIndex === undefined
      ? fixture.tailItemId
      : fixture.before.transcript.order[initialViewportIndex]
  assert(initialItemId, "Initial viewport index is outside transcript order")
  const initialPoint = { itemId: initialItemId, graphemeOffset: 0 }
  const seeded: ThreadWorkspace = Object.freeze({
    ...workspace,
    canonicalGeneration: 0,
    canonicalRevision: fixture.before.canonicalRevision,
    conversation: fixture.before.conversation,
    transcript: Object.freeze({
      ...fixture.before.transcript,
      selection: undefined,
      cursor:
        initialViewportIndex === undefined
          ? fixture.before.transcript.cursor
          : initialPoint,
      viewport: Object.freeze(
        initialViewportIndex === undefined
          ? { kind: "tail" as const }
          : {
              kind: "point" as const,
              point: initialPoint,
              preferredScreenRow: 0,
            },
      ),
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
    connected.setWindowViewport = (viewportRows, _, blocks, retained) =>
      configure(viewportRows, overscanRows, blocks, retained)
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
  const setup = await testRender(<Root />, { width, height, targetFps: 60 })
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
      windowKeys: frame.window.blocks.map(blockKey).join("\n"),
      pendingMeasurements: navigationMeasurementBudget(setup.renderer)
        .diagnostics.pending,
      ...counts,
      cursorPoint,
      cursorItemBlocks,
    }
  }
  async function settle() {
    let unchanged = 0
    let last = ""
    for (let pass = 0; pass < 400 && unchanged < 3; pass++) {
      await act(async () => {
        await setup.flush({ maxPasses: 400 })
        await setup.renderOnce()
      })
      const frame = runtime.getSnapshot()
      const signature = `${frame.presentationRevision}:${scroll.scrollTop}:${frame.window.blocks.length}:${frame.geometry.revision}`
      unchanged =
        signature === last &&
        navigationMeasurementBudget(setup.renderer).diagnostics.pending === 0
          ? unchanged + 1
          : 0
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
  if (unfoldAll)
    await act(async () => {
      controller.transcript({ type: "fold.all", folded: false })
    })
  await settle()
  // Input is measured with normal-mode transcript focus, as a reader would use it.
  await act(async () => {
    controller.dispatchInteraction({ type: "mode.normal" })
    controller.dispatchInteraction({
      type: "focus.set",
      surface:
        landingKey && landingFocus === "composer" ? "composer" : "transcript",
    })
    controller.transcript({
      type: "cursor.move",
      target: initialPoint,
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

type NeighborhoodSnapshot = {
  focus: string
  cursor: string
  viewport: string
  nativeTop: number
  measuredWindowBlocks: number
  roots: { key: string; identity: number }[]
}

type LandingSample = {
  key: string
  sentAtMs: number
  acceptedAtMs: number
  returnedAtMs: number
  cursorBefore: string
  viewportBefore: string
  neighborhood: NeighborhoodSnapshot
  paintBefore: string
}

type SenderReport = {
  clockUncertaintyMs: number
  stoppedAtMs: number
  releaseAcceptedAtMs?: number
  landing?: LandingSample
  landings: LandingSample[]
  stoppedNeighborhood?: NeighborhoodSnapshot
  landingTarget?: {
    itemIndex: number
    itemId: string
    targetWasMounted: boolean
    measuredTargetBlocksBefore: number
    heldViewportBefore: string
    acceptedAtMs: number
    returnedAtMs: number
  }
  events: { key: string; sentAtMs: number; acceptedAtMs: number }[]
}

// Independent pacing exposes input accumulated while the application event loop
// is busy. This is a pipe feeding mock input, not a PTY or emulator acceptance test.
async function dispatchIndependent(
  h: Harness,
  recordKey: (key: string, dueAt?: number) => void,
  keys: string[],
): Promise<SenderReport> {
  const child = Bun.spawn(
    [
      "python3",
      "-u",
      "-c",
      `
import json, sys, time
def emit(value):
    print(json.dumps(value), flush=True)
emit({"kind":"ready"})
sys.stdin.readline()
emit({"kind":"sync", "at":time.monotonic()*1000})
config=json.loads(sys.stdin.readline())
start=time.monotonic()
for index,key in enumerate(config["keys"]):
    due=start+(index+1)*config["intervalMs"]/1000
    time.sleep(max(0,due-time.monotonic()))
    emit({"kind":"key", "key":key, "at":time.monotonic()*1000})
emit({"kind":"stop", "at":time.monotonic()*1000})
landing_start=time.monotonic()+config["landingDelayMs"]/1000
for index,key in enumerate(config["landingKeys"]):
    due=landing_start+index*config["landingIntervalMs"]/1000
    time.sleep(max(0,due-time.monotonic()))
    emit({"kind":"landing", "key":key, "at":time.monotonic()*1000})
emit({"kind":"done"})
`,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  const next = async (): Promise<{ kind: string; at: number; key: string }> => {
    while (!buffered.includes("\n")) {
      const chunk = await reader.read()
      assert(!chunk.done, "Independent sender exited before its stop marker")
      buffered += decoder.decode(chunk.value, { stream: true })
    }
    const end = buffered.indexOf("\n")
    const value = JSON.parse(buffered.slice(0, end))
    buffered = buffered.slice(end + 1)
    return value
  }
  try {
    assert.equal((await next()).kind, "ready")
    const beforeSync = performance.now()
    child.stdin.write("sync\n")
    await child.stdin.flush()
    const sync = await next()
    const afterSync = performance.now()
    assert.equal(sync.kind, "sync")
    // The child's sync sample is bracketed by the parent's request and reply.
    // Midpoint mapping carries an explicit half-round-trip uncertainty.
    const offset = (beforeSync + afterSync) / 2 - sync.at
    child.stdin.write(
      JSON.stringify({
        keys,
        intervalMs,
        landingKeys,
        landingDelayMs,
        landingIntervalMs,
      }) + "\n",
    )
    await child.stdin.flush()
    const events: SenderReport["events"] = []
    let stoppedAtMs = 0
    const landings: LandingSample[] = []
    let stoppedNeighborhood: NeighborhoodSnapshot | undefined
    let landingTarget: SenderReport["landingTarget"]
    const rootIdentities = new WeakMap<object, number>()
    let nextRootIdentity = 1
    const neighborhood = (): NeighborhoodSnapshot => {
      const frame = h.runtime.getSnapshot()
      return {
        focus: h.workspaceSnapshot().interaction.surface,
        cursor: JSON.stringify(frame.transcript.cursor),
        viewport: JSON.stringify(frame.transcript.viewport),
        nativeTop: h.scroll.scrollTop,
        measuredWindowBlocks: frame.window.blocks.filter((block) =>
          Boolean(frame.geometry.byBlockKey[blockKey(block)]),
        ).length,
        roots: frame.window.blocks.flatMap((block) => {
          const key = blockKey(block)
          const root = h.scroll.getRenderable(
            transcriptBlockRenderableId(block),
          )
          if (!root) return []
          let identity = rootIdentities.get(root)
          if (identity === undefined) {
            identity = nextRootIdentity++
            rootIdentities.set(root, identity)
          }
          return [{ key, identity }]
        }),
      }
    }
    let previousKey: string | undefined
    let releaseAcceptedAtMs: number | undefined
    const sendKitty = (key: string, eventType: 1 | 2 | 3) => {
      const code = key === "Ctrl-U" ? 117 : 100
      h.setup.renderer.stdin.emit(
        "data",
        Buffer.from(`\x1b[${code};5:${eventType}u`),
      )
    }
    while (true) {
      const event = await next()
      if (event.kind === "done") break
      if (event.kind === "stop") {
        stoppedAtMs = event.at + offset
        if (landingTargetIndex !== undefined) {
          const frame = h.runtime.getSnapshot()
          const itemId = frame.transcript.order[landingTargetIndex]
          assert(itemId, "Landing target index is outside transcript order")
          const targetBlocks = frame.blocks.filter(
            (block) => block.key.kind === "item" && block.key.itemId === itemId,
          )
          const targetWasMounted = frame.window.blocks.some(
            (block) => block.key.kind === "item" && block.key.itemId === itemId,
          )
          const measuredTargetBlocksBefore = targetBlocks.filter((block) =>
            Boolean(frame.geometry.byBlockKey[blockKey(block)]),
          ).length
          const acceptedAtMs = performance.now()
          // Diagnostic direct destination: this route deliberately skips relative
          // traversal to a matching logical interior anchor. No settling occurs.
          flushSync(() =>
            h.controller.transcript({
              type: "jump",
              target: { itemId, graphemeOffset: 0 },
              preferredScreenRow: 0,
              preserveFolds: true,
            }),
          )
          landingTarget = {
            itemIndex: landingTargetIndex,
            itemId,
            targetWasMounted,
            measuredTargetBlocksBefore,
            heldViewportBefore: JSON.stringify(frame.transcript.viewport),
            acceptedAtMs,
            returnedAtMs: performance.now(),
          }
        }
        if (kittyHeldInput && previousKey) {
          releaseAcceptedAtMs = performance.now()
          sendKitty(previousKey, 3)
        }
        if (landingKey) stoppedNeighborhood = neighborhood()
        continue
      }
      if (event.kind === "landing") {
        const before = h.runtime.getSnapshot().transcript
        const beforeNeighborhood = neighborhood()
        const paintBefore = h.setup
          .captureCharFrame()
          .split("\n")
          .slice(
            h.scroll.viewport.y,
            h.scroll.viewport.y + h.scroll.viewport.height,
          )
          .join("\n")
        const acceptedAtMs = performance.now()
        if (event.key.startsWith("wheel-")) {
          await h.setup.mockMouse.scroll(
            h.scroll.viewport.screenX + Math.floor(h.scroll.viewport.width / 2),
            h.scroll.viewport.screenY +
              Math.floor(h.scroll.viewport.height / 2),
            event.key === "wheel-up" ? "up" : "down",
          )
        } else {
          h.setup.renderer.stdin.emit(
            "data",
            Buffer.from(`\x1b[${event.key.charCodeAt(0)};5:1u`),
          )
          h.setup.renderer.stdin.emit(
            "data",
            Buffer.from(`\x1b[${event.key.charCodeAt(0)};5:3u`),
          )
        }
        landings.push({
          key: event.key,
          sentAtMs: event.at + offset,
          acceptedAtMs,
          returnedAtMs: performance.now(),
          cursorBefore: JSON.stringify(before.cursor),
          viewportBefore: JSON.stringify(before.viewport),
          neighborhood: beforeNeighborhood,
          paintBefore,
        })
        recordKey(`landing-${event.key}`, event.at + offset)
        continue
      }
      assert.equal(event.kind, "key")
      const acceptedAtMs = performance.now()
      if (kittyHeldInput) {
        if (previousKey && previousKey !== event.key) sendKitty(previousKey, 3)
        sendKitty(event.key, previousKey === event.key ? 2 : 1)
      } else {
        h.setup.mockInput.pressKey(event.key === "Ctrl-U" ? "u" : "d", {
          ctrl: true,
        })
      }
      previousKey = event.key
      recordKey(event.key, event.at + offset)
      events.push({ key: event.key, sentAtMs: event.at + offset, acceptedAtMs })
    }
    assert.equal(await child.exited, 0, await new Response(child.stderr).text())
    return {
      clockUncertaintyMs: (afterSync - beforeSync) / 2,
      stoppedAtMs,
      releaseAcceptedAtMs,
      landing: landings[0],
      landings,
      stoppedNeighborhood,
      landingTarget,
      events,
    }
  } finally {
    reader.releaseLock()
    child.stdin.end()
    if (child.exitCode === null) child.kill()
  }
}

type Action = {
  name: string
  group: string
  dispatch: (
    h: Harness,
    recordKey: (key: string, dueAt?: number) => void,
  ) => void | Promise<void | SenderReport>
}

async function observeAction(
  h: Harness,
  action: Action,
  order: ReadonlyMap<string, number>,
  expected?: Captured,
) {
  const before = h.capture()
  const preparedBefore = getPreparedRuntimeGeometryDiagnostics(h.scroll)
  const traceEnabled =
    traceNavigation &&
    ["queued-reversal", "queued-paced-up"].includes(action.group)
  const navigationTrace: Record<string, unknown>[] = []
  let dispatchedKeys = 0
  let droppedTraceRecords = 0
  let filteredTraceRecords = 0
  const keysBySequence = new Map<number, number>()
  let activeTraceSequence: number | undefined
  let activeTraceKey: number | undefined
  const appendTrace = (event: Record<string, unknown>) => {
    // Retain explicit resolved-intent records across the whole route even when
    // detailed event/paint context is restricted to a dispatch-key window.
    const details = event.details as { sequence?: number } | undefined
    const sequence = details?.sequence ?? activeTraceSequence
    const withinRange =
      traceFromSequence !== null
        ? sequence !== undefined &&
          sequence >= traceFromSequence &&
          sequence <= traceToSequence
        : (dispatchedKeys >= traceFromKey && dispatchedKeys <= traceToKey) ||
          (activeTraceKey !== undefined &&
            activeTraceKey >= traceFromKey &&
            activeTraceKey <= traceToKey)
    if (event.kind !== "intent.resolved" && !withinRange) {
      filteredTraceRecords++
      return
    }
    if (navigationTrace.length < traceLimit)
      navigationTrace.push({
        ...event,
        activeIntentSequence: activeTraceSequence,
        activeIntentKey: activeTraceKey,
      })
    else droppedTraceRecords++
  }
  const traceState = () => {
    const frame = h.runtime.getSnapshot()
    const transcript = h.workspaceSnapshot().transcript
    return {
      frameId: h.setup.renderer.frameId,
      geometryRevision: frame.geometry.revision,
      presentationRevision: frame.presentationRevision,
      topSpacerRows: frame.window.topSpacerRows,
      bottomSpacerRows: frame.window.bottomSpacerRows,
      scrollTop: h.scroll.scrollTop,
      cursor: transcript.cursor,
      viewport: transcript.viewport,
    }
  }
  const trace = (kind: string, data: Record<string, unknown> = {}) => {
    if (traceEnabled)
      appendTrace({
        atMs: performance.now(),
        kind,
        dispatchedKeys,
        ...traceState(),
        ...data,
      })
  }
  const unsubscribeTrace = traceEnabled
    ? subscribeNavigationTrace(h.setup.renderer, (event) => {
        const details = event.details as {
          sequence?: number
          intent?: { sequence?: number }
        }
        if (event.kind === "intent.enqueued" && details.sequence !== undefined)
          keysBySequence.set(details.sequence, dispatchedKeys)
        if (event.kind === "row.begin") {
          activeTraceSequence = details.intent?.sequence
          activeTraceKey =
            activeTraceSequence === undefined
              ? undefined
              : keysBySequence.get(activeTraceSequence)
        }
        appendTrace({ ...event, dispatchedKeys })
      })
    : () => {}

  const detailBefore = { ...navigationDetailGate(h.setup.renderer).diagnostics }
  const measurementBefore = {
    ...navigationMeasurementBudget(h.setup.renderer).diagnostics,
  }
  const frames: Captured[] = []
  const stageSamples: {
    operation: string
    atMs: number
    durationMs: number
  }[] = []
  const originalEmit = h.setup.renderer.emit
  const root = h.setup.renderer.root
  const originalLayout = root.calculateLayout
  const originalUpdateLayout = root.updateLayout
  let nativeLayoutPasses = 0
  let nativeLayoutMs = 0
  root.calculateLayout = function (...args) {
    const began = performance.now()
    try {
      return originalLayout.apply(this, args)
    } finally {
      nativeLayoutPasses++
      nativeLayoutMs += performance.now() - began
      recordStage("native.calculateLayout", began)
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
  if (profileStages)
    root.updateLayout = function (...args) {
      const began = performance.now()
      try {
        return originalUpdateLayout.apply(this, args)
      } finally {
        recordStage("native.updateLayout", began)
      }
    }
  h.setup.renderer.emit = function (
    event: string | symbol,
    ...args: unknown[]
  ) {
    // A FRAME listener may correct geometry only AFTER these cells were painted.
    if (event === "frame") {
      const began = performance.now()
      frames.push(h.capture())
      trace("paint", {
        ...(traceCells ? { cells: frames.at(-1)!.cells } : {}),
        cursorPoint: frames.at(-1)!.cursorPoint,
      })
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
  const semanticChanges: { atMs: number; cursor: string; viewport: string }[] =
    []
  let previousSemantic = { cursor: before.cursor, viewport: before.viewport }
  const unsubscribeRuntime = h.runtime.subscribe(() => {
    runtimePublications++
    if (!independentSender) return
    const transcript = h.runtime.getSnapshot().transcript
    const current = {
      cursor: JSON.stringify(transcript.cursor),
      viewport: JSON.stringify(transcript.viewport),
    }
    if (
      current.cursor !== previousSemantic.cursor ||
      current.viewport !== previousSemantic.viewport
    )
      semanticChanges.push({ atMs: performance.now(), ...current })
    previousSemantic = current
  })
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
  const originalPressKey = h.setup.mockInput.pressKey
  const traceScrollTo = h.scroll.scrollTo
  const traceScrollBy = h.scroll.scrollBy
  if (traceEnabled) {
    h.setup.mockInput.pressKey = function (...args) {
      dispatchedKeys++
      trace("key.begin", { args })
      try {
        return originalPressKey.apply(this, args)
      } finally {
        trace("key.returned", { args })
      }
    }
    h.scroll.scrollTo = function (...args) {
      trace("native.scrollTo.begin", { args })
      try {
        return traceScrollTo.apply(this, args)
      } finally {
        trace("native.scrollTo.end", { args })
      }
    }
    h.scroll.scrollBy = function (...args) {
      trace("native.scrollBy.begin", { args })
      try {
        return traceScrollBy.apply(this, args)
      } finally {
        trace("native.scrollBy.end", { args })
      }
    }
  }
  trace("action.begin")
  let dispatchedAt = started
  const senderResult: { report?: SenderReport } = {}
  let detailReleasedAt: number | null = null
  try {
    await act(async () => {
      senderResult.report = (await action.dispatch(h, recordKey)) || undefined
      dispatchedAt = performance.now()
      await h.setup.flush({ maxPasses: 400 })
      await h.setup.renderOnce()
    })
    const detailWasDeferred = navigationDetailGate(h.setup.renderer).active
    await act(async () => navigationDetailGate(h.setup.renderer).whenIdle())
    if (detailWasDeferred) detailReleasedAt = performance.now()
    await h.settle()
  } finally {
    trace("action.end")
    unsubscribeTrace()
    h.setup.mockInput.pressKey = originalPressKey
    h.scroll.scrollTo = traceScrollTo
    h.scroll.scrollBy = traceScrollBy
    h.setup.renderer.emit = originalEmit
    root.calculateLayout = originalLayout
    root.updateLayout = originalUpdateLayout
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
  const semanticDirection = landingKey
    ? null
    : ["cold", "paced-up", "queued-paced-up", "synchronous-burst"].includes(
          action.group,
        )
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
  const changedFrames = frames.filter(
    (frame, index) =>
      frame.cells !== (index === 0 ? before.cells : frames[index - 1]!.cells),
  )
  const movementFrames = frames.filter((frame, index) => {
    const previous = index === 0 ? before : frames[index - 1]!
    return frame.top !== previous.top || frame.cursor !== previous.cursor
  })
  const movementPaintGapsMs = movementFrames
    .slice(1)
    .map((frame, index) => round(frame.atMs - movementFrames[index]!.atMs))
  const changedPaintGapsMs = changedFrames
    .slice(1)
    .map((frame, index) => round(frame.atMs - changedFrames[index]!.atMs))
  // A subsequent changed paint is an opportunity for visible feedback, not
  // proof that this individual key's exact destination has been presented.
  const keyToNextChangedPaintMs = keyDispatches.map((key) => {
    const paint = changedFrames.find(
      (frame) => frame.atMs >= started + key.atMs,
    )
    return paint ? round(paint.atMs - started - key.atMs) : null
  })
  const lastKeyAtMs = keyDispatches.at(-1)?.atMs
  const semanticMovementFrames = frames.filter((frame, index) => {
    const previous = index === 0 ? before : frames[index - 1]!
    return (
      frame.cursor !== previous.cursor || frame.viewport !== previous.viewport
    )
  })
  const senderReport = senderResult.report
  const stopAt = senderReport?.stoppedAtMs
  const postStopSemanticChanges =
    stopAt === undefined
      ? []
      : semanticChanges.filter(
          (event) => event.atMs > stopAt + senderReport!.clockUncertaintyMs,
        )
  const postStopMovements =
    stopAt === undefined
      ? []
      : semanticMovementFrames.filter(
          (frame) => frame.atMs > stopAt + senderReport!.clockUncertaintyMs,
        )
  const finalPaintAfterLastKey =
    lastKeyAtMs === undefined
      ? undefined
      : frames.find(
          (frame) =>
            frame.atMs >= started + lastKeyAtMs &&
            sameDestination(frame, final),
        )

  const reportLanding = (probe: LandingSample, index: number) => {
    const nextInputAt =
      senderReport?.landings[index + 1]?.acceptedAtMs ?? Infinity
    const semantic = semanticChanges.find(
      (event) =>
        event.atMs >= probe.acceptedAtMs &&
        event.atMs < nextInputAt &&
        (event.cursor !== probe.cursorBefore ||
          event.viewport !== probe.viewportBefore),
    )
    const paint = semanticMovementFrames.find(
      (frame) =>
        frame.atMs >= probe.acceptedAtMs &&
        frame.atMs < nextInputAt &&
        (frame.cursor !== probe.cursorBefore ||
          frame.viewport !== probe.viewportBefore),
    )
    const enqueue = navigationTrace.find(
      (event) =>
        event.kind === "intent.enqueued" &&
        Number(event.atMs) >= probe.acceptedAtMs &&
        Number(event.atMs) <= probe.returnedAtMs,
    )
    const sequence = (enqueue?.details as { sequence?: number } | undefined)
      ?.sequence
    const resolved =
      !probe.key.startsWith("wheel-") && sequence !== undefined
        ? navigationTrace.find(
            (event) =>
              event.kind === "intent.resolved" &&
              (event.details as { sequence?: number } | undefined)?.sequence ===
                sequence,
          )
        : undefined
    return {
      key: probe.key,
      focus: landingFocus,
      actualFocus: probe.neighborhood.focus,
      index,
      requestedDelayMs: landingDelayMs + index * landingIntervalMs,
      neighborhood: probe.neighborhood,
      retainedRootsFromRelease: probe.neighborhood.roots.filter((root) =>
        senderReport?.stoppedNeighborhood?.roots.some(
          (prior) => prior.key === root.key && prior.identity === root.identity,
        ),
      ).length,
      sentAtMs: round(probe.sentAtMs - started),
      acceptedAtMs: round(probe.acceptedAtMs - started),
      deliveryDelayMs: round(probe.acceptedAtMs - probe.sentAtMs),
      afterReleaseAcceptedMs:
        senderReport?.releaseAcceptedAtMs === undefined
          ? null
          : round(probe.acceptedAtMs - senderReport.releaseAcceptedAtMs),
      synchronousDispatchMs: round(probe.returnedAtMs - probe.acceptedAtMs),
      firstSemanticChangeMs: semantic
        ? round(semantic.atMs - probe.acceptedAtMs)
        : null,
      firstSemanticPaintMs: paint
        ? round(paint.atMs - probe.acceptedAtMs)
        : null,
      acceptedSequence: sequence ?? null,
      paintBefore: probe.paintBefore,
      changedCellPaintsBeforeNextInput: frames.filter(
        (frame) =>
          frame.atMs >= probe.acceptedAtMs &&
          frame.atMs < nextInputAt &&
          frame.cells !== probe.paintBefore,
      ).length,
      resolvedPosition: resolved
        ? {
            cursor:
              (resolved.details as Record<string, unknown>).cursor ?? null,
            viewport:
              (resolved.details as Record<string, unknown>).viewport ?? null,
            nativeCursor:
              (resolved.details as Record<string, unknown>).nativeCursor ??
              null,
          }
        : null,
      acceptedQueue: enqueue?.details ?? null,
      resolvedMs: resolved
        ? round(Number(resolved.atMs) - probe.acceptedAtMs)
        : null,
      qualification:
        "Probe is sent by independent clock after hold stop, before settling. First semantic change/paint is feedback opportunity before the next probe and may include an active hold remainder; cell changes may include decoration. resolvedMs/resolvedPosition match the keyboard probe intent when tracing is enabled. Mouse lacks an independent exact intent acknowledgement. This is connected headless stdin/mouse input, not physical terminal acceptance.",
    }
  }
  const landingReports = senderReport?.landings.map(reportLanding) ?? []
  const landingFrames =
    stopAt === undefined ? [] : frames.filter((frame) => frame.atMs >= stopAt)
  const landingWindowTransitions = landingFrames.filter(
    (frame, index) =>
      index > 0 && frame.windowKeys !== landingFrames[index - 1]!.windowKeys,
  ).length

  return {
    name: action.name,
    preparedWork: {
      unfoldAll,
      before: preparedBefore ?? null,
      after: getPreparedRuntimeGeometryDiagnostics(h.scroll) ?? null,
    },
    landingProbe: landingReports[0] ?? null,
    landingProbes: landingReports,
    landingNeighborhood: senderReport?.stoppedNeighborhood
      ? {
          atRelease: senderReport.stoppedNeighborhood,
          route: senderReport.landingTarget
            ? "direct-interior-destination-after-hold"
            : "natural-held-arrival",
          target: senderReport.landingTarget
            ? {
                ...senderReport.landingTarget,
                acceptedAtMs: round(
                  senderReport.landingTarget.acceptedAtMs - started,
                ),
                returnedAtMs: round(
                  senderReport.landingTarget.returnedAtMs - started,
                ),
                returnedToPreJumpItem: (() => {
                  const held = JSON.parse(
                    senderReport.landingTarget.heldViewportBefore,
                  )
                  return (
                    held.kind === "point" &&
                    held.point.itemId !== senderReport.landingTarget.itemId &&
                    landingFrames.some((frame) => {
                      const viewport = JSON.parse(frame.viewport)
                      return (
                        viewport.kind === "point" &&
                        viewport.point.itemId === held.point.itemId
                      )
                    })
                  )
                })(),
                qualification:
                  "A direct jump followed immediately by manual input can cancel pending native restoration and return to the prior held location. If returnedToPreJumpItem is true, these are not cold target resolution measurements. Use INITIAL_VIEWPORT_INDEX for a settled interior start followed by natural held traversal.",
                placementDispatchMs: round(
                  senderReport.landingTarget.returnedAtMs -
                    senderReport.landingTarget.acceptedAtMs,
                ),
              }
            : null,
          maxMountedRootsAfterRelease: Math.max(
            0,
            ...landingFrames.map((frame) => frame.roots),
          ),
          maxMaterializedBlocksAfterRelease: Math.max(
            0,
            ...landingFrames.map((frame) => frame.materializedBlocks),
          ),
          windowTransitionsAfterRelease: landingWindowTransitions,
          retainedWindow: process.env.VIMEX_NAV_RETAINED_WINDOW !== "0",
          qualification:
            "Native root retention and cached geometry are not proof that offscreen Markdown has highlighted or painted. Compare atRelease viewport/cursor across runs before claiming matched-destination latency; coalesced holds may land differently.",
        }
      : null,
    independentSender: senderReport
      ? {
          qualification:
            "Independent Python process feeds a pipe into connected headless mock input; not PTY or physical terminal. Clock mapping uses a request/reply midpoint and reports uncertainty. semanticChanges records runtime cursor/viewport publications; semanticMovementFrames records painted cursor/viewport changes. Neither counts native scrollTop-only remount shifts. With a landing probe, post-stop changes include the intentional follow-up input; use landingProbe for its latency.",
          clockUncertaintyMs: round(senderReport.clockUncertaintyMs),
          stoppedAtMs: round(senderReport.stoppedAtMs - started),
          releaseAcceptedAtMs:
            senderReport.releaseAcceptedAtMs === undefined
              ? null
              : round(senderReport.releaseAcceptedAtMs - started),
          semanticChangesAfterStop: postStopSemanticChanges.map((event) => ({
            afterStopMs: round(event.atMs - senderReport.stoppedAtMs),
            cursor: event.cursor,
            viewport: event.viewport,
          })),
          lastSemanticChangeAfterStopMs: postStopSemanticChanges.length
            ? round(
                postStopSemanticChanges.at(-1)!.atMs - senderReport.stoppedAtMs,
              )
            : 0,
          events: senderReport.events.map((event) => ({
            key: event.key,
            sentAtMs: round(event.sentAtMs - started),
            acceptedAtMs: round(event.acceptedAtMs - started),
            deliveryDelayMs: round(event.acceptedAtMs - event.sentAtMs),
          })),
          semanticMovementFramesAfterStop: postStopMovements.length,
          lastSemanticMovementAfterStopMs: postStopMovements.length
            ? round(postStopMovements.at(-1)!.atMs - senderReport.stoppedAtMs)
            : 0,
          semanticMovementsAfterStop: postStopMovements.map((frame) => ({
            afterStopMs: round(frame.atMs - senderReport!.stoppedAtMs),
            cursor: frame.cursor,
            viewport: frame.viewport,
          })),
        }
      : null,
    droppedTraceRecords,
    filteredTraceRecords,
    navigationTrace: navigationTrace.map((event) => ({
      ...event,
      atMs: round(Number(event.atMs) - started),
    })),
    measurementWork: Object.fromEntries(
      Object.entries(
        navigationMeasurementBudget(h.setup.renderer).diagnostics,
      ).map(([key, value]) => [
        key,
        key === "pending"
          ? value
          : value - measurementBefore[key as keyof typeof measurementBefore],
      ]),
    ),
    peakPendingMeasurements: Math.max(
      before.pendingMeasurements,
      ...frames.map((frame) => frame.pendingMeasurements),
    ),
    detailRequests: Object.fromEntries(
      Object.entries(navigationDetailGate(h.setup.renderer).diagnostics).map(
        ([key, value]) => [
          key,
          value - detailBefore[key as keyof typeof detailBefore],
        ],
      ),
    ),
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
    mountedWindowTransitions: frames.filter(
      (frame, index) =>
        frame.windowKeys !==
        (index === 0 ? before.windowKeys : frames[index - 1]!.windowKeys),
    ).length,
    movementPaintGapsMs,
    movementPaintGapDistributionMs: percentile(movementPaintGapsMs),
    changedPaintGapsMs,
    changedPaintGapDistributionMs: percentile(changedPaintGapsMs),
    keyToNextChangedPaintMs,
    keyToNextChangedPaintDistributionMs: percentile(
      keyToNextChangedPaintMs.filter(
        (value): value is number => value !== null,
      ),
    ),
    lastKeyToDetailReleaseMs:
      lastKeyAtMs === undefined || detailReleasedAt === null
        ? null
        : round(detailReleasedAt - started - lastKeyAtMs),
    detailReleaseQualification:
      "Idle gate release permits highlighting; character captures do not certify color restoration completion.",
    lastKeyToFinalPaintMs:
      lastKeyAtMs === undefined || !finalPaintAfterLastKey
        ? null
        : round(finalPaintAfterLastKey.atMs - started - lastKeyAtMs),
    keyDispatches,
    actualKeyDispatchIntervalsMs: keyDispatches
      .slice(1)
      .map((key, index) => round(key.atMs - keyDispatches[index]!.atMs)),
    paintFrames: frames.map((frame, index) => ({
      mountedWindowChanged:
        frame.windowKeys !==
        (index === 0 ? before.windowKeys : frames[index - 1]!.windowKeys),
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
    const down: Action["dispatch"] = (h, recordKey) => {
      h.setup.mockInput.pressKey("d", { ctrl: true })
      recordKey("Ctrl-D")
    }
    const brace =
      (value: "{" | "}"): Action["dispatch"] =>
      (h) =>
        h.setup.mockInput.typeText(value)
    const queuedUp: Action = {
      name: `queued-paced-up-${repeats}`,
      group: "queued-paced-up",
      dispatch: async (h, recordKey) => {
        if (independentSender)
          return dispatchIndependent(
            h,
            recordKey,
            Array(repeats).fill("Ctrl-U"),
          )
        const sequenceStarted = performance.now()
        for (let index = 0; index < repeats; index++) {
          const due = sequenceStarted + index * intervalMs
          const remaining = due - performance.now()
          if (remaining > 0) await Bun.sleep(remaining)
          up(h, () => recordKey("Ctrl-U", due))
        }
      },
    }
    const queuedReversal: Action = {
      name: `queued-reversal-${warmRepeats}-each-way`,
      group: "queued-reversal",
      dispatch: async (h, recordKey) => {
        if (independentSender)
          return dispatchIndependent(h, recordKey, [
            ...Array(warmRepeats).fill("Ctrl-U"),
            ...Array(warmRepeats).fill("Ctrl-D"),
          ])
        const sequenceStarted = performance.now()
        for (let index = 0; index < warmRepeats * 2; index++) {
          const due = sequenceStarted + index * intervalMs
          const remaining = due - performance.now()
          if (remaining > 0) await Bun.sleep(remaining)
          const key = index < warmRepeats ? "Ctrl-U" : "Ctrl-D"
          const dispatch = index < warmRepeats ? up : down
          dispatch(h, () => recordKey(key, due))
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
    } else if (workload === "held") {
      // First traversal has no earlier navigation warmup. Repeat the same
      // route to distinguish first-visit work from retained geometry revisits.
      await runAction({ ...queuedUp, name: "first-traversal-held-up" })
      if (!landingKey) {
        await runAction({
          ...returnToTail,
          name: "reset-before-warm-reversal",
          group: "setup",
        })
        await runAction({ ...queuedReversal, name: "warm-route-held-reversal" })
      }
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
      if (reversal) {
        await runAction({
          ...returnToTail,
          name: "reset-before-reversal",
          group: "setup",
        })
        await runAction(queuedReversal)
      }
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
        experiment: {
          deferCodeDetail: navigationDetailExperimentEnabled,
          budgetMeasurements: navigationMeasurementBudgetEnabled,
          idleMs: 120,
        },
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
        rendererCadence: {
          targetFps: measured.setup.renderer.targetFps,
          maxFps: measured.setup.renderer.maxFps,
        },
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
          retainWindow: process.env.VIMEX_NAV_RETAINED_WINDOW !== "0",
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
          independentSender,
          kittyHeldInput,
          landingKeys,
          landingIntervalMs,
          landingTargetIndex: landingTargetIndex ?? null,
          initialViewportIndex: initialViewportIndex ?? null,
          landingKey: landingKey ?? null,
          landingFocus: landingKey ? landingFocus : null,
          landingDelayMs: landingKey ? landingDelayMs : null,
          repeatControl: process.env.VIMEX_NAV_REPEAT_CONTROL !== "0",
          requestedIntervalMs: intervalMs,
          warmRepeats,
          traceNavigation,
          traceLimit,
          traceFromKey,
          traceToKey,
          traceCells,
          traceFromSequence,
          traceToSequence,
          traceQualification:
            "dispatchedKeys counts mock key dispatch entry; key.returned is synchronous delivery only. intent.enqueued marks UI acceptance; intent.resolved reports an explicit settled intent with coherent/native cursor evidence. Detail windows follow activeIntentSequence as well as dispatched keys, so queued resolution remains visible after later keys arrive. row.step/cursor.resolve/prepare.complete provide intermediate context.",
          pacing:
            "paced-up settles each key; queued-paced-up dispatches at the requested cadence without intermediate settle or explicit render; compare actual intervals and paint keysDispatched",
          settledActualDispatchIntervalsMs: settledDispatchStarts
            .slice(1)
            .map((at, i) => round(at - settledDispatchStarts[i]!)),
          burst: "8 synchronous key events in one React act",
          capacityActions: capacity ? capacityActions : null,
          boundaryUpSteps: capacity ? null : boundaryUpSteps,
          queuedReversal: workload === "held" || (!capacity && reversal),
          feedbackQualification:
            "Per-key next changed paint is feedback opportunity, not exact key acknowledgement; cell changes can include animations. Movement paints change native top or semantic cursor; gaps include intentional input pacing. Final-paint delay is measured from the last recorded key.",
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
