// Opt-in connected Stage 5 input benchmark. Run one fixture size per process so
// native mounting, memory, and end-to-end input settlement remain isolated.
import assert from "node:assert/strict"
import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import type { ApprovalGateway } from "@vimex/approvals"
import type { ConversationGateway } from "@vimex/conversation"
import { buildTranscriptScalingFixture, transcriptScalingBlockCounts } from "@vimex/testkit"
import { blockKey } from "@vimex/transcript"
import {
  VimexController,
  type ModelCatalog,
  type RuntimeConnection,
  type ThreadWorkspace,
} from "@vimex/workbench"
import { act, Profiler } from "react"
import { ConnectedVimexRoot } from "../packages/ui-opentui-react/src"
import { transcriptBlockRenderableId } from "../packages/ui-opentui-react/src/transcript/rendered-layout"

interface TimingStats {
  readonly count: number
  readonly min: number
  readonly median: number
  readonly p95: number
  readonly max: number
  readonly mean: number
}

const fixtureVersion = "transcript-scaling-v1"
const viewport = Object.freeze({ width: 80, height: 24 })

function memorySnapshot() {
  const usage = process.memoryUsage()
  return Object.freeze({ heapUsedBytes: usage.heapUsed, rssBytes: usage.rss })
}

function memoryDelta(before: ReturnType<typeof memorySnapshot>, after: ReturnType<typeof memorySnapshot>) {
  return Object.freeze({
    heapUsedBytes: after.heapUsedBytes - before.heapUsedBytes,
    rssBytes: after.rssBytes - before.rssBytes,
  })
}

function stats(values: readonly number[]): TimingStats {
  assert(values.length > 0)
  const sorted = [...values].sort((left, right) => left - right)
  const rounded = (value: number) => Number(value.toFixed(6))
  return Object.freeze({
    count: values.length,
    min: rounded(sorted[0]!),
    median: rounded(sorted[Math.floor(sorted.length / 2)]!),
    p95: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]!),
    max: rounded(sorted.at(-1)!),
    mean: rounded(values.reduce((sum, value) => sum + value, 0) / values.length),
  })
}

function printResult(result: object): void {
  console.log(JSON.stringify({ benchmark: "transcript-windowing", fixtureVersion, ...result }))
}

function mountedBlockRoots(scroll: ScrollBoxRenderable): ReadonlyMap<string, Renderable> {
  const roots = new Map<string, Renderable>()
  const pending = [...scroll.getChildren()]
  while (pending.length) {
    const renderable = pending.pop()!
    if (renderable.id.startsWith("transcript-block:")) {
      assert(!roots.has(renderable.id), `duplicate mounted transcript root ${renderable.id}`)
      roots.set(renderable.id, renderable)
    }
    pending.push(...renderable.getChildren())
  }
  return roots
}

function mountedTreeCounts(scroll: ScrollBoxRenderable): Readonly<{ descendants: number; spacers: number }> {
  let descendants = 0, spacers = 0
  const pending = [...scroll.getChildren()]
  while (pending.length) {
    const renderable = pending.pop()!
    descendants++
    if (renderable.id === "transcript-top-spacer" || renderable.id === "transcript-bottom-spacer") spacers++
    pending.push(...renderable.getChildren())
  }
  return Object.freeze({ descendants, spacers })
}

function fixtureSize(): number {
  const raw = process.env.VIMEX_WINDOWING_INPUT_SIZE ?? "100"
  const size = Number(raw)
  assert(Number.isInteger(size), `invalid VIMEX_WINDOWING_INPUT_SIZE=${raw}`)
  assert(transcriptScalingBlockCounts.includes(size as typeof transcriptScalingBlockCounts[number]),
    `unsupported VIMEX_WINDOWING_INPUT_SIZE=${raw}; expected one of ${transcriptScalingBlockCounts.join(",")}`)
  return size
}

function seedWorkspace(controller: VimexController, fixture: ReturnType<typeof buildTranscriptScalingFixture>): void {
  const state = controller.getSnapshot()
  const workspace = state.workspaces[fixture.threadId]
  assert(workspace, "Workbench did not create the benchmark workspace")
  // Setup-only injection avoids O(n^2) protocol replay for a fixture that is
  // already a valid canonical + semantic snapshot. The measured path begins
  // afterward and uses only public Workbench and UI input boundaries.
  const seeded: ThreadWorkspace = Object.freeze({
    ...workspace,
    canonicalGeneration: 0,
    canonicalRevision: fixture.before.canonicalRevision,
    conversation: fixture.before.conversation,
    transcript: Object.freeze({
      ...fixture.before.transcript,
      selection: undefined,
      folded: Object.freeze({}),
      viewport: Object.freeze({ kind: "tail" as const }),
    }),
  })
  const workspaces = state.workspaces as Record<string, ThreadWorkspace>
  workspaces[fixture.threadId] = seeded
  assert.equal(controller.getPresentationSnapshot("main").workspaces[fixture.threadId], seeded,
    "setup injection must be visible through the Workbench publication before mounting")
}

async function run(): Promise<void> {
  const blockCount = fixtureSize()
  Bun.gc(true)
  const processBaselineMemory = memorySnapshot()
  const fixture = buildTranscriptScalingFixture(blockCount)
  Bun.gc(true)
  const fixtureMemory = memorySnapshot()
  const summary = Object.freeze({
    id: fixture.threadId,
    title: `Input baseline ${blockCount}`,
    cwd: "/work",
    model: "benchmark",
    reasoningEffort: "high",
    status: "working" as const,
  })
  const gateway: ConversationGateway & ApprovalGateway & RuntimeConnection & ModelCatalog = {
    connect: async () => {}, restart: async () => {}, close: async () => {},
    subscribe: () => () => {},
    listThreads: async () => [summary],
    startThread: async () => ({ summary, events: [] }),
    resumeThread: async () => ({ summary, events: [] }),
    forkThread: async () => ({ summary, events: [] }),
    startTurn: async () => [], steerTurn: async () => {}, interruptTurn: async () => {},
    updateSettings: async () => {}, renameThread: async () => {}, resolveApproval: async () => {},
    listModels: async () => [],
  }
  const controller = new VimexController({
    conversation: gateway,
    approvals: gateway,
    connection: gateway,
    models: gateway,
    resolveDirectory: value => value,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
  })
  let setup: Awaited<ReturnType<typeof testRender>> | undefined
  const commits: number[] = []
  try {
    await controller.initialize("/work", undefined, fixture.threadId)
    seedWorkspace(controller, fixture)
    const runtime = controller.transcriptRuntime("main")
    assert(runtime, "Workbench did not create the main transcript runtime")

    function Harness() {
      return <Profiler id="connected-input" onRender={(_id, _phase, duration) => commits.push(duration)}>
        <ConnectedVimexRoot controller={controller} />
      </Profiler>
    }

    setup = await testRender(<Harness />, viewport)
    let stableRuntimeFrames = 0
    let priorPresentationRevision = runtime.getSnapshot().presentationRevision
    for (let frame = 0; frame < 40 && stableRuntimeFrames < 3; frame++) {
      await act(async () => { await setup!.flush(); await setup!.renderOnce() })
      const snapshot = runtime.getSnapshot()
      const windowMeasured = snapshot.window.blocks.every(block => snapshot.geometry.byBlockKey[blockKey(block)] !== undefined)
      if (windowMeasured && snapshot.presentationRevision === priorPresentationRevision) stableRuntimeFrames++
      else stableRuntimeFrames = 0
      priorPresentationRevision = snapshot.presentationRevision
    }
    const before = runtime.getSnapshot()
    assert.equal(before.blocks.length, blockCount)
    assert(before.window.blocks.length <= viewport.height * 2)
    assert(before.window.blocks.every(block => before.geometry.byBlockKey[blockKey(block)] !== undefined),
      `native geometry did not settle every current window block before input`)
    assert.equal(stableRuntimeFrames, 3, "runtime did not reach three measurement-stable native frames before input")
    Bun.gc(true)
    const settledMountMemory = memorySnapshot()
    const scroll = setup.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable
    assert(scroll, "connected App did not mount the transcript scrollbox")
    const rootsBefore = mountedBlockRoots(scroll)
    const nativeTreeBefore = mountedTreeCounts(scroll)
    assert.equal(rootsBefore.size, before.window.blocks.length)
    assert.equal(nativeTreeBefore.spacers, 2)
    assert(nativeTreeBefore.descendants <= before.window.blocks.length * 24 + 2,
      "connected native descendant work must remain bounded by the materialized window")
    const cursorBefore = before.transcript.cursor
    assert(cursorBefore, "fixture cursor is missing")

    commits.length = 0
    let nativeFrames = 0
    let nativeFrameCallbacksMs = 0
    let runtimePublications = 0
    let presentationPublications = 0
    const unsubscribeRuntime = runtime.subscribe(() => { runtimePublications++ })
    const unsubscribePresentation = controller.subscribePresentation("main", () => { presentationPublications++ })
    const originalEmit = setup.renderer.emit.bind(setup.renderer)
    setup.renderer.emit = (event, ...args) => {
      if (event !== "frame") return originalEmit(event, ...args)
      const started = performance.now()
      const result = originalEmit(event, ...args)
      nativeFrames++
      nativeFrameCallbacksMs += performance.now() - started
      return result
    }

    const started = performance.now()
    let inputDispatchMs = 0
    await act(async () => {
      setup!.mockInput.pressKey("w")
      inputDispatchMs = performance.now() - started
      await setup!.flush()
      await setup!.renderOnce()
    })
    await act(async () => { await setup!.flush(); await setup!.renderOnce() })
    const inputSettlementMs = performance.now() - started
    setup.renderer.emit = originalEmit
    unsubscribePresentation()
    unsubscribeRuntime()

    const after = runtime.getSnapshot()
    assert(after.transcript.cursor, "input removed the semantic cursor")
    assert.equal(after.mode, "detached", "connected navigation must detach the presentation")
    assert.equal(after.transcript.viewport.kind, "point", "connected navigation must establish a logical point viewport")
    assert(after.transcript.cursor.itemId === cursorBefore.itemId
      && after.transcript.cursor.graphemeOffset > cursorBefore.graphemeOffset,
    "the connected `w` input did not perform the expected semantic motion")
    const rootsAfter = mountedBlockRoots(scroll)
    const nativeTreeAfter = mountedTreeCounts(scroll)
    assert.equal(rootsAfter.size, after.window.blocks.length)
    assert.equal(nativeTreeAfter.spacers, 2)
    assert(nativeTreeAfter.descendants <= after.window.blocks.length * 24 + 2,
      "connected native descendant work must remain bounded by the materialized window")
    let changedBlocks = 0
    let measuredBlocks = 0
    let retainedMountedRoots = 0
    const afterWindowKeys = new Set(after.window.blocks.map(blockKey))
    for (let index = 0; index < blockCount; index++) {
      const block = after.blocks[index]!
      if (block !== before.blocks[index]) changedBlocks++
      const key = blockKey(block)
      if (afterWindowKeys.has(key) && after.geometry.byBlockKey[key] !== before.geometry.byBlockKey[key]) measuredBlocks++
      const id = transcriptBlockRenderableId(block)
      const root = rootsAfter.get(id)
      if (root && root === rootsBefore.get(id)) retainedMountedRoots++
    }
    const priorRootIds = new Set(rootsBefore.keys())
    const mountedIntersection = [...rootsAfter.keys()].filter(id => priorRootIds.has(id)).length
    assert.equal(changedBlocks, 0)
    assert(measuredBlocks <= after.window.blocks.length, "connected navigation measurement damage must remain window-bounded")
    assert.equal(retainedMountedRoots, mountedIntersection)
    assert(after.window.blocks.every(block => after.geometry.byBlockKey[blockKey(block)] !== undefined))
    assert(runtimePublications > 0, "connected input must publish transcript work")
    assert.equal(presentationPublications, 1, "connected input must publish one Workbench presentation state")
    assert(commits.length > 0, "connected input produced no React commit")
    assert(nativeFrames > 0, "connected input produced no native frame")
    Bun.gc(true)
    const settledInputMemory = memorySnapshot()

    printResult({
      scenario: "connected-input-navigation",
      boundary: "workbench-connected-react-opentui-input",
      status: "passed",
      blockCount,
      viewport,
      mode: "follow-to-detached",
      fixture: { contentShape: "mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
      operationCounts: {
        completeBlocks: after.blocks.length,
        materializedWindowBlocks: after.window.blocks.length,
        mountedBlocks: rootsAfter.size,
        measuredBlocks,
        changedBlocks,
        publications: runtimePublications,
        runtimePublications,
        presentationPublications,
        retainedMountedRoots,
        retainedMeasurements: after.geometry.measuredBlockCount,
        measuredBlockUpperBound: after.window.blocks.length,
        mountedNativeDescendantsBefore: nativeTreeBefore.descendants,
        mountedNativeDescendantsAfter: nativeTreeAfter.descendants,
        stableSpacerRoots: nativeTreeAfter.spacers,
      },
      diagnosticCounts: { reactCommits: commits.length, nativeFrames },
      timingsMs: {
        inputDispatch: Number(inputDispatchMs.toFixed(6)),
        finalSettlement: Number(inputSettlementMs.toFixed(6)),
        postDispatchSettlement: Number((inputSettlementMs - inputDispatchMs).toFixed(6)),
        nativeFrameCallbacks: Number(nativeFrameCallbacksMs.toFixed(6)),
        reactCommitDurations: stats(commits),
      },
      memory: {
        scope: "isolated worker; diagnostic absolute snapshots and deltas",
        processBaseline: processBaselineMemory,
        fixtureBuilt: fixtureMemory,
        settledNativeMount: settledMountMemory,
        settledInput: settledInputMemory,
        fixtureDelta: memoryDelta(processBaselineMemory, fixtureMemory),
        nativeMountDelta: memoryDelta(fixtureMemory, settledMountMemory),
        inputDelta: memoryDelta(settledMountMemory, settledInputMemory),
      },
      samples: { warmup: 0, measured: 1 },
    })
  } catch (error) {
    Bun.gc(true)
    const failureMemory = memorySnapshot()
    printResult({
      scenario: "connected-input-navigation",
      boundary: "workbench-connected-react-opentui-input",
      status: "failed",
      blockCount,
      viewport,
      fixture: { contentShape: "mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
      operationCounts: { completeBlocks: blockCount, mountedBlocks: null, measuredBlocks: null, changedBlocks: null, publications: null },
      memory: {
        scope: "isolated worker at failure; diagnostic absolute snapshots and deltas",
        processBaseline: processBaselineMemory,
        fixtureBuilt: fixtureMemory,
        atFailure: failureMemory,
        fixtureDelta: memoryDelta(processBaselineMemory, fixtureMemory),
        attemptedMountDelta: memoryDelta(fixtureMemory, failureMemory),
      },
      error: error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError", message: String(error) },
    })
    process.exitCode = 1
  } finally {
    if (setup) await act(async () => setup!.renderer.destroy())
    await controller.close().catch(() => {})
  }
}

async function supervise(): Promise<void> {
  const blockCount = fixtureSize()
  const timeoutMs = Number(process.env.VIMEX_WINDOWING_INPUT_TIMEOUT_MS ?? "240000")
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0, "VIMEX_WINDOWING_INPUT_TIMEOUT_MS must be a positive integer")
  const child = Bun.spawn([process.execPath, import.meta.path], {
    env: { ...process.env, VIMEX_WINDOWING_INPUT_WORKER: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill("SIGTERM")
  }, timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timeout)
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  if (timedOut && !stdout.includes('"status":"failed"')) {
    printResult({
      scenario: "connected-input-navigation",
      boundary: "workbench-connected-react-opentui-input",
      status: "failed",
      blockCount,
      viewport,
      operationCounts: { completeBlocks: blockCount, mountedBlocks: null, measuredBlocks: null, changedBlocks: null, publications: null },
      error: { name: "WorkerTimeout", message: `isolated benchmark worker did not settle within ${timeoutMs} ms` },
    })
  } else if (exitCode !== 0 && !stdout.includes('"status":"failed"')) {
    printResult({
      scenario: "connected-input-navigation",
      boundary: "workbench-connected-react-opentui-input",
      status: "failed",
      blockCount,
      viewport,
      operationCounts: { completeBlocks: blockCount, mountedBlocks: null, measuredBlocks: null, changedBlocks: null, publications: null },
      error: { name: "WorkerExit", message: `isolated benchmark worker exited with code ${exitCode}` },
    })
  }
  if (exitCode !== 0 || timedOut) process.exitCode = exitCode || 1
}

if (process.env.VIMEX_WINDOWING_INPUT_WORKER === "1") await run()
else await supervise()
