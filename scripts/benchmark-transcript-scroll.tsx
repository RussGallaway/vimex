// Diagnostic transcript benchmark; intentionally has no timing pass/fail gate.
import assert from "node:assert/strict"
import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import {
  createConversation,
  itemId,
  reduceConversation,
  threadId,
  turnId,
  type ConversationEvent,
} from "@vimex/conversation"
import {
  blockKey,
  initialTranscript,
  syncTranscriptItem,
  TranscriptRuntime,
  type BlockGeometry,
  type TranscriptRuntimeInput,
  type TranscriptState,
} from "@vimex/transcript"
import { act } from "react"
import { ToolCall } from "../packages/ui-opentui-react/src/transcript/ToolCall"
import {
  measureRenderedTranscript,
  topVisiblePoint,
  transcriptBlockRenderableId,
} from "../packages/ui-opentui-react/src/transcript/rendered-layout"

interface Source {
  readonly conversation: ReturnType<typeof createConversation>
  readonly transcript: TranscriptState
  readonly revision: number
}

interface TimingStats {
  readonly count: number
  readonly min: number
  readonly median: number
  readonly p95: number
  readonly max: number
  readonly mean: number
}

const viewport = Object.freeze({ width: 100, height: 30 })
const styleRevision = "benchmark"

function apply(source: Source, event: ConversationEvent): Source {
  const conversation = reduceConversation(source.conversation, event)
  const changed = event.type === "item.delta" ? event.itemId
    : event.type === "item.started" || event.type === "item.completed" ? event.item.id : undefined
  const transcript = changed && conversation.items[changed]
    ? syncTranscriptItem(source.transcript, conversation.items[changed]!)
    : source.transcript
  return Object.freeze({
    conversation,
    transcript,
    revision: source.revision + (conversation === source.conversation ? 0 : 1),
  })
}

function runtimeInput(source: Source, thread: ReturnType<typeof threadId>, canonicalDamage: TranscriptRuntimeInput["canonicalDamage"] = { kind: "none" }): TranscriptRuntimeInput {
  return Object.freeze({
    threadId: thread,
    canonicalGeneration: 0,
    canonicalRevision: source.revision,
    conversation: source.conversation,
    transcript: source.transcript,
    mode: "follow",
    canonicalDamage,
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
  console.log(JSON.stringify({ benchmark: "transcript-runtime", ...result }))
}

const largeThread = threadId("benchmark-large-thread")
const largeTurn = turnId("benchmark-large-turn")
const largeItemId = itemId("large")
const largeDetail = Array.from({ length: 1500 }, (_, index) => `${index}: ${"result ".repeat(12)}`).join("\n")
const largeItem = Object.freeze({
  id: largeItemId,
  turnId: largeTurn,
  kind: "command" as const,
  title: "Large output",
  status: "complete" as const,
  detail: largeDetail,
})

function largeSource(): Source {
  let source: Source = Object.freeze({ conversation: createConversation(largeThread), transcript: initialTranscript(), revision: 0 })
  source = apply(source, { type: "turn.started", threadId: largeThread, turnId: largeTurn })
  return apply(source, { type: "item.started", threadId: largeThread, item: largeItem })
}

function largeTranscript(runtime: TranscriptRuntime, scrollId: string) {
  const block = runtime.getSnapshot().window.blocks.find(candidate => candidate.key.kind === "item")
  if (!block || !("renderItem" in block)) throw new Error("large benchmark item block is missing")
  assert(block.renderItem.kind === "command" || block.renderItem.kind === "tool")
  return <scrollbox id={scrollId} width="100%" height="100%">
    <box id={transcriptBlockRenderableId(block)}>
      <ToolCall item={block.renderItem} folded={false} />
    </box>
  </scrollbox>
}

async function coldGeometrySample(): Promise<Readonly<{ nativeFirstFrameMs: number; runtimeGeometryRebuildMs: number }>> {
  const runtime = new TranscriptRuntime(runtimeInput(largeSource(), largeThread))
  const scrollId = "cold-geometry-scroll"
  const started = performance.now()
  const setup = await testRender(largeTranscript(runtime, scrollId), viewport)
  try {
    await act(async () => { await setup.flush() })
    const nativeFirstFrameMs = performance.now() - started
    const scroll = setup.renderer.root.findDescendantById(scrollId) as ScrollBoxRenderable

    const frame = runtime.getSnapshot()
    const geometryStarted = performance.now()
    const first = measureRenderedTranscript(setup.renderer, scroll, { frame, runtime, styleRevision })
    const runtimeGeometryRebuildMs = performance.now() - geometryStarted
    const published = runtime.getSnapshot()
    const layout = measureRenderedTranscript(setup.renderer, scroll, { frame: published, runtime, styleRevision })
    assert.equal(first, undefined, "the first runtime-owned measure publishes geometry before it returns a layout")
    assert.equal(published.geometry.measuredBlockCount, 1)
    assert.equal(published.geometry.totalPoints, published.transcript.projectionById[largeItemId]!.sourceSpans.length + 1)
    assert(layout, "the published geometry must build a layout on the next read")
    return Object.freeze({ nativeFirstFrameMs, runtimeGeometryRebuildMs })
  } finally {
    runtime.dispose()
    await act(async () => setup.renderer.destroy())
  }
}

async function benchmarkColdGeometry(): Promise<void> {
  const warmups = 1, samples = 12
  const nativeFirstFrames: number[] = [], runtimeGeometryRebuilds: number[] = []
  for (let index = 0; index < warmups + samples; index++) {
    const measured = await coldGeometrySample()
    if (index < warmups) continue
    nativeFirstFrames.push(measured.nativeFirstFrameMs)
    runtimeGeometryRebuilds.push(measured.runtimeGeometryRebuildMs)
  }
  printResult({
    scenario: "cold-geometry",
    ownership: "runtime",
    mode: "follow",
    viewport,
    fixture: { contentShape: "single-expanded-command", items: 1, blocks: 1, kind: "command", status: "complete", lines: 1500, chars: largeDetail.length, folded: false,
      cacheScope: "fresh runtime, renderer, and scroll caches per sample; process and JIT warm after discarded sample" },
    samples: { warmup: warmups, measured: samples },
    metricsMs: {
      nativeFirstFrame: stats(nativeFirstFrames),
      runtimeGeometryRebuild: stats(runtimeGeometryRebuilds),
    },
  })
}

async function benchmarkWarmNavigation(): Promise<void> {
  const runtime = new TranscriptRuntime(runtimeInput(largeSource(), largeThread))
  const scrollId = "warm-navigation-scroll"
  const setup = await testRender(largeTranscript(runtime, scrollId), viewport)
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    const scroll = setup.renderer.root.findDescendantById(scrollId) as ScrollBoxRenderable
    measureRenderedTranscript(setup.renderer, scroll, { frame: runtime.getSnapshot(), runtime, styleRevision })
    const initialLayout = measureRenderedTranscript(setup.renderer, scroll, {
      frame: runtime.getSnapshot(), runtime, styleRevision,
    })
    assert(initialLayout)

    const warmups = 1, samples = 12
    const frames: number[] = [], layouts: number[] = [], anchors: number[] = []
    const sample = async (record: boolean) => {
      scroll.scrollBy(15, "step")
      let started = performance.now()
      await setup.renderOnce()
      const frameMs = performance.now() - started
      started = performance.now()
      const layout = measureRenderedTranscript(setup.renderer, scroll, {
        frame: runtime.getSnapshot(), runtime, styleRevision,
      })
      const layoutMs = performance.now() - started
      assert(layout)
      started = performance.now()
      assert(topVisiblePoint(layout, scroll))
      const anchorMs = performance.now() - started
      if (record) { frames.push(frameMs); layouts.push(layoutMs); anchors.push(anchorMs) }
    }
    for (let index = 0; index < warmups; index++) await sample(false)
    for (let index = 0; index < samples; index++) await sample(true)
    printResult({
      scenario: "warm-navigation",
      ownership: "runtime",
      mode: "follow",
      viewport,
      fixture: { contentShape: "single-expanded-command", items: 1, blocks: 1, kind: "command", status: "complete", lines: 1500, chars: largeDetail.length, folded: false,
        scroll: { direction: "down", stepRows: 15 }, cacheScope: "runtime geometry and scroll caches warmed before recorded samples" },
      samples: { warmup: warmups, measured: samples },
      metricsMs: { nativeFrame: stats(frames), cachedLayout: stats(layouts), visibleAnchor: stats(anchors) },
    })
  } finally {
    runtime.dispose()
    await act(async () => setup.renderer.destroy())
  }
}

const followThread = threadId("benchmark-follow-thread")
const followTurn = turnId("benchmark-follow-turn")
const followTail = itemId("follow-tail")

function followSources(): Readonly<{ before: Source; after: Source }> {
  let source: Source = Object.freeze({ conversation: createConversation(followThread), transcript: initialTranscript(), revision: 0 })
  source = apply(source, { type: "turn.started", threadId: followThread, turnId: followTurn })
  for (let index = 0; index < 300; index++) {
    source = apply(source, {
      type: "item.started",
      threadId: followThread,
      item: {
        id: itemId(`follow-history-${index}`),
        turnId: followTurn,
        kind: "assistant",
        markdown: `Settled history item ${index}.`,
        status: "complete",
      },
    })
  }
  source = apply(source, {
    type: "item.started",
    threadId: followThread,
    item: { id: followTail, turnId: followTurn, kind: "assistant", markdown: "Tail seed.", status: "running" },
  })
  const before = source
  const after = apply(before, {
    type: "item.delta",
    threadId: followThread,
    itemId: followTail,
    delta: `\n${"Streaming tail delta. ".repeat(20)}`,
  })
  return Object.freeze({ before, after })
}

function syntheticGeometry(runtime: TranscriptRuntime, nativeRevision = 1): readonly BlockGeometry[] {
  return runtime.getSnapshot().blocks.map(block => Object.freeze({
    key: Object.freeze({
      blockKey: blockKey(block),
      contentRevision: block.contentRevision,
      width: viewport.width,
      styleRevision,
      folded: false,
    }),
    nativeRevision,
    rows: 2,
    points: Object.freeze({ 0: Object.freeze({ graphemeOffset: 0, x: 0, y: 0, row: 0, column: 0 }) }),
    lines: Object.freeze([Object.freeze({ from: 0, to: 0, row: 0 })]),
  }))
}

function followReconciliationSample(sources: ReturnType<typeof followSources>): number {
  const runtime = new TranscriptRuntime(runtimeInput(sources.before, followThread))
  try {
    runtime.reportMeasurements({ ...runtime.measurementBase(), measurements: syntheticGeometry(runtime) })
    const before = runtime.getSnapshot()
    assert.equal(before.blocks.length, 301)
    assert.equal(before.geometry.measuredBlockCount, 301)
    const blocksByKey = new Map(before.blocks.map(block => [blockKey(block), block]))
    const geometryByKey = new Map(Object.entries(before.geometry.byBlockKey))
    const tailKey = `item:${followTail}:root`
    const afterInput = runtimeInput(sources.after, followThread, { kind: "blocks", itemIds: [followTail] })

    const started = performance.now()
    const after = runtime.update(afterInput)
    const elapsed = performance.now() - started

    const changed = after.blocks.filter(block => blocksByKey.get(blockKey(block)) !== block).map(blockKey)
    assert.deepEqual(changed, [tailKey], "follow reconciliation must replace only the streaming tail block")
    for (const block of after.blocks) {
      const key = blockKey(block)
      if (key === tailKey) continue
      assert.equal(after.geometry.byBlockKey[key], geometryByKey.get(key), `history geometry identity changed for ${key}`)
    }
    assert.equal(after.geometry.byBlockKey[tailKey], undefined, "changed tail geometry must be invalidated")
    assert.equal(after.geometry.measuredBlockCount, 300)
    assert.deepEqual(after.damage, { kind: "blocks", itemIds: [followTail] })
    return elapsed
  } finally {
    runtime.dispose()
  }
}

function benchmarkFollowReconciliation(): void {
  const warmups = 10, samples = 100
  const sources = followSources()
  const totalChars = (source: Source) => Object.values(source.transcript.projectionById).reduce((sum, projection) => sum + projection.source.length, 0)
  const timings: number[] = []
  for (let index = 0; index < warmups + samples; index++) {
    const elapsed = followReconciliationSample(sources)
    if (index >= warmups) timings.push(elapsed)
  }
  printResult({
    scenario: "follow-reconciliation",
    ownership: "runtime",
    mode: "follow",
    viewport,
    fixture: {
      contentShape: "settled-history-plus-running-markdown-tail",
      items: 301,
      blocks: 301,
      completedHistoryItems: 300,
      streamingTailItems: 1,
      charsBefore: sources.before.transcript.projectionById[followTail]!.source.length,
      charsAfter: sources.after.transcript.projectionById[followTail]!.source.length,
      totalCharsBefore: totalChars(sources.before),
      totalCharsAfter: totalChars(sources.after),
      changedItemIds: [followTail],
      damage: "blocks",
      geometryState: "all-blocks-measured",
      seededGeometryBlocks: 301,
      modeBefore: "follow",
      modeAfter: "follow",
      cacheScope: "fresh runtime per sample; canonical projection and geometry seeding excluded from timing",
    },
    samples: { warmup: warmups, measured: samples },
    metricsMs: { update: stats(timings) },
  })
}

await benchmarkWarmNavigation()
await benchmarkColdGeometry()
benchmarkFollowReconciliation()
