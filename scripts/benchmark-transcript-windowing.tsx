// Diagnostic Stage 5 scaling benchmark; timings are curves, never CI gates.
//
// Native production-window baselines intentionally require an explicit size
// selection so each memory/timing curve has a clear fixture boundary. Run one
// or more explicit cells, for example:
//   VIMEX_WINDOWING_NATIVE_BASELINE=1 VIMEX_WINDOWING_GEOMETRY_BASELINE=1 \
//   VIMEX_WINDOWING_SIZES=100 VIMEX_WINDOWING_VIEWPORTS=80x24 \
//   bun scripts/benchmark-transcript-windowing.tsx
import assert from "node:assert/strict"
import { CliRenderEvents, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import {
  appendTranscriptScalingTail,
  buildOversizedTranscriptFixtures,
  buildTranscriptScalingFixture,
  buildTranscriptStructuralScalingFixture,
  transcriptScalingBlockCounts,
  type TranscriptFixtureSnapshot,
} from "@vimex/testkit"
import {
  conversationItemAt,
  createConversationReductionDiagnostics,
  createConversationStructureDiagnostics,
  itemId,
  persistentConversationTurnIds,
  reduceConversationReference,
  reduceConversationWithDiagnostics,
  threadId,
  turnId,
  type ConversationItemRecordDiagnostics,
  type ItemId,
} from "@vimex/conversation"
import {
  blockKey,
  createHeightIndex,
  createTranscriptFrame,
  moveByUrl,
  moveByUrlReference,
  passThroughWindow,
  pointIsMaterialized,
  planTranscriptWindow,
  persistentTranscriptUnseenItemIds,
  primeTranscriptUrlIndex,
  setTranscriptFoldValue,
  syncTranscriptItem,
  transcriptOrderIndex,
  transcriptPointBlockIndex,
  transcriptTextLengthRange,
  TranscriptRuntime,
  type BlockHeightOverride,
  type TranscriptItemSyncDiagnostics,
  type BlockGeometry,
  type TranscriptFrame,
  type TranscriptHeightIndex,
  type TranscriptBlock,
  type TranscriptRuntimeInput,
} from "@vimex/transcript"
import { act, createRef, Profiler, useRef, useState, useSyncExternalStore, type RefObject } from "react"
import { createEmberTideSyntax } from "../packages/ui-opentui-react/src/theme"
import { blockNativeRevision } from "../packages/ui-opentui-react/src/transcript/measure-rendered-block"
import { movePointInTranscript } from "../packages/ui-opentui-react/src/transcript/layout"
import { measureRenderedTranscript, transcriptBlockRenderableId, type RenderedLayoutDiagnostics } from "../packages/ui-opentui-react/src/transcript/rendered-layout"
import { TranscriptViewport } from "../packages/ui-opentui-react/src/transcript/TranscriptViewport"
import { useTranscriptRuntime } from "../packages/ui-opentui-react/src/transcript/use-transcript-runtime"
import { useTranscriptLayout } from "../packages/ui-opentui-react/src/transcript/use-transcript-layout"
import { useVisiblePresentationSnapshot } from "../packages/ui-opentui-react/src/side-chat/SideChatLayout"
import { inertController } from "../packages/ui-opentui-react/src/contracts"
import { captureWorkbenchPresentation, createWorkspace, incrementalConversationEventDamage, initialWorkbench, workbenchPresentationChanged,
  type WorkbenchPublicationHost, type WorkbenchState } from "@vimex/workbench"
import { applyConversationEvent } from "../packages/workbench/src/application/conversation-projector"

interface TimingStats {
  readonly count: number
  readonly min: number
  readonly median: number
  readonly p95: number
  readonly max: number
  readonly mean: number
}

const primaryViewport = Object.freeze({ width: 100, height: 30 })
const defaultNativeViewports = Object.freeze([
  Object.freeze({ width: 48, height: 18 }),
  Object.freeze({ width: 80, height: 24 }),
  Object.freeze({ width: 140, height: 40 }),
])
const styleRevision = "stage-5.0-baseline"
function createDiagnostics(): RenderedLayoutDiagnostics {
  return {
    candidateBlocks: 0, visibleCandidates: 0, overscanCandidates: 0,
    attemptedMeasurements: 0, changedMeasurements: 0, cachedMeasurements: 0, rejectedMeasurements: 0, placementValidationVisits: 0,
    pendingAfter: 0, trackedMountedRoots: 0, prunedRoots: 0,
    visibleBeforeOverscan: true, attemptedKeys: [], prunedKeys: [],
  }
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
  console.log(JSON.stringify({ benchmark: "transcript-windowing", fixtureVersion: "transcript-scaling-v1", ...result }))
}

function runtimeInput(
  fixture: Readonly<{ threadId: TranscriptRuntimeInput["threadId"] }>,
  snapshot: TranscriptFixtureSnapshot,
  mode: "follow" | "detached",
  options: Pick<TranscriptRuntimeInput, "canonicalDamage" | "presentationDamage" | "reveal"> = {},
): TranscriptRuntimeInput {
  return {
    threadId: fixture.threadId,
    canonicalGeneration: 0,
    canonicalRevision: snapshot.canonicalRevision,
    conversation: snapshot.conversation,
    transcript: snapshot.transcript,
    mode,
    canonicalDamage: options.canonicalDamage ?? { kind: "none" },
    presentationDamage: options.presentationDamage,
    reveal: options.reveal,
  }
}

const sharedPoint = Object.freeze({ 0: Object.freeze({ graphemeOffset: 0, x: 0, y: 0, row: 0, column: 0 }) })
const sharedOffsets = Object.freeze({ 0: Object.freeze([0]) })
const sharedLine = Object.freeze({ from: 0, to: 0, row: 0 })
const sharedLines = Object.freeze([sharedLine])
const sharedLineByRow = Object.freeze({ 0: sharedLine })

function syntheticGeometry(frame: TranscriptFrame, nativeRevision = 1): readonly BlockGeometry[] {
  return frame.window.blocks.map(block => Object.freeze({
    key: Object.freeze({
      blockKey: blockKey(block),
      contentRevision: block.contentRevision,
      width: primaryViewport.width,
      styleRevision,
      folded: block.key.kind === "item" && Boolean(frame.transcript.folded[block.key.itemId]),
    }),
    nativeRevision,
    rows: 1,
    pointCount: 1,
    points: sharedPoint,
    pointOffsetsByRow: sharedOffsets,
    lines: sharedLines,
    lineByRow: sharedLineByRow,
  }))
}

function forceGc(): void {
  Bun.gc(true)
}

function timed<T>(operation: () => T): Readonly<{ value: T; milliseconds: number }> {
  const started = performance.now()
  const value = operation()
  return Object.freeze({ value, milliseconds: performance.now() - started })
}

function benchmarkHash(value: string): string {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619)
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function observingHeightIndex(index: TranscriptHeightIndex, counters: { nodeVisits: number; nodesCopied: number }): TranscriptHeightIndex {
  return Object.freeze({
    blockCount: index.blockCount,
    totalRows: index.totalRows,
    prefixRows: (blockIndex: number, explicit?: typeof counters) => index.prefixRows(blockIndex, explicit ?? counters),
    blockAtRow: (row: number, explicit?: typeof counters) => index.blockAtRow(row, explicit ?? counters),
    rowRange: (from: number, to: number, explicit?: typeof counters) => index.rowRange(from, to, explicit ?? counters),
    blockIndex: (key: string) => index.blockIndex(key),
    itemBlockIndexes: (id: ItemId) => index.itemBlockIndexes(id),
    replaceHeight: (override: BlockHeightOverride, explicit?: typeof counters) => index.replaceHeight(override, explicit ?? counters),
    replaceBlock: (blocks: readonly TranscriptBlock[], previous: TranscriptBlock, next: TranscriptBlock, rows: number,
      explicit?: typeof counters) => index.replaceBlock(blocks, previous, next, rows, explicit ?? counters),
    supports: (blocks: readonly TranscriptBlock[]) => index.supports(blocks),
  })
}

function createRuntimeDiagnostics() {
  return {
    completePlanBuilds: 0, completePlanBlockVisits: 0,
    orderIndexBuilds: 0, orderIndexItemVisits: 0, orderIndexCacheHits: 0,
    textLengthIndexBuilds: 0, textLengthItemVisits: 0, textLengthIndexCacheHits: 0, textLengthIndexUpdates: 0, textLengthNodeVisits: 0,
    urlIndexBuilds: 0, urlIndexItemVisits: 0, urlIndexCacheHits: 0, urlIndexUpdates: 0, urlIndexNodeVisits: 0,
    projectionRecordUpdates: 0, projectionRecordNodeVisits: 0, projectionRecordNodesCopied: 0,
    blockPlanUpdates: 0, blockPlanNodeVisits: 0, blockPlanNodesCopied: 0,
    heightIndexBuilds: 0, heightIndexBlockVisits: 0, heightIndexUpdates: 0, heightIndexNodeVisits: 0, heightIndexNodesCopied: 0,
    completeGeometryBlockVisits: 0, windowGeometryBlockVisits: 0, blockPlanWindowSliceItems: 0, changedItemBuilds: 0,
    unseenItemSequenceNormalizations: 0, unseenItemSequenceNormalizationItemVisits: 0,
    unseenItemMembershipChecks: 0, unseenItemMembershipNodeVisits: 0,
    unseenItemAppends: 0, unseenItemAppendNodeVisits: 0,
    unseenItemIndexUpdateNodeVisits: 0, unseenItemIndexUpdateNodesCopied: 0,
    hiddenDamageMerges: 0, hiddenDamageInputItemVisits: 0, hiddenDamageItemAdditions: 0,
    hiddenDamageSnapshots: 0, hiddenDamageSnapshotItemVisits: 0,
  }
}

function createConversationItemDiagnostics(): ConversationItemRecordDiagnostics {
  return {
    conversationItemRecordNormalizations: 0,
    conversationItemRecordNormalizationItemVisits: 0,
    conversationItemRecordLookups: 0,
    conversationItemRecordLookupNodeVisits: 0,
    conversationItemRecordUpdates: 0,
    conversationItemRecordNodeVisits: 0,
    conversationItemRecordNodesCopied: 0,
  }
}

function createTranscriptItemSyncDiagnostics(): TranscriptItemSyncDiagnostics {
  return {
    projectionRecordUpdates: 0, projectionRecordNodeVisits: 0, projectionRecordNodesCopied: 0,
    orderIndexBuilds: 0, orderIndexItemVisits: 0, orderIndexCacheHits: 0,
    textLengthIndexBuilds: 0, textLengthItemVisits: 0, textLengthIndexCacheHits: 0,
    textLengthIndexUpdates: 0, textLengthNodeVisits: 0,
    urlIndexBuilds: 0, urlIndexItemVisits: 0, urlIndexCacheHits: 0, urlIndexUpdates: 0, urlIndexNodeVisits: 0,
    unseenItemSequenceNormalizations: 0, unseenItemSequenceNormalizationItemVisits: 0,
    unseenItemMembershipChecks: 0, unseenItemMembershipNodeVisits: 0,
    unseenItemAppends: 0, unseenItemAppendNodeVisits: 0,
    unseenItemIndexUpdateNodeVisits: 0, unseenItemIndexUpdateNodesCopied: 0,
  }
}

const oversizedCommandFixture = buildOversizedTranscriptFixtures().find(fixture => fixture.shape === "command-output")!
const oversizedCommandContentHash = benchmarkHash(oversizedCommandFixture.source)
let oversizedCommandFragmentCount: number | undefined
let oversizedCommandFollowMountedCount: number | undefined
let oversizedCommandDetachedMountedCount: number | undefined

function oversizedCommandSnapshot(fixture: ReturnType<typeof buildTranscriptStructuralScalingFixture>): TranscriptFixtureSnapshot {
  const turnConversation = reduceConversationWithDiagnostics(fixture.before.conversation, {
    type: "turn.started", threadId: fixture.threadId, turnId: oversizedCommandFixture.item.turnId,
  }, createConversationReductionDiagnostics())
  const itemConversation = reduceConversationWithDiagnostics(turnConversation, {
    type: "item.started", threadId: fixture.threadId, item: oversizedCommandFixture.item,
  }, createConversationReductionDiagnostics())
  const completedConversation = reduceConversationWithDiagnostics(itemConversation, {
    type: "turn.completed", threadId: fixture.threadId, turnId: oversizedCommandFixture.item.turnId,
    outcome: "complete", durationMs: 1,
  }, createConversationReductionDiagnostics())
  const transcript = syncTranscriptItem(fixture.before.transcript, oversizedCommandFixture.item)
  return Object.freeze({
    canonicalRevision: fixture.before.canonicalRevision + 3,
    conversation: completedConversation,
    transcript,
  })
}

const oversizedCommandAddedBlockCount = (() => {
  const fixture = buildTranscriptStructuralScalingFixture(1)
  const snapshot = oversizedCommandSnapshot(fixture)
  return createTranscriptFrame(runtimeInput(fixture, snapshot, "follow", {
    canonicalDamage: { kind: "full" },
  })).blocks.length - fixture.blockCount
})()

function oversizedCommandProductionBaseline(targetBlockCount: number): void {
  const fixture = buildTranscriptStructuralScalingFixture(targetBlockCount - oversizedCommandAddedBlockCount)
  const snapshot = oversizedCommandSnapshot(fixture)
  const transcript = snapshot.transcript
  const runtimeDiagnostics = createRuntimeDiagnostics()
  forceGc()
  const constructed = timed(() => new TranscriptRuntime(runtimeInput(fixture, snapshot, "follow", {
    canonicalDamage: { kind: "full" },
  }), { windowPolicy: { viewportRows: 24, overscanRows: 24 }, diagnostics: runtimeDiagnostics }))
  const runtime = constructed.value
  try {
    const followed = runtime.getSnapshot()
    const fragments = followed.blocks.filter(block => block.key.kind === "item"
      && block.key.itemId === oversizedCommandFixture.item.id)
    oversizedCommandFragmentCount ??= fragments.length
    oversizedCommandFollowMountedCount ??= followed.window.blocks.length
    assert.equal(fragments.length, oversizedCommandFragmentCount)
    assert(fragments.length > 1)
    assert(fragments.every(block => "projection" in block && block.sourceSpan.to - block.sourceSpan.from <= 4_096))
    assert.equal(followed.window.blocks.length, oversizedCommandFollowMountedCount)
    assert(followed.window.blocks.length <= 48)
    assert.equal(followed.blocks.length, targetBlockCount)
    const reference = createTranscriptFrame(runtimeInput(fixture, snapshot, "follow", {
      canonicalDamage: { kind: "full" },
    }))
    const referenceFragments = reference.blocks.filter(block => block.key.kind === "item"
      && block.key.itemId === oversizedCommandFixture.item.id)
    assert(referenceFragments.every((block, index) => block === fragments[index]))

    const projection = transcript.projectionById[oversizedCommandFixture.item.id]!
    const point = Object.freeze({ itemId: oversizedCommandFixture.item.id,
      graphemeOffset: Math.floor(projection.sourceSpans.length / 2) })
    const heightIndex = createHeightIndex(followed.blocks)
    assert(heightIndex)
    const heightWork = { nodeVisits: 0, nodesCopied: 0 }
    const observedHeights = observingHeightIndex(heightIndex, heightWork)
    const targetWork = { targetLookupVisits: 0 }
    const directPlan = planTranscriptWindow({
      blocks: followed.blocks,
      heights: observedHeights,
      viewportRows: 24,
      overscanRows: 24,
      attachment: { kind: "point", point, preferredScreenRow: 8 },
      diagnostics: targetWork,
    })
    const targetVisitBound = Math.ceil(Math.log2(fragments.length)) + 3
    const heightVisitBound = 12 * (Math.ceil(Math.log2(targetBlockCount)) + 1)
    assert(targetWork.targetLookupVisits <= targetVisitBound)
    assert(heightWork.nodeVisits <= heightVisitBound)
    assert(pointIsMaterialized(directPlan.blocks, point))
    assert(directPlan.blocks.length <= 48)
    const detachedTranscript = Object.freeze({ ...transcript, cursor: point,
      viewport: Object.freeze({ kind: "point" as const, point, preferredScreenRow: 8 }) })
    const detachedSnapshot: TranscriptFixtureSnapshot = Object.freeze({ ...snapshot, transcript: detachedTranscript })
    const beforeMove = { ...runtimeDiagnostics }
    let publications = 0
    const unsubscribe = runtime.subscribe(() => { publications++ })
    const revealed = timed(() => runtime.update(runtimeInput(fixture, detachedSnapshot, "detached", {
      presentationDamage: { kind: "view" },
      reveal: { id: targetBlockCount, point, reason: "jump" },
    })))
    unsubscribe()
    const moved = revealed.value
    oversizedCommandDetachedMountedCount ??= moved.window.blocks.length
    assert.equal(moved.blocks, followed.blocks)
    assert.equal(moved.window.blocks.length, oversizedCommandDetachedMountedCount)
    assert(moved.window.blocks.length <= 48)
    assert(pointIsMaterialized(moved.window.blocks, point))
    assert.equal(publications, 1)
    const delta = Object.fromEntries(Object.entries(runtimeDiagnostics)
      .map(([name, value]) => [name, value - beforeMove[name as keyof typeof beforeMove]])) as typeof runtimeDiagnostics
    assert.equal(delta.completePlanBuilds, 0)
    assert.equal(delta.completePlanBlockVisits, 0)
    assert.equal(delta.heightIndexBuilds, 0)
    assert.equal(delta.heightIndexBlockVisits, 0)
    assert.equal(delta.completeGeometryBlockVisits, 0)
    assert.equal(delta.orderIndexBuilds, 0)
    assert.equal(delta.orderIndexItemVisits, 0)
    assert(delta.windowGeometryBlockVisits <= 96)
    assert(delta.blockPlanWindowSliceItems <= 96)

    printResult({
      fixtureVersion: fixture.fixtureVersion,
      scenario: "oversized-command-production-fragments",
      materialization: "windowed-production",
      boundary: "runtime-plan-and-window",
      blockCount: targetBlockCount,
      historyBlockCount: fixture.blockCount,
      viewport: { width: primaryViewport.width, height: 24 },
      mode: "follow-to-detached-reveal",
      fixture: { contentShape: oversizedCommandFixture.shape, contentHash: oversizedCommandContentHash,
        fragmentPlanHash: benchmarkHash(fragments.map(block => `${blockKey(block)}:${"projection" in block ? `${block.sourceSpan.from}-${block.sourceSpan.to}` : ""}`).join("\n")),
        chars: oversizedCommandFixture.source.length,
        deterministicFixtureSegments: oversizedCommandFixture.segments.length, setupExcludedFromRevealTiming: true },
      operationCounts: {
        producedFragments: fragments.length,
        retainedFragmentIdentities: referenceFragments.filter((block, index) => block === fragments[index]).length,
        maxFragmentSourceUnits: Math.max(...fragments.map(block => "projection" in block ? block.sourceSpan.to - block.sourceSpan.from : 0)),
        completePlanBlocks: followed.blocks.length,
        followMountedBlocks: followed.window.blocks.length,
        detachedMountedBlocks: moved.window.blocks.length,
        publications,
        revealCompletePlanBuilds: delta.completePlanBuilds,
        revealCompletePlanBlockVisits: delta.completePlanBlockVisits,
        revealHeightIndexBuilds: delta.heightIndexBuilds,
        revealCompleteGeometryBlockVisits: delta.completeGeometryBlockVisits,
        revealWindowGeometryBlockVisits: delta.windowGeometryBlockVisits,
        revealWindowSliceItems: delta.blockPlanWindowSliceItems,
        targetLookupVisits: targetWork.targetLookupVisits,
        targetLookupVisitBound: targetVisitBound,
        plannerHeightNodeVisits: heightWork.nodeVisits,
        plannerHeightVisitBound: heightVisitBound,
        revealOrderIndexBuilds: delta.orderIndexBuilds,
        revealOrderIndexItemVisits: delta.orderIndexItemVisits,
        coldCompletePlanBuilds: runtimeDiagnostics.completePlanBuilds,
        coldCompletePlanBlockVisits: runtimeDiagnostics.completePlanBlockVisits,
        coldHeightIndexBuilds: runtimeDiagnostics.heightIndexBuilds,
        coldHeightIndexBlockVisits: runtimeDiagnostics.heightIndexBlockVisits,
        targetMaterialized: pointIsMaterialized(moved.window.blocks, point),
      },
      timingsMs: { coldRuntimePlan: Number(constructed.milliseconds.toFixed(6)),
        detachedMiddleReveal: Number(revealed.milliseconds.toFixed(6)) },
      samples: { warmup: 0, measured: 1 },
    })
  } finally {
    runtime.dispose()
  }
}

function boundedCanonicalIngressBaseline(fixture: ReturnType<typeof buildTranscriptScalingFixture>): void {
  forceGc()
  const before = fixture.before
  // Bulk fixture construction and disposable-index priming are explicit setup,
  // not part of steady-state ingress. Real incrementally-built states inherit
  // these indexes from their predecessor after every item projection.
  transcriptOrderIndex(before.transcript.order)
  transcriptTextLengthRange(before.transcript, 0, 0)
  primeTranscriptUrlIndex(before.transcript)

  const runtimeDiagnostics = createRuntimeDiagnostics()
  const runtime = new TranscriptRuntime(runtimeInput(fixture, before, "follow", { canonicalDamage: { kind: "full" } }), {
    windowPolicy: { viewportRows: 24, overscanRows: 24 }, diagnostics: runtimeDiagnostics,
  })
  try {
    const itemDiagnostics = createConversationItemDiagnostics()
    const syncDiagnostics = createRuntimeDiagnostics()
    const event = Object.freeze({ type: "item.delta" as const, threadId: fixture.threadId,
      itemId: fixture.tailItemId, delta: fixture.tailDelta })
    const reduced = timed(() => reduceConversationWithDiagnostics(before.conversation, event, itemDiagnostics))
    const changedItem = timed(() => conversationItemAt(reduced.value.items, fixture.tailItemId, itemDiagnostics))
    assert(changedItem.value)
    const projected = timed(() => syncTranscriptItem(before.transcript, changedItem.value!, syncDiagnostics))
    const snapshot = Object.freeze({ canonicalRevision: before.canonicalRevision + 1,
      conversation: reduced.value, transcript: projected.value })

    assert.equal(itemDiagnostics.conversationItemRecordNormalizations, 0)
    assert.equal(itemDiagnostics.conversationItemRecordNormalizationItemVisits, 0)
    assert.equal(itemDiagnostics.conversationItemRecordLookups, 2)
    assert.equal(itemDiagnostics.conversationItemRecordUpdates, 1)
    const logarithmicBound = Math.ceil(Math.log2(fixture.blockCount + 1)) + 1
    assert(itemDiagnostics.conversationItemRecordLookupNodeVisits <= 2 * logarithmicBound)
    assert(itemDiagnostics.conversationItemRecordNodeVisits <= logarithmicBound)
    assert(itemDiagnostics.conversationItemRecordNodesCopied <= 2 * logarithmicBound)

    assert.equal(syncDiagnostics.projectionRecordUpdates, 1)
    assert(syncDiagnostics.projectionRecordNodeVisits <= logarithmicBound)
    assert(syncDiagnostics.projectionRecordNodesCopied <= 2 * logarithmicBound)
    assert.equal(syncDiagnostics.textLengthIndexBuilds, 0)
    assert.equal(syncDiagnostics.textLengthItemVisits, 0)
    assert.equal(syncDiagnostics.textLengthIndexUpdates, 1)
    assert(syncDiagnostics.textLengthNodeVisits <= logarithmicBound)
    assert.equal(syncDiagnostics.urlIndexBuilds, 0)
    assert.equal(syncDiagnostics.urlIndexItemVisits, 0)
    assert.equal(syncDiagnostics.urlIndexUpdates, 1)
    assert(syncDiagnostics.urlIndexNodeVisits <= logarithmicBound)
    assert.equal(syncDiagnostics.orderIndexBuilds, 0)
    assert.equal(syncDiagnostics.orderIndexItemVisits, 0)

    let publications = 0
    const unsubscribe = runtime.subscribe(() => { publications++ })
    const beforeRuntime = { ...runtimeDiagnostics }
    const reconciled = timed(() => runtime.update(runtimeInput(fixture, snapshot, "follow", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
    })))
    unsubscribe()
    const runtimeCounts = Object.fromEntries(Object.entries(runtimeDiagnostics)
      .map(([name, value]) => [name, value - beforeRuntime[name as keyof typeof beforeRuntime]])) as typeof runtimeDiagnostics
    assert.equal(publications, 1)
    assert(reconciled.value.window.blocks.length <= 48)
    assert.equal(runtimeCounts.completePlanBuilds, 0)
    assert.equal(runtimeCounts.completePlanBlockVisits, 0)
    assert.equal(runtimeCounts.heightIndexBuilds, 0)
    assert.equal(runtimeCounts.heightIndexBlockVisits, 0)
    assert.equal(runtimeCounts.completeGeometryBlockVisits, 0)
    assert(runtimeCounts.blockPlanWindowSliceItems <= 48)
    assert(runtimeCounts.windowGeometryBlockVisits <= 48)

    // Exhaustive equivalence and identity checks are evidence outside timings
    // and deliberately run only after the measured ingress has settled.
    const reference = reduceConversationReference(before.conversation, event)
    assert.equal(JSON.stringify(reduced.value), JSON.stringify(reference))
    assert.equal(JSON.stringify(snapshot), JSON.stringify(fixture.afterTailDelta))
    assert.equal(projected.value.order, before.transcript.order)
    let preservedCanonicalItems = 0, preservedProjections = 0
    for (const id of before.transcript.order) {
      if (id === fixture.tailItemId) continue
      if (snapshot.conversation.items[id] === before.conversation.items[id]) preservedCanonicalItems++
      if (snapshot.transcript.projectionById[id] === before.transcript.projectionById[id]) preservedProjections++
    }
    assert.equal(preservedCanonicalItems, fixture.blockCount - 1)
    assert.equal(preservedProjections, fixture.blockCount - 1)

    printResult({
      scenario: "bounded-canonical-tail-ingress",
      materialization: "windowed-production",
      boundary: "canonical-reducer-semantic-projection-runtime-publication",
      blockCount: fixture.blockCount,
      viewport: { width: 80, height: 24 },
      mode: "follow",
      fixture: { contentShape: "one-running-tail-item", contentHash: fixture.contentHash, setupExcludedFromTiming: true,
        excludedSetup: "bulk canonical snapshot construction, cold persistent normalization, disposable-index priming, and exhaustive equivalence checks" },
      operationCounts: {
        completeBlocks: fixture.blockCount,
        mountedBlocks: reconciled.value.window.blocks.length,
        publications,
        preservedCanonicalItems,
        preservedProjections,
        canonicalItems: itemDiagnostics,
        semanticProjection: {
          projectionRecordUpdates: syncDiagnostics.projectionRecordUpdates,
          projectionRecordNodeVisits: syncDiagnostics.projectionRecordNodeVisits,
          projectionRecordNodesCopied: syncDiagnostics.projectionRecordNodesCopied,
          textLengthIndexBuilds: syncDiagnostics.textLengthIndexBuilds,
          textLengthItemVisits: syncDiagnostics.textLengthItemVisits,
          textLengthIndexUpdates: syncDiagnostics.textLengthIndexUpdates,
          textLengthNodeVisits: syncDiagnostics.textLengthNodeVisits,
          urlIndexBuilds: syncDiagnostics.urlIndexBuilds,
          urlIndexItemVisits: syncDiagnostics.urlIndexItemVisits,
          urlIndexUpdates: syncDiagnostics.urlIndexUpdates,
          urlIndexNodeVisits: syncDiagnostics.urlIndexNodeVisits,
          orderIndexBuilds: syncDiagnostics.orderIndexBuilds,
          orderIndexItemVisits: syncDiagnostics.orderIndexItemVisits,
        },
        runtime: runtimeCounts,
      },
      timingsMs: {
        canonicalReduction: Number(reduced.milliseconds.toFixed(6)),
        changedItemLookup: Number(changedItem.milliseconds.toFixed(6)),
        semanticProjection: Number(projected.milliseconds.toFixed(6)),
        runtimeReconciliation: Number(reconciled.milliseconds.toFixed(6)),
        completeIngressSettlement: Number((reduced.milliseconds + changedItem.milliseconds + projected.milliseconds + reconciled.milliseconds).toFixed(6)),
      },
      samples: { warmup: 0, measured: 1 },
    })

  } finally { runtime.dispose() }
}

function boundedFollowRuntimeBaseline(fixture: ReturnType<typeof buildTranscriptScalingFixture>): void {
  forceGc()
  const diagnostics = createRuntimeDiagnostics()
  const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", { canonicalDamage: { kind: "full" } }), {
    windowPolicy: { viewportRows: 24, overscanRows: 24 }, diagnostics,
  })
  try {
    let publications = 0
    const unsubscribe = runtime.subscribe(() => { publications++ })
    const beforeFollow = { ...diagnostics }
    const followed = timed(() => runtime.update(runtimeInput(fixture, fixture.afterTailDelta, "follow", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
    })))
    assert.equal(publications, 1)
    assert(followed.value.window.blocks.length <= 48)
    const followCounts = {
      completePlanBuilds: diagnostics.completePlanBuilds - beforeFollow.completePlanBuilds,
      completePlanBlockVisits: diagnostics.completePlanBlockVisits - beforeFollow.completePlanBlockVisits,
      projectionRecordUpdates: diagnostics.projectionRecordUpdates - beforeFollow.projectionRecordUpdates,
      projectionRecordNodeVisits: diagnostics.projectionRecordNodeVisits - beforeFollow.projectionRecordNodeVisits,
      projectionRecordNodesCopied: diagnostics.projectionRecordNodesCopied - beforeFollow.projectionRecordNodesCopied,
      blockPlanUpdates: diagnostics.blockPlanUpdates - beforeFollow.blockPlanUpdates,
      blockPlanNodeVisits: diagnostics.blockPlanNodeVisits - beforeFollow.blockPlanNodeVisits,
      blockPlanNodesCopied: diagnostics.blockPlanNodesCopied - beforeFollow.blockPlanNodesCopied,
      blockPlanWindowSliceItems: diagnostics.blockPlanWindowSliceItems - beforeFollow.blockPlanWindowSliceItems,
      heightIndexBuilds: diagnostics.heightIndexBuilds - beforeFollow.heightIndexBuilds,
      heightIndexBlockVisits: diagnostics.heightIndexBlockVisits - beforeFollow.heightIndexBlockVisits,
      heightIndexUpdates: diagnostics.heightIndexUpdates - beforeFollow.heightIndexUpdates,
      heightIndexNodeVisits: diagnostics.heightIndexNodeVisits - beforeFollow.heightIndexNodeVisits,
      heightIndexNodesCopied: diagnostics.heightIndexNodesCopied - beforeFollow.heightIndexNodesCopied,
      completeGeometryBlockVisits: diagnostics.completeGeometryBlockVisits - beforeFollow.completeGeometryBlockVisits,
      windowGeometryBlockVisits: diagnostics.windowGeometryBlockVisits - beforeFollow.windowGeometryBlockVisits,
      changedItemBuilds: diagnostics.changedItemBuilds - beforeFollow.changedItemBuilds,
    }
    assert.equal(followCounts.completePlanBuilds, 0)
    assert.equal(followCounts.completePlanBlockVisits, 0)
    assert.equal(followCounts.projectionRecordUpdates, 1)
    assert.equal(followCounts.changedItemBuilds, 1)
    assert.equal(followCounts.blockPlanUpdates, 1)
    assert.equal(followCounts.heightIndexBuilds, 0)
    assert.equal(followCounts.heightIndexBlockVisits, 0)
    assert.equal(followCounts.heightIndexUpdates, 1)
    assert.equal(followCounts.completeGeometryBlockVisits, 0)
    assert(followCounts.projectionRecordNodeVisits <= 2 * Math.ceil(Math.log2(fixture.blockCount + 1)) + 1)
    assert(followCounts.projectionRecordNodesCopied > 0)
    assert(followCounts.projectionRecordNodesCopied <= 2 * Math.ceil(Math.log2(fixture.blockCount + 1)) + 1)
    assert(followCounts.blockPlanNodeVisits <= 2 * (Math.ceil(Math.log2(fixture.blockCount)) + 1))
    assert(followCounts.blockPlanNodesCopied > 0)
    assert(followCounts.blockPlanNodesCopied <= Math.ceil(Math.log2(fixture.blockCount)) + 1)
    assert(followCounts.heightIndexNodeVisits <= Math.ceil(Math.log2(fixture.blockCount)) + 1)
    assert(followCounts.heightIndexNodesCopied <= Math.ceil(Math.log2(fixture.blockCount)) + 1)
    assert(followCounts.windowGeometryBlockVisits <= 48)
    assert(followCounts.blockPlanWindowSliceItems <= 48)

    const anchor = Object.freeze({ itemId: fixture.targets.quarter, graphemeOffset: 0 })
    const detachedTranscript = Object.freeze({
      ...fixture.afterTailDelta.transcript,
      cursor: anchor,
      viewport: Object.freeze({ kind: "point" as const, point: anchor, preferredScreenRow: 5 }),
    })
    const detachedSnapshot = Object.freeze({ ...fixture.afterTailDelta, transcript: detachedTranscript })
    runtime.update(runtimeInput(fixture, detachedSnapshot, "detached", { presentationDamage: { kind: "view" } }))
    const pinned = runtime.getSnapshot()
    const hidden = appendTranscriptScalingTail(detachedSnapshot, fixture.tailItemId, fixture.tailDelta)
    publications = 0
    assert.equal(runtime.update(runtimeInput(fixture, hidden, "detached", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
    })), pinned)
    const detachedHiddenPublications = publications
    assert.equal(detachedHiddenPublications, 0)
    const latest = Object.freeze({ ...hidden, transcript: Object.freeze({
      ...hidden.transcript, viewport: Object.freeze({ kind: "tail" as const }), unseenEntries: 0, unseenItemIds: Object.freeze([]),
    }) })
    publications = 0
    const beforeReattach = { ...diagnostics }
    const reattached = timed(() => runtime.update(runtimeInput(fixture, latest, "follow", { presentationDamage: { kind: "view" } })))
    const reattachCounts = {
      completePlanBuilds: diagnostics.completePlanBuilds - beforeReattach.completePlanBuilds,
      completePlanBlockVisits: diagnostics.completePlanBlockVisits - beforeReattach.completePlanBlockVisits,
      projectionRecordUpdates: diagnostics.projectionRecordUpdates - beforeReattach.projectionRecordUpdates,
      projectionRecordNodeVisits: diagnostics.projectionRecordNodeVisits - beforeReattach.projectionRecordNodeVisits,
      projectionRecordNodesCopied: diagnostics.projectionRecordNodesCopied - beforeReattach.projectionRecordNodesCopied,
      blockPlanUpdates: diagnostics.blockPlanUpdates - beforeReattach.blockPlanUpdates,
      blockPlanNodeVisits: diagnostics.blockPlanNodeVisits - beforeReattach.blockPlanNodeVisits,
      blockPlanNodesCopied: diagnostics.blockPlanNodesCopied - beforeReattach.blockPlanNodesCopied,
      blockPlanWindowSliceItems: diagnostics.blockPlanWindowSliceItems - beforeReattach.blockPlanWindowSliceItems,
      heightIndexBuilds: diagnostics.heightIndexBuilds - beforeReattach.heightIndexBuilds,
      heightIndexBlockVisits: diagnostics.heightIndexBlockVisits - beforeReattach.heightIndexBlockVisits,
      heightIndexUpdates: diagnostics.heightIndexUpdates - beforeReattach.heightIndexUpdates,
      heightIndexNodeVisits: diagnostics.heightIndexNodeVisits - beforeReattach.heightIndexNodeVisits,
      heightIndexNodesCopied: diagnostics.heightIndexNodesCopied - beforeReattach.heightIndexNodesCopied,
      completeGeometryBlockVisits: diagnostics.completeGeometryBlockVisits - beforeReattach.completeGeometryBlockVisits,
      windowGeometryBlockVisits: diagnostics.windowGeometryBlockVisits - beforeReattach.windowGeometryBlockVisits,
      changedItemBuilds: diagnostics.changedItemBuilds - beforeReattach.changedItemBuilds,
    }
    assert.equal(publications, 1)
    assert.equal(reattached.value.displayedCanonicalRevision, latest.canonicalRevision)
    assert.equal(reattached.value.window.bottomSpacerRows, 0)
    assert(reattached.value.window.blocks.length <= 48)
    assert.equal(reattachCounts.completePlanBuilds, 0)
    assert.equal(reattachCounts.completePlanBlockVisits, 0)
    assert.equal(reattachCounts.heightIndexBuilds, 0)
    assert.equal(reattachCounts.heightIndexBlockVisits, 0)
    assert.equal(reattachCounts.heightIndexUpdates, 1)
    assert.equal(reattachCounts.changedItemBuilds, 1)
    assert.equal(reattachCounts.completeGeometryBlockVisits, 0)
    assert(reattachCounts.projectionRecordNodeVisits <= 2 * Math.ceil(Math.log2(fixture.blockCount + 1)) + 1)
    assert(reattachCounts.projectionRecordNodesCopied > 0)
    assert(reattachCounts.projectionRecordNodesCopied <= 2 * Math.ceil(Math.log2(fixture.blockCount + 1)) + 1)
    assert(reattachCounts.blockPlanNodeVisits <= 2 * (Math.ceil(Math.log2(fixture.blockCount)) + 1))
    assert(reattachCounts.blockPlanNodesCopied > 0)
    assert(reattachCounts.blockPlanNodesCopied <= Math.ceil(Math.log2(fixture.blockCount)) + 1)
    assert(reattachCounts.heightIndexNodeVisits <= Math.ceil(Math.log2(fixture.blockCount)) + 1)
    assert(reattachCounts.heightIndexNodesCopied <= Math.ceil(Math.log2(fixture.blockCount)) + 1)
    assert(reattachCounts.windowGeometryBlockVisits <= 48)
    assert(reattachCounts.blockPlanWindowSliceItems <= 48)
    unsubscribe()

    printResult({
      scenario: "bounded-follow-and-reattach-runtime",
      materialization: "windowed-production",
      boundary: "runtime-index-window-geometry-publication",
      blockCount: fixture.blockCount,
      viewport: { width: 80, height: 24 },
      mode: "follow-and-detached",
      fixture: { contentShape: "mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: true,
        excludedSetup: "canonical snapshot construction, cold persistent-plan normalization, and full-rebuild fallback" },
      operationCounts: {
        completeBlocks: fixture.blockCount,
        mountedBlocksAfterFollow: followed.value.window.blocks.length,
        mountedBlocksAfterReattach: reattached.value.window.blocks.length,
        followPublications: 1,
        detachedHiddenPublications,
        reattachPublications: publications,
        follow: followCounts,
        reattach: reattachCounts,
      },
      timingsMs: { followReconciliation: Number(followed.milliseconds.toFixed(6)), reattachReconciliation: Number(reattached.milliseconds.toFixed(6)) },
      samples: { warmup: 0, measured: 1 },
    })
  } finally { runtime.dispose() }
}

function structuralTailAdmissionBaseline(fixture: ReturnType<typeof buildTranscriptStructuralScalingFixture>): void {
  forceGc()
  const before = fixture.before
  transcriptOrderIndex(before.transcript.order)
  transcriptTextLengthRange(before.transcript, 0, 0)
  primeTranscriptUrlIndex(before.transcript)
  const runtimeDiagnostics = createRuntimeDiagnostics()
  const runtime = new TranscriptRuntime(runtimeInput(fixture, before, "follow", {
    canonicalDamage: { kind: "full" },
  }), { windowPolicy: { viewportRows: 24, overscanRows: 24 }, diagnostics: runtimeDiagnostics })
  try {
    const initial = runtime.getSnapshot()
    const runtimeBefore = { ...runtimeDiagnostics }
    const canonicalDiagnostics = createConversationReductionDiagnostics()
    const semanticDiagnostics = createTranscriptItemSyncDiagnostics()
    let publications = 0
    const stop = runtime.subscribe(() => { publications++ })
    const turnEvent = Object.freeze({
      type: "turn.started" as const, threadId: fixture.threadId, turnId: fixture.nextTurnId,
    })
    const item = Object.freeze({
      id: fixture.nextItemId, turnId: fixture.nextTurnId, kind: "assistant" as const,
      markdown: "New structural tail block.", status: "running" as const,
    })
    const itemEvent = Object.freeze({ type: "item.started" as const, threadId: fixture.threadId, item })
    const settlementStarted = performance.now()
    const turnReduction = timed(() => reduceConversationWithDiagnostics(before.conversation, turnEvent, canonicalDiagnostics))
    const afterTurn: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: before.canonicalRevision + 1,
      conversation: turnReduction.value,
      transcript: before.transcript,
    })
    const emptyTurnRuntime = timed(() => runtime.update(runtimeInput(fixture, afterTurn, "follow", {
      canonicalDamage: { kind: "blocks", itemIds: [] },
    })))
    const itemReduction = timed(() => reduceConversationWithDiagnostics(afterTurn.conversation, itemEvent, canonicalDiagnostics))
    const semanticProjection = timed(() => syncTranscriptItem(afterTurn.transcript, item, semanticDiagnostics))
    const afterItem: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: afterTurn.canonicalRevision + 1,
      conversation: itemReduction.value,
      transcript: semanticProjection.value,
    })
    const itemRuntime = timed(() => runtime.update(runtimeInput(fixture, afterItem, "follow", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.nextItemId] },
    })))
    const completeSettlementMs = performance.now() - settlementStarted
    stop()

    const referenceConversation = reduceConversationReference(
      reduceConversationReference(before.conversation, turnEvent), itemEvent)
    // Node's deep equality inspects Proxy-backed array/record targets rather
    // than their reflective view. Compare their public serialized shape, as
    // the conversation equivalence tests do, while retaining identity checks
    // below for the persistent structures themselves.
    assert.deepEqual(
      JSON.parse(JSON.stringify(afterItem.conversation)),
      JSON.parse(JSON.stringify(referenceConversation)),
    )
    const reference = createTranscriptFrame(runtimeInput(fixture, afterItem, "follow", {
      canonicalDamage: { kind: "full" },
    }))
    assert.deepEqual(itemRuntime.value.blocks.map(blockKey), reference.blocks.map(blockKey))
    assert.equal(emptyTurnRuntime.value.blocks, initial.blocks)
    assert.equal(emptyTurnRuntime.value.window, initial.window)
    assert.equal(emptyTurnRuntime.value.geometry, initial.geometry)
    assert.equal(emptyTurnRuntime.value.transcript, initial.transcript)
    assert(itemRuntime.value.window.blocks.length <= 48)
    assert.equal(publications, 2)

    let preservedItems = 0, preservedTurns = 0, preservedProjections = 0, preservedBlocks = 0
    for (let index = 0; index < fixture.blockCount; index++) {
      const itemId = before.transcript.order[index]!
      const turnId = before.conversation.turnIds[index]!
      if (afterItem.conversation.items[itemId] === before.conversation.items[itemId]) preservedItems++
      if (afterItem.conversation.turns[turnId] === before.conversation.turns[turnId]) preservedTurns++
      if (afterItem.transcript.projectionById[itemId] === before.transcript.projectionById[itemId]) preservedProjections++
      if (itemRuntime.value.blocks[index] === initial.blocks[index]) preservedBlocks++
    }
    assert.equal(preservedItems, fixture.blockCount)
    assert.equal(preservedTurns, fixture.blockCount)
    assert.equal(preservedProjections, fixture.blockCount)
    assert.equal(preservedBlocks, fixture.blockCount)

    transcriptTextLengthRange(itemRuntime.value.transcript, 0, itemRuntime.value.transcript.order.length, runtimeDiagnostics)
    primeTranscriptUrlIndex(itemRuntime.value.transcript, runtimeDiagnostics)
    const runtimeCounts = {
      completePlanBuilds: runtimeDiagnostics.completePlanBuilds - runtimeBefore.completePlanBuilds,
      completePlanBlockVisits: runtimeDiagnostics.completePlanBlockVisits - runtimeBefore.completePlanBlockVisits,
      orderIndexBuilds: runtimeDiagnostics.orderIndexBuilds - runtimeBefore.orderIndexBuilds,
      orderIndexItemVisits: runtimeDiagnostics.orderIndexItemVisits - runtimeBefore.orderIndexItemVisits,
      heightIndexBuilds: runtimeDiagnostics.heightIndexBuilds - runtimeBefore.heightIndexBuilds,
      heightIndexBlockVisits: runtimeDiagnostics.heightIndexBlockVisits - runtimeBefore.heightIndexBlockVisits,
      completeGeometryBlockVisits: runtimeDiagnostics.completeGeometryBlockVisits - runtimeBefore.completeGeometryBlockVisits,
      blockPlanUpdates: runtimeDiagnostics.blockPlanUpdates - runtimeBefore.blockPlanUpdates,
      blockPlanNodeVisits: runtimeDiagnostics.blockPlanNodeVisits - runtimeBefore.blockPlanNodeVisits,
      blockPlanNodesCopied: runtimeDiagnostics.blockPlanNodesCopied - runtimeBefore.blockPlanNodesCopied,
      heightIndexUpdates: runtimeDiagnostics.heightIndexUpdates - runtimeBefore.heightIndexUpdates,
      heightIndexNodeVisits: runtimeDiagnostics.heightIndexNodeVisits - runtimeBefore.heightIndexNodeVisits,
      heightIndexNodesCopied: runtimeDiagnostics.heightIndexNodesCopied - runtimeBefore.heightIndexNodesCopied,
      windowGeometryBlockVisits: runtimeDiagnostics.windowGeometryBlockVisits - runtimeBefore.windowGeometryBlockVisits,
      blockPlanWindowSliceItems: runtimeDiagnostics.blockPlanWindowSliceItems - runtimeBefore.blockPlanWindowSliceItems,
      changedItemBuilds: runtimeDiagnostics.changedItemBuilds - runtimeBefore.changedItemBuilds,
      textLengthIndexBuilds: runtimeDiagnostics.textLengthIndexBuilds - runtimeBefore.textLengthIndexBuilds,
      textLengthItemVisits: runtimeDiagnostics.textLengthItemVisits - runtimeBefore.textLengthItemVisits,
      textLengthIndexUpdates: runtimeDiagnostics.textLengthIndexUpdates - runtimeBefore.textLengthIndexUpdates,
      urlIndexBuilds: runtimeDiagnostics.urlIndexBuilds - runtimeBefore.urlIndexBuilds,
      urlIndexItemVisits: runtimeDiagnostics.urlIndexItemVisits - runtimeBefore.urlIndexItemVisits,
      urlIndexUpdates: runtimeDiagnostics.urlIndexUpdates - runtimeBefore.urlIndexUpdates,
    }
    assert.equal(runtimeCounts.completePlanBuilds, 0)
    assert.equal(runtimeCounts.completePlanBlockVisits, 0)
    assert.equal(runtimeCounts.orderIndexBuilds, 0)
    assert.equal(runtimeCounts.orderIndexItemVisits, 0)
    assert.equal(runtimeCounts.heightIndexBuilds, 0)
    assert.equal(runtimeCounts.heightIndexBlockVisits, 0)
    assert.equal(runtimeCounts.completeGeometryBlockVisits, 0)
    assert.equal(runtimeCounts.blockPlanUpdates, 1)
    assert.equal(runtimeCounts.heightIndexUpdates, 1)
    assert.equal(runtimeCounts.textLengthIndexBuilds, 0)
    assert.equal(runtimeCounts.textLengthItemVisits, 0)
    assert.equal(runtimeCounts.textLengthIndexUpdates, 1)
    assert.equal(runtimeCounts.urlIndexBuilds, 0)
    assert.equal(runtimeCounts.urlIndexItemVisits, 0)
    assert.equal(runtimeCounts.urlIndexUpdates, 1)
    assert(runtimeCounts.windowGeometryBlockVisits <= 48)
    assert(runtimeCounts.blockPlanWindowSliceItems <= 48)
    assert.equal(semanticDiagnostics.orderIndexBuilds, 0)
    assert.equal(semanticDiagnostics.orderIndexItemVisits, 0)
    assert.equal(semanticDiagnostics.textLengthIndexBuilds, 0)
    assert.equal(semanticDiagnostics.textLengthItemVisits, 0)
    assert.equal(semanticDiagnostics.urlIndexBuilds, 0)
    assert.equal(semanticDiagnostics.urlIndexItemVisits, 0)
    assert.equal(canonicalDiagnostics.conversationTurnIdSequenceNormalizations, 0)
    assert.equal(canonicalDiagnostics.conversationTurnRecordNormalizations, 0)
    assert.equal(canonicalDiagnostics.conversationTurnItemIdSequenceNormalizations, 0)
    assert.equal(canonicalDiagnostics.conversationItemRecordNormalizations, 0)

    printResult({
      fixtureVersion: fixture.fixtureVersion,
      scenario: "structural-tail-admission",
      materialization: "windowed-production",
      boundary: "canonical-structure-semantic-projection-runtime-window-publication",
      blockCount: fixture.blockCount,
      viewport: { width: 80, height: 24 },
      mode: "follow",
      fixture: { contentShape: "one-semantic-item-per-turn", contentHash: fixture.contentHash, setupExcludedFromTiming: true,
        excludedSetup: "bulk canonical snapshot construction, cold persistent normalization, disposable-index priming, full references, and exhaustive identity checks" },
      operationCounts: {
        completeBlocksBefore: fixture.blockCount,
        completeBlocksAfter: itemRuntime.value.blocks.length,
        mountedBlocksAfter: itemRuntime.value.window.blocks.length,
        publications,
        preservedItems,
        preservedTurns,
        preservedProjections,
        preservedBlocks,
        canonical: canonicalDiagnostics,
        semantic: semanticDiagnostics,
        runtime: runtimeCounts,
      },
      timingsMs: {
        emptyTurnCanonicalReduction: Number(turnReduction.milliseconds.toFixed(6)),
        emptyTurnRuntimeAdvance: Number(emptyTurnRuntime.milliseconds.toFixed(6)),
        itemCanonicalReduction: Number(itemReduction.milliseconds.toFixed(6)),
        itemSemanticProjection: Number(semanticProjection.milliseconds.toFixed(6)),
        itemRuntimeAppend: Number(itemRuntime.milliseconds.toFixed(6)),
        completeTwoEventSettlement: Number(completeSettlementMs.toFixed(6)),
      },
      samples: { warmup: 0, measured: 1 },
    })
  } finally { runtime.dispose() }
}

function tailTurnCompletionBaseline(fixture: ReturnType<typeof buildTranscriptStructuralScalingFixture>): void {
  forceGc()
  transcriptOrderIndex(fixture.before.transcript.order)
  transcriptTextLengthRange(fixture.before.transcript, 0, 0)
  primeTranscriptUrlIndex(fixture.before.transcript)
  const runtimeDiagnostics = createRuntimeDiagnostics()
  const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", {
    canonicalDamage: { kind: "full" },
  }), { windowPolicy: { viewportRows: 24, overscanRows: 24 }, diagnostics: runtimeDiagnostics })
  try {
    const runningItem = Object.freeze({
      id: fixture.nextItemId, turnId: fixture.nextTurnId, kind: "assistant" as const,
      markdown: "Terminal structural tail block.", status: "running" as const,
    })
    const withTurn = reduceConversationWithDiagnostics(fixture.before.conversation, {
      type: "turn.started", threadId: fixture.threadId, turnId: fixture.nextTurnId,
    }, createConversationReductionDiagnostics())
    const withItem = reduceConversationWithDiagnostics(withTurn, {
      type: "item.started", threadId: fixture.threadId, item: runningItem,
    }, createConversationReductionDiagnostics())
    const runningTranscript = syncTranscriptItem(fixture.before.transcript, runningItem)
    const runningSnapshot: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: fixture.before.canonicalRevision + 2,
      conversation: withItem,
      transcript: runningTranscript,
    })
    runtime.update(runtimeInput(fixture, runningSnapshot, "follow", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.nextItemId] },
    }))
    const beforeCompletion = runtime.getSnapshot()
    const runtimeBefore = { ...runtimeDiagnostics }
    const canonicalDiagnostics = createConversationReductionDiagnostics()
    const event = Object.freeze({
      type: "turn.completed" as const, threadId: fixture.threadId, turnId: fixture.nextTurnId,
      outcome: "complete" as const, durationMs: 0,
    })
    const damage = timed(() => incrementalConversationEventDamage(withItem, event))
    assert.deepEqual(damage.value, { kind: "blocks", itemIds: [] })
    const reduction = timed(() => reduceConversationWithDiagnostics(withItem, event, canonicalDiagnostics))
    const completedSnapshot: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: runningSnapshot.canonicalRevision + 1,
      conversation: reduction.value,
      transcript: runningTranscript,
    })
    let publications = 0
    const stop = runtime.subscribe(() => { publications++ })
    const reconciled = timed(() => runtime.update(runtimeInput(fixture, completedSnapshot, "follow", {
      canonicalDamage: damage.value!,
    })))
    stop()
    const reference = createTranscriptFrame(runtimeInput(fixture, completedSnapshot, "follow", {
      canonicalDamage: { kind: "full" },
    }))
    assert.deepEqual(reconciled.value.blocks.map(blockKey), reference.blocks.map(blockKey))
    assert.equal(reconciled.value.blocks.length, fixture.blockCount + 2)
    assert(reconciled.value.window.blocks.length <= 48)
    assert.equal(reconciled.value.transcript, beforeCompletion.transcript)
    for (let index = 0; index < fixture.blockCount; index++) {
      assert.equal(reconciled.value.blocks[index], beforeCompletion.blocks[index])
    }
    assert.notEqual(reconciled.value.blocks[fixture.blockCount], beforeCompletion.blocks[fixture.blockCount])
    assert.deepEqual(reconciled.value.blocks.at(-1)?.key,
      { kind: "turn-activity", turnId: fixture.nextTurnId })
    assert.deepEqual(reconciled.value.blocks[fixture.blockCount], reference.blocks[fixture.blockCount])
    assert.deepEqual(reconciled.value.blocks.at(-1), reference.blocks.at(-1))

    const runtimeCounts = {
      completePlanBuilds: runtimeDiagnostics.completePlanBuilds - runtimeBefore.completePlanBuilds,
      completePlanBlockVisits: runtimeDiagnostics.completePlanBlockVisits - runtimeBefore.completePlanBlockVisits,
      orderIndexBuilds: runtimeDiagnostics.orderIndexBuilds - runtimeBefore.orderIndexBuilds,
      orderIndexItemVisits: runtimeDiagnostics.orderIndexItemVisits - runtimeBefore.orderIndexItemVisits,
      heightIndexBuilds: runtimeDiagnostics.heightIndexBuilds - runtimeBefore.heightIndexBuilds,
      heightIndexBlockVisits: runtimeDiagnostics.heightIndexBlockVisits - runtimeBefore.heightIndexBlockVisits,
      completeGeometryBlockVisits: runtimeDiagnostics.completeGeometryBlockVisits - runtimeBefore.completeGeometryBlockVisits,
      blockPlanUpdates: runtimeDiagnostics.blockPlanUpdates - runtimeBefore.blockPlanUpdates,
      blockPlanNodeVisits: runtimeDiagnostics.blockPlanNodeVisits - runtimeBefore.blockPlanNodeVisits,
      blockPlanNodesCopied: runtimeDiagnostics.blockPlanNodesCopied - runtimeBefore.blockPlanNodesCopied,
      heightIndexUpdates: runtimeDiagnostics.heightIndexUpdates - runtimeBefore.heightIndexUpdates,
      heightIndexNodeVisits: runtimeDiagnostics.heightIndexNodeVisits - runtimeBefore.heightIndexNodeVisits,
      heightIndexNodesCopied: runtimeDiagnostics.heightIndexNodesCopied - runtimeBefore.heightIndexNodesCopied,
      windowGeometryBlockVisits: runtimeDiagnostics.windowGeometryBlockVisits - runtimeBefore.windowGeometryBlockVisits,
      blockPlanWindowSliceItems: runtimeDiagnostics.blockPlanWindowSliceItems - runtimeBefore.blockPlanWindowSliceItems,
      changedItemBuilds: runtimeDiagnostics.changedItemBuilds - runtimeBefore.changedItemBuilds,
      textLengthIndexBuilds: runtimeDiagnostics.textLengthIndexBuilds - runtimeBefore.textLengthIndexBuilds,
      textLengthItemVisits: runtimeDiagnostics.textLengthItemVisits - runtimeBefore.textLengthItemVisits,
      textLengthIndexUpdates: runtimeDiagnostics.textLengthIndexUpdates - runtimeBefore.textLengthIndexUpdates,
      urlIndexBuilds: runtimeDiagnostics.urlIndexBuilds - runtimeBefore.urlIndexBuilds,
      urlIndexItemVisits: runtimeDiagnostics.urlIndexItemVisits - runtimeBefore.urlIndexItemVisits,
      urlIndexUpdates: runtimeDiagnostics.urlIndexUpdates - runtimeBefore.urlIndexUpdates,
    }
    assert.equal(publications, 1)
    assert.equal(runtimeCounts.completePlanBuilds, 0)
    assert.equal(runtimeCounts.completePlanBlockVisits, 0)
    assert.equal(runtimeCounts.orderIndexBuilds, 0)
    assert.equal(runtimeCounts.orderIndexItemVisits, 0)
    assert.equal(runtimeCounts.heightIndexBuilds, 0)
    assert.equal(runtimeCounts.heightIndexBlockVisits, 0)
    assert.equal(runtimeCounts.completeGeometryBlockVisits, 0)
    assert.equal(runtimeCounts.blockPlanUpdates, 2)
    const logarithmicBound = 12 * (Math.ceil(Math.log2(fixture.blockCount + 2)) + 1)
    assert(runtimeCounts.blockPlanNodeVisits <= logarithmicBound)
    assert(runtimeCounts.blockPlanNodesCopied <= logarithmicBound)
    assert.equal(runtimeCounts.heightIndexUpdates, 2)
    assert(runtimeCounts.heightIndexNodeVisits <= logarithmicBound)
    assert(runtimeCounts.heightIndexNodesCopied <= logarithmicBound)
    assert.equal(runtimeCounts.changedItemBuilds, 1)
    assert.equal(runtimeCounts.textLengthIndexBuilds, 0)
    assert.equal(runtimeCounts.textLengthItemVisits, 0)
    assert.equal(runtimeCounts.textLengthIndexUpdates, 0)
    assert.equal(runtimeCounts.urlIndexBuilds, 0)
    assert.equal(runtimeCounts.urlIndexItemVisits, 0)
    assert.equal(runtimeCounts.urlIndexUpdates, 0)
    assert(runtimeCounts.windowGeometryBlockVisits <= 48)
    assert(runtimeCounts.blockPlanWindowSliceItems <= 48)

    printResult({
      fixtureVersion: fixture.fixtureVersion,
      scenario: "tail-turn-completion-activity",
      materialization: "windowed-production",
      boundary: "workbench-damage-canonical-turn-runtime-window-publication",
      blockCount: fixture.blockCount,
      viewport: { width: 80, height: 24 },
      mode: "follow",
      fixture: { contentShape: "one-semantic-item-per-turn-plus-one-running-tail", contentHash: fixture.contentHash,
        setupExcludedFromTiming: true, excludedSetup: "bulk fixture construction, tail admission, cold indexes, full reference, and identity audit" },
      operationCounts: {
        completeBlocksBefore: beforeCompletion.blocks.length,
        completeBlocksAfter: reconciled.value.blocks.length,
        mountedBlocksAfter: reconciled.value.window.blocks.length,
        publications,
        preservedHistoricalBlocks: fixture.blockCount,
        workbenchDamageSelectionGate: "exact-result; timing diagnostic only",
        canonical: canonicalDiagnostics,
        runtime: runtimeCounts,
      },
      timingsMs: {
        diagnosticWorkbenchDamageSelection: Number(damage.milliseconds.toFixed(6)),
        canonicalTurnReduction: Number(reduction.milliseconds.toFixed(6)),
        runtimeActivityReconciliation: Number(reconciled.milliseconds.toFixed(6)),
      },
      samples: { warmup: 0, measured: 1 },
    })
  } finally { runtime.dispose() }
}

function detachedUnseenAccumulationBaseline(fixture: ReturnType<typeof buildTranscriptStructuralScalingFixture>): void {
  forceGc()
  const anchorItemId = fixture.before.transcript.order[0]!
  const unseenItemIds = persistentTranscriptUnseenItemIds(fixture.before.transcript.order)
  const detachedTranscript = Object.freeze({
    ...fixture.before.transcript,
    cursor: Object.freeze({ itemId: anchorItemId, graphemeOffset: 0 }),
    viewport: Object.freeze({ kind: "point" as const,
      point: Object.freeze({ itemId: anchorItemId, graphemeOffset: 0 }), preferredScreenRow: 7 }),
    unseenEntries: fixture.blockCount,
    unseenItemIds,
  })
  const detachedSnapshot: TranscriptFixtureSnapshot = Object.freeze({ ...fixture.before, transcript: detachedTranscript })
  transcriptTextLengthRange(detachedTranscript, 0, 0)
  primeTranscriptUrlIndex(detachedTranscript)
  const runtimeDiagnostics = createRuntimeDiagnostics()
  const runtime = new TranscriptRuntime(runtimeInput(fixture, detachedSnapshot, "detached", {
    canonicalDamage: { kind: "full" },
  }), { windowPolicy: { viewportRows: 24, overscanRows: 24 }, diagnostics: runtimeDiagnostics })
  try {
    const pinned = runtime.getSnapshot()
    const hiddenDamageBacklog = Array.from({ length: fixture.blockCount }, (_, index) =>
      itemId(`detached-hidden-damage-${fixture.blockCount}-${index}`))
    const seededSnapshot: TranscriptFixtureSnapshot = Object.freeze({
      ...detachedSnapshot,
      canonicalRevision: detachedSnapshot.canonicalRevision + 1,
    })
    const runtimeBeforeSeed = { ...runtimeDiagnostics }
    assert.equal(runtime.update(runtimeInput(fixture, seededSnapshot, "detached", {
      canonicalDamage: { kind: "blocks", itemIds: hiddenDamageBacklog },
    })), pinned)
    const hiddenDamageSeed = {
      merges: runtimeDiagnostics.hiddenDamageMerges! - (runtimeBeforeSeed.hiddenDamageMerges ?? 0),
      inputItemVisits: runtimeDiagnostics.hiddenDamageInputItemVisits! - (runtimeBeforeSeed.hiddenDamageInputItemVisits ?? 0),
      itemAdditions: runtimeDiagnostics.hiddenDamageItemAdditions! - (runtimeBeforeSeed.hiddenDamageItemAdditions ?? 0),
      snapshots: runtimeDiagnostics.hiddenDamageSnapshots! - (runtimeBeforeSeed.hiddenDamageSnapshots ?? 0),
      snapshotItemVisits: runtimeDiagnostics.hiddenDamageSnapshotItemVisits! - (runtimeBeforeSeed.hiddenDamageSnapshotItemVisits ?? 0),
    }
    assert.deepEqual(hiddenDamageSeed, {
      merges: 1, inputItemVisits: hiddenDamageBacklog.length, itemAdditions: hiddenDamageBacklog.length,
      snapshots: 0, snapshotItemVisits: 0,
    })
    const runtimeBefore = { ...runtimeDiagnostics }
    const canonicalDiagnostics = createConversationReductionDiagnostics()
    const semanticDiagnostics = createTranscriptItemSyncDiagnostics()
    let publications = 0
    const stop = runtime.subscribe(() => { publications++ })
    const sequenceStarted = performance.now()

    const turnReduction = timed(() => reduceConversationWithDiagnostics(seededSnapshot.conversation, Object.freeze({
      type: "turn.started" as const, threadId: fixture.threadId, turnId: fixture.nextTurnId,
    }), canonicalDiagnostics))
    const afterTurn: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: seededSnapshot.canonicalRevision + 1,
      conversation: turnReduction.value,
      transcript: detachedTranscript,
    })
    const emptyTurnRuntime = timed(() => runtime.update(runtimeInput(fixture, afterTurn, "detached", {
      canonicalDamage: { kind: "blocks", itemIds: [] },
    })))
    assert.equal(emptyTurnRuntime.value, pinned)

    const item = Object.freeze({
      id: fixture.nextItemId, turnId: fixture.nextTurnId, kind: "assistant" as const,
      markdown: "Detached unseen tail block.", status: "running" as const,
    })
    const itemReduction = timed(() => reduceConversationWithDiagnostics(afterTurn.conversation, Object.freeze({
      type: "item.started" as const, threadId: fixture.threadId, item,
    }), canonicalDiagnostics))
    const itemProjection = timed(() => syncTranscriptItem(detachedTranscript, item, semanticDiagnostics))
    const afterItem: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: afterTurn.canonicalRevision + 1,
      conversation: itemReduction.value,
      transcript: itemProjection.value,
    })
    const itemRuntime = timed(() => runtime.update(runtimeInput(fixture, afterItem, "detached", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.nextItemId] },
    })))
    assert.equal(itemRuntime.value, pinned)

    const deltaReduction = timed(() => reduceConversationWithDiagnostics(afterItem.conversation, Object.freeze({
      type: "item.delta" as const, threadId: fixture.threadId, itemId: fixture.nextItemId, delta: " More.",
    }), canonicalDiagnostics))
    const changedItem = deltaReduction.value.items[fixture.nextItemId]!
    const repeatProjection = timed(() => syncTranscriptItem(itemProjection.value, changedItem, semanticDiagnostics))
    const afterDelta: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: afterItem.canonicalRevision + 1,
      conversation: deltaReduction.value,
      transcript: repeatProjection.value,
    })
    const repeatRuntime = timed(() => runtime.update(runtimeInput(fixture, afterDelta, "detached", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.nextItemId] },
    })))
    const hiddenSequenceSettlementMs = performance.now() - sequenceStarted
    assert.equal(repeatRuntime.value, pinned)
    assert.equal(publications, 0)
    const hiddenContentPublications = publications

    const presentation = timed(() => runtime.update({ ...runtimeInput(fixture, afterDelta, "detached"),
      presentationDamage: { kind: "view" } }))
    stop()
    assert.equal(publications, 1)
    assert.equal(presentation.value.blocks, pinned.blocks)
    assert.equal(presentation.value.window, pinned.window)
    assert.equal(presentation.value.geometry, pinned.geometry)
    assert.equal(presentation.value.transcript.unseenItemIds, repeatProjection.value.unseenItemIds)
    assert.equal(repeatProjection.value.unseenEntries, fixture.blockCount + 1)
    assert.equal(repeatProjection.value.unseenItemIds, itemProjection.value.unseenItemIds)
    assert.deepEqual([...repeatProjection.value.unseenItemIds], [...unseenItemIds, fixture.nextItemId])

    assert.equal(semanticDiagnostics.unseenItemSequenceNormalizations, 0)
    assert.equal(semanticDiagnostics.unseenItemSequenceNormalizationItemVisits, 0)
    assert.equal(semanticDiagnostics.unseenItemMembershipChecks, 2)
    assert.equal(semanticDiagnostics.unseenItemAppends, 1)
    const logarithmicBound = 4 * (Math.ceil(Math.log2(fixture.blockCount + 1)) + 1)
    assert(semanticDiagnostics.unseenItemMembershipNodeVisits <= logarithmicBound)
    assert(semanticDiagnostics.unseenItemAppendNodeVisits <= logarithmicBound)
    assert(semanticDiagnostics.unseenItemIndexUpdateNodeVisits <= logarithmicBound)
    assert(semanticDiagnostics.unseenItemIndexUpdateNodesCopied <= logarithmicBound * 2)
    assert.equal(semanticDiagnostics.textLengthIndexBuilds, 0)
    assert.equal(semanticDiagnostics.textLengthItemVisits, 0)
    assert.equal(semanticDiagnostics.textLengthIndexUpdates, 2)
    assert.equal(semanticDiagnostics.urlIndexBuilds, 0)
    assert.equal(semanticDiagnostics.urlIndexItemVisits, 0)
    assert.equal(semanticDiagnostics.urlIndexUpdates, 2)
    assert.equal(canonicalDiagnostics.conversationTurnIdSequenceNormalizations, 0)
    assert.equal(canonicalDiagnostics.conversationTurnIdSequenceNormalizationVisits, 0)
    assert.equal(canonicalDiagnostics.conversationTurnRecordNormalizations, 0)
    assert.equal(canonicalDiagnostics.conversationTurnRecordNormalizationVisits, 0)
    assert.equal(canonicalDiagnostics.conversationItemRecordNormalizations, 0)
    assert.equal(canonicalDiagnostics.conversationItemRecordNormalizationItemVisits, 0)
    assert.equal(runtimeDiagnostics.hiddenDamageMerges! - (runtimeBefore.hiddenDamageMerges ?? 0), 3)
    assert.equal(runtimeDiagnostics.hiddenDamageInputItemVisits! - (runtimeBefore.hiddenDamageInputItemVisits ?? 0), 2)
    assert.equal(runtimeDiagnostics.hiddenDamageItemAdditions! - (runtimeBefore.hiddenDamageItemAdditions ?? 0), 1)
    assert.equal(runtimeDiagnostics.hiddenDamageSnapshots! - (runtimeBefore.hiddenDamageSnapshots ?? 0), 0)
    assert.equal(runtimeDiagnostics.completePlanBuilds - runtimeBefore.completePlanBuilds, 0)
    assert.equal(runtimeDiagnostics.completePlanBlockVisits - runtimeBefore.completePlanBlockVisits, 0)
    assert.equal(runtimeDiagnostics.blockPlanUpdates - runtimeBefore.blockPlanUpdates, 0)
    assert.equal(runtimeDiagnostics.heightIndexBuilds - runtimeBefore.heightIndexBuilds, 0)
    assert.equal(runtimeDiagnostics.heightIndexUpdates - runtimeBefore.heightIndexUpdates, 0)
    assert.equal(runtimeDiagnostics.completeGeometryBlockVisits - runtimeBefore.completeGeometryBlockVisits, 0)
    assert.equal(runtimeDiagnostics.windowGeometryBlockVisits - runtimeBefore.windowGeometryBlockVisits, 0)
    assert.equal(runtimeDiagnostics.changedItemBuilds - runtimeBefore.changedItemBuilds, 0)

    printResult({
      fixtureVersion: fixture.fixtureVersion,
      scenario: "detached-unseen-accumulation",
      materialization: "windowed-production",
      boundary: "canonical-semantic-unseen-runtime-and-presentation-publication",
      blockCount: fixture.blockCount,
      viewport: { width: 80, height: 24 },
      mode: "detached",
      fixture: { contentShape: "one-semantic-item-per-turn-with-complete-unseen-backlog", contentHash: fixture.contentHash,
        setupExcludedFromTiming: true, excludedSetup: "bulk canonical construction, persistent unseen backlog, and initial runtime/window settlement" },
      operationCounts: {
        completeBlocks: fixture.blockCount,
        mountedBlocks: pinned.window.blocks.length,
        unseenEntriesBefore: fixture.blockCount,
        unseenEntriesAfter: repeatProjection.value.unseenEntries,
        hiddenContentPublications,
        presentationOnlyPublications: publications - hiddenContentPublications,
        semantic: {
          sequenceNormalizations: semanticDiagnostics.unseenItemSequenceNormalizations,
          normalizationItemVisits: semanticDiagnostics.unseenItemSequenceNormalizationItemVisits,
          membershipChecks: semanticDiagnostics.unseenItemMembershipChecks,
          membershipNodeVisits: semanticDiagnostics.unseenItemMembershipNodeVisits,
          appends: semanticDiagnostics.unseenItemAppends,
          appendNodeVisits: semanticDiagnostics.unseenItemAppendNodeVisits,
          indexUpdateNodeVisits: semanticDiagnostics.unseenItemIndexUpdateNodeVisits,
          indexUpdateNodesCopied: semanticDiagnostics.unseenItemIndexUpdateNodesCopied,
        },
        hiddenDamage: {
          backlogBefore: hiddenDamageBacklog.length,
          seed: hiddenDamageSeed,
          merges: runtimeDiagnostics.hiddenDamageMerges! - (runtimeBefore.hiddenDamageMerges ?? 0),
          inputItemVisits: runtimeDiagnostics.hiddenDamageInputItemVisits! - (runtimeBefore.hiddenDamageInputItemVisits ?? 0),
          itemAdditions: runtimeDiagnostics.hiddenDamageItemAdditions! - (runtimeBefore.hiddenDamageItemAdditions ?? 0),
          snapshots: runtimeDiagnostics.hiddenDamageSnapshots! - (runtimeBefore.hiddenDamageSnapshots ?? 0),
          snapshotItemVisits: runtimeDiagnostics.hiddenDamageSnapshotItemVisits! - (runtimeBefore.hiddenDamageSnapshotItemVisits ?? 0),
        },
        runtime: {
          completePlanBuilds: runtimeDiagnostics.completePlanBuilds - runtimeBefore.completePlanBuilds,
          completePlanBlockVisits: runtimeDiagnostics.completePlanBlockVisits - runtimeBefore.completePlanBlockVisits,
          blockPlanUpdates: runtimeDiagnostics.blockPlanUpdates - runtimeBefore.blockPlanUpdates,
          heightIndexBuilds: runtimeDiagnostics.heightIndexBuilds - runtimeBefore.heightIndexBuilds,
          heightIndexUpdates: runtimeDiagnostics.heightIndexUpdates - runtimeBefore.heightIndexUpdates,
          completeGeometryBlockVisits: runtimeDiagnostics.completeGeometryBlockVisits - runtimeBefore.completeGeometryBlockVisits,
          windowGeometryBlockVisits: runtimeDiagnostics.windowGeometryBlockVisits - runtimeBefore.windowGeometryBlockVisits,
          changedItemBuilds: runtimeDiagnostics.changedItemBuilds - runtimeBefore.changedItemBuilds,
        },
      },
      timingsMs: {
        emptyTurnCanonicalReduction: Number(turnReduction.milliseconds.toFixed(6)),
        emptyTurnRuntimeAdoption: Number(emptyTurnRuntime.milliseconds.toFixed(6)),
        newItemCanonicalReduction: Number(itemReduction.milliseconds.toFixed(6)),
        newItemSemanticProjection: Number(itemProjection.milliseconds.toFixed(6)),
        newItemRuntimeAdoption: Number(itemRuntime.milliseconds.toFixed(6)),
        repeatCanonicalReduction: Number(deltaReduction.milliseconds.toFixed(6)),
        repeatSemanticProjection: Number(repeatProjection.milliseconds.toFixed(6)),
        repeatRuntimeAdoption: Number(repeatRuntime.milliseconds.toFixed(6)),
        hiddenSequenceSettlement: Number(hiddenSequenceSettlementMs.toFixed(6)),
        presentationOnlyPublication: Number(presentation.milliseconds.toFixed(6)),
      },
      samples: { warmup: 0, measured: 1 },
    })
  } finally { runtime.dispose() }
}

function sideInheritedMembershipBaseline(blockCount: number): void {
  const parentId = threadId(`side-membership-parent-${blockCount}`)
  const childId = threadId(`side-membership-child-${blockCount}`)
  const localTurnId = turnId(`side-membership-local-turn-${blockCount}`)
  const localItemId = itemId(`side-membership-local-item-${blockCount}`)
  let state = { ...initialWorkbench(), workspaces: { [childId]: createWorkspace(childId) } }
  state = applyConversationEvent(state, {
    type: "item.started", threadId: childId,
    item: { id: localItemId, turnId: localTurnId, kind: "assistant", markdown: "seed", status: "running" },
  }).state
  const inheritedTurnIds = persistentConversationTurnIds(Array.from({ length: blockCount }, (_, index) =>
    turnId(`side-membership-inherited-turn-${blockCount}-${index}`)))
  state = { ...state, sideChats: {
    [parentId]: { parentId, threadId: childId, visible: true, maximized: false, inheritedTurnIds },
  } }
  const diagnostics = createConversationStructureDiagnostics()
  const projected = timed(() => applyConversationEvent(state, {
    type: "item.delta", threadId: childId, itemId: localItemId, delta: " delta",
  }, diagnostics).state)
  assert.equal(projected.value.workspaces[childId]!.transcript.projectionById[localItemId]?.source, "seed delta")
  assert.equal(diagnostics.conversationTurnIdSequenceNormalizations, 0)
  assert.equal(diagnostics.conversationTurnIdSequenceNormalizationVisits, 0)
  assert.equal(diagnostics.conversationTurnIdSequenceLookups, 1)
  assert(diagnostics.conversationTurnIdSequenceLookupNodeVisits
    <= 2 * (Math.ceil(Math.log2(blockCount + 1)) + 1))
  printResult({
    scenario: "side-inherited-turn-membership",
    materialization: "semantic-workbench",
    boundary: "side-child-canonical-projection",
    blockCount,
    viewport: { width: 80, height: 24 },
    mode: "detached",
    fixture: { contentShape: "inherited-parent-turns-plus-one-live-child-item", setupExcludedFromTiming: true,
      excludedSetup: "persistent inherited-turn construction and child workspace/item projection" },
    operationCounts: {
      inheritedTurns: inheritedTurnIds.length,
      membershipLookups: diagnostics.conversationTurnIdSequenceLookups,
      membershipNodeVisits: diagnostics.conversationTurnIdSequenceLookupNodeVisits,
      sequenceNormalizations: diagnostics.conversationTurnIdSequenceNormalizations,
      normalizationVisits: diagnostics.conversationTurnIdSequenceNormalizationVisits,
    },
    timingsMs: { canonicalAndSemanticProjection: Number(projected.milliseconds.toFixed(6)) },
    samples: { warmup: 0, measured: 1 },
  })
}

function runtimeBaseline(fixture: ReturnType<typeof buildTranscriptScalingFixture>): void {
  forceGc()
  const constructed = timed(() => new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", { canonicalDamage: { kind: "full" } })))
  const runtime = constructed.value
  try {
    const cold = runtime.getSnapshot()
    assert.equal(cold.blocks.length, fixture.blockCount)
    assert.equal(cold.window.blocks, cold.blocks)
    const planned = timed(() => passThroughWindow(cold.blocks))
    assert.equal(planned.value.blocks, cold.blocks)

    const measurements = syntheticGeometry(cold)
    const geometryPublication = timed(() => runtime.reportMeasurements({ ...runtime.measurementBase(), measurements }))
    assert.equal(geometryPublication.value.geometry.measuredBlockCount, fixture.blockCount)
    const measured = runtime.getSnapshot()
    const historyGeometry = measured.geometry.byBlockKey

    let publications = 0
    const unsubscribe = runtime.subscribe(() => { publications++ })
    const followed = timed(() => runtime.update(runtimeInput(fixture, fixture.afterTailDelta, "follow", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
    })))
    assert.equal(publications, 1)
    let changedBlocks = 0, preservedBlockIdentities = 0, preservedGeometryIdentities = 0
    const tailKey = `item:${fixture.tailItemId}:root`
    for (let index = 0; index < fixture.blockCount; index++) {
      const beforeBlock = measured.blocks[index]!, afterBlock = followed.value.blocks[index]!
      if (beforeBlock === afterBlock) preservedBlockIdentities++
      else changedBlocks++
      const key = blockKey(afterBlock)
      if (key !== tailKey && followed.value.geometry.byBlockKey[key] === historyGeometry[key]) preservedGeometryIdentities++
    }
    assert.equal(changedBlocks, 1)
    assert.equal(preservedBlockIdentities, fixture.blockCount - 1)
    assert.equal(preservedGeometryIdentities, fixture.blockCount - 1)
    assert.equal(followed.value.geometry.byBlockKey[tailKey], undefined)

    publications = 0
    const navigatedTranscript = Object.freeze({
      ...fixture.afterTailDelta.transcript,
      cursor: Object.freeze({ itemId: fixture.targets.quarter, graphemeOffset: 0 }),
      viewport: Object.freeze({ kind: "point" as const, point: Object.freeze({ itemId: fixture.targets.quarter, graphemeOffset: 0 }), preferredScreenRow: 7 }),
    })
    const navigatedSnapshot = Object.freeze({ ...fixture.afterTailDelta, transcript: navigatedTranscript })
    const navigation = timed(() => runtime.update(runtimeInput(fixture, navigatedSnapshot, "follow", { presentationDamage: { kind: "view" } })))
    assert.equal(publications, 1)

    runtime.update(runtimeInput(fixture, navigatedSnapshot, "detached"))
    assert.equal(publications, 2, "navigation and detach must each publish once")
    const pinned = runtime.getSnapshot()
    publications = 0
    const hidden = appendTranscriptScalingTail(navigatedSnapshot, fixture.tailItemId, fixture.tailDelta)
    const detached = timed(() => runtime.update(runtimeInput(fixture, hidden, "detached", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
    })))
    assert.equal(detached.value, pinned)
    assert.equal(publications, 0)

    const hiddenTail = hidden.transcript.projectionById[fixture.tailItemId]!
    const revealPoint = Object.freeze({ itemId: fixture.tailItemId, graphemeOffset: hiddenTail.sourceSpans.length })
    const revealedTranscript = Object.freeze({
      ...hidden.transcript,
      cursor: revealPoint,
      viewport: Object.freeze({ kind: "point" as const, point: revealPoint, preferredScreenRow: 7 }),
    })
    const revealedSnapshot = Object.freeze({ ...hidden, transcript: revealedTranscript })
    const reveal = timed(() => runtime.update(runtimeInput(fixture, revealedSnapshot, "detached", {
      reveal: { id: fixture.blockCount, point: revealPoint, reason: "jump" },
    })))
    assert.equal(publications, 1)
    assert.equal(reveal.value.displayedCanonicalRevision, hidden.canonicalRevision)
    assert.deepEqual(reveal.value.transcript.cursor, revealPoint)
    assert.deepEqual(reveal.value.transcript.viewport, { kind: "point", point: revealPoint, preferredScreenRow: 7 })

    const latest = appendTranscriptScalingTail(revealedSnapshot, fixture.tailItemId, fixture.tailDelta)
    runtime.update(runtimeInput(fixture, latest, "detached", { canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] } }))
    assert.equal(publications, 1, "hidden output after reveal must not publish the pinned presentation")
    publications = 0
    const reattach = timed(() => runtime.update(runtimeInput(fixture, latest, "follow")))
    assert.equal(publications, 1)
    const reference = createTranscriptFrame(runtimeInput(fixture, latest, "follow", { canonicalDamage: { kind: "full" } }))
    assert.deepEqual(reattach.value.transcript, reference.transcript)
    assert.deepEqual(reattach.value.blocks.map(blockKey), reference.blocks.map(blockKey))
    unsubscribe()

    printResult({
      scenario: "scaling-workloads",
      materialization: "pass-through-reference",
      boundary: "runtime",
      blockCount: fixture.blockCount,
      viewport: primaryViewport,
      mode: "follow-and-detached",
      fixture: { contentShape: "mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
      operationCounts: {
        completeBlocks: fixture.blockCount,
        mountedBlocks: 0,
        measuredBlocks: 0,
        changedBlocks,
        publications: 5,
        materializedWindowBlocks: cold.window.blocks.length,
        syntheticSeededMeasurements: measurements.length,
        invalidatedMeasurements: 1,
        retainedMeasurementsAfterFollow: followed.value.geometry.measuredBlockCount,
        followPublications: 1,
        navigationPublications: 1,
        detachPublications: 1,
        detachedPublications: 0,
        revealPublications: 1,
        reattachPublications: 1,
      },
      identityCounts: { preservedBlockIdentities, preservedGeometryIdentities },
      timingsMs: {
        coldRuntimeConstruction: Number(constructed.milliseconds.toFixed(6)),
        passThroughPlanning: Number(planned.milliseconds.toFixed(6)),
        geometryPublication: Number(geometryPublication.milliseconds.toFixed(6)),
        followReconciliation: Number(followed.milliseconds.toFixed(6)),
        warmNavigation: Number(navigation.milliseconds.toFixed(6)),
        detachedHiddenDelta: Number(detached.milliseconds.toFixed(6)),
        explicitReveal: Number(reveal.milliseconds.toFixed(6)),
        reattach: Number(reattach.milliseconds.toFixed(6)),
      },
      samples: { warmup: 0, measured: 1 },
    })
  } finally {
    runtime.dispose()
  }
}

function RuntimePublicationProbeInner(props: { runtime: TranscriptRuntime }) {
  const frame = useSyncExternalStore(props.runtime.subscribe, props.runtime.getSnapshot, props.runtime.getSnapshot)
  return <text>{frame.presentationRevision}</text>
}

function RuntimePublicationProbe(props: { runtime: TranscriptRuntime; commits: number[] }) {
  return <Profiler id="runtime-publication" onRender={(_id, _phase, duration) => props.commits.push(duration)}>
    <RuntimePublicationProbeInner runtime={props.runtime} />
  </Profiler>
}

function HiddenPresentationProbeInner(props: {
  runtime: TranscriptRuntime
  syntax: ReturnType<typeof createEmberTideSyntax>
  presentationHost: WorkbenchPublicationHost
  control: { setVisible?: (visible: boolean) => void }
  observe: { frame?: TranscriptFrame; renders?: number; presentation?: WorkbenchState }
}) {
  const [visible, setVisible] = useState(true)
  const scrollRef = useRef<ScrollBoxRenderable>(null)
  props.control.setVisible = setVisible
  props.observe.presentation = useVisiblePresentationSnapshot(props.presentationHost, "main", visible)
  const frame = useTranscriptRuntime({ transcriptRuntime: () => props.runtime }, "main", undefined, visible)
  useTranscriptLayout({
    threadId: frame.threadId,
    transcript: frame.transcript,
    frame,
    runtime: props.runtime,
    styleRevision,
    width: primaryViewport.width,
    height: 24,
    scrollRef,
    controller: inertController,
    visible,
  })
  props.observe.frame = frame
  props.observe.renders = (props.observe.renders ?? 0) + 1
  return <box width={primaryViewport.width} height={24}>{visible
    ? <TranscriptViewport window={frame.window} state={frame.transcript} surface="transcript" syntax={props.syntax} scrollRef={scrollRef} onManualScroll={() => {}} />
    : <box id="hidden-presentation-retained-state" />}</box>
}

function HiddenPresentationProbe(props: Parameters<typeof HiddenPresentationProbeInner>[0] & { commits: number[] }) {
  return <Profiler id="hidden-presentation" onRender={(_id, _phase, duration) => props.commits.push(duration)}>
    <HiddenPresentationProbeInner {...props} />
  </Profiler>
}

async function hiddenPresentationResourceBaseline(fixture: ReturnType<typeof buildTranscriptScalingFixture>): Promise<void> {
  forceGc()
  const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", { canonicalDamage: { kind: "full" } }), {
    windowPolicy: { viewportRows: 24, overscanRows: 24 },
  })
  const originalSubscribe = runtime.subscribe
  let activeRuntimeSubscriptions = 0
  runtime.subscribe = listener => {
    activeRuntimeSubscriptions++
    const stop = originalSubscribe(listener)
    return () => { activeRuntimeSubscriptions--; stop() }
  }
  const syntax = createEmberTideSyntax()
  let presentationSnapshot: WorkbenchState = initialWorkbench()
  const presentationListeners = new Set<() => void>()
  let activePresentationSubscriptions = 0
  let presentationNotifications = 0
  const presentationHost: WorkbenchPublicationHost & { publishHidden(): void } = {
    getLayoutSnapshot: () => { throw new Error("layout is outside this presentation visibility cell") },
    subscribeLayout: () => () => {},
    getPresentationSnapshot: () => presentationSnapshot,
    subscribePresentation: (_presentationId, listener) => {
      activePresentationSubscriptions++
      presentationListeners.add(listener)
      return () => { activePresentationSubscriptions--; presentationListeners.delete(listener) }
    },
    publishHidden: () => {
      presentationSnapshot = { ...presentationSnapshot, error: "hidden publication" }
      for (const listener of presentationListeners) { presentationNotifications++; listener() }
    },
  }
  const originalReportMeasurements = runtime.reportMeasurements.bind(runtime)
  let measurementReports = 0
  runtime.reportMeasurements = batch => { measurementReports++; return originalReportMeasurements(batch) }
  const commits: number[] = []
  const control: { setVisible?: (visible: boolean) => void } = {}
  const observe: { frame?: TranscriptFrame; renders?: number; presentation?: WorkbenchState } = {}
  const setup = await testRender(<HiddenPresentationProbe runtime={runtime} syntax={syntax} presentationHost={presentationHost} control={control} observe={observe} commits={commits} />, primaryViewport)
  const frameListeners = () => (setup.renderer as unknown as { listenerCount(event: string): number }).listenerCount(CliRenderEvents.FRAME)
  const settle = async () => {
    for (let index = 0; index < 4; index++) await act(async () => { await setup.flush(); await setup.renderOnce() })
  }
  try {
    await settle()
    const visibleScroll = setup.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable
    const mountedBefore = mountedBlockRoots(visibleScroll).size
    assert(mountedBefore > 0 && mountedBefore <= 48)
    assert(measurementReports > 0)
    assert.equal(activeRuntimeSubscriptions, 1)
    assert.equal(activePresentationSubscriptions, 1)
    assert.equal(frameListeners(), 1)

    await act(async () => { control.setVisible!(false); await setup.flush(); await setup.renderOnce() })
    const hiddenTranscriptRoots = setup.renderer.root.findDescendantById("transcript") ? 1 : 0
    const hiddenScroll = setup.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable | undefined
    const hiddenMountedBlocks = hiddenScroll ? mountedBlockRoots(hiddenScroll).size : 0
    const hiddenSpacerRoots = ["transcript-top-spacer", "transcript-bottom-spacer"]
      .filter(id => setup.renderer.root.findDescendantById(id)).length
    const hiddenFrameListeners = frameListeners()
    assert.equal(hiddenTranscriptRoots, 0)
    assert.equal(hiddenMountedBlocks, 0)
    assert.equal(hiddenSpacerRoots, 0)
    assert.equal(hiddenFrameListeners, 0)
    assert.equal(activeRuntimeSubscriptions, 0)
    assert.equal(activePresentationSubscriptions, 0)
    const hiddenRenders = observe.renders
    const hiddenMeasurementReportsBefore = measurementReports
    commits.length = 0
    let runtimePublications = 0
    const stopPublication = runtime.subscribe(() => { runtimePublications++ })
    const hiddenStarted = performance.now()
    await act(async () => {
      runtime.update(runtimeInput(fixture, fixture.afterTailDelta, "follow", {
        canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
      }))
      presentationHost.publishHidden()
      await setup.flush()
      await setup.renderOnce()
    })
    const hiddenSettlementMs = performance.now() - hiddenStarted
    stopPublication()
    const hiddenMeasurementReports = measurementReports - hiddenMeasurementReportsBefore
    const hiddenReactCommits = commits.length
    const hiddenPresentationSubscriptions = activePresentationSubscriptions
    const hiddenRuntimeSubscriptions = activeRuntimeSubscriptions
    assert.equal(runtimePublications, 1)
    assert.equal(presentationNotifications, 0)
    assert.equal(hiddenRuntimeSubscriptions, 0)
    assert.equal(hiddenPresentationSubscriptions, 0)
    assert.equal(observe.renders, hiddenRenders)
    const hiddenRuntimeRenders = (observe.renders ?? 0) - (hiddenRenders ?? 0)
    assert.equal(setup.renderer.root.findDescendantById("transcript"), undefined)
    assert.equal(hiddenMeasurementReports, 0)
    assert.equal(hiddenReactCommits, 0)
    assert.equal(frameListeners(), 0)

    const latest = runtime.getSnapshot()
    const retainedRuntime = runtime
    await act(async () => { control.setVisible!(true); await setup.flush(); await setup.renderOnce() })
    await settle()
    const revealedScroll = setup.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable
    const mountedAfter = mountedBlockRoots(revealedScroll).size
    assert(mountedAfter > 0 && mountedAfter <= 48)
    assert.equal(observe.frame?.displayedCanonicalRevision, latest.displayedCanonicalRevision)
    assert.equal(observe.presentation?.error, "hidden publication")
    assert.equal(activeRuntimeSubscriptions, 1)
    assert.equal(activePresentationSubscriptions, 1)
    assert.equal(frameListeners(), 1)
    const runtimeIdentityRetained = retainedRuntime === runtime ? 1 : 0
    const latestRevisionOnReveal = observe.frame?.displayedCanonicalRevision === latest.displayedCanonicalRevision ? 1 : 0
    printResult({
      scenario: "hidden-presentation-resources",
      materialization: "production-window",
      boundary: "react-native-visibility",
      blockCount: fixture.blockCount,
      viewport: primaryViewport,
      mode: "follow",
      operationCounts: {
        mountedBefore,
        hiddenTranscriptRoots,
        hiddenMountedBlocks,
        hiddenSpacerRoots,
        hiddenFrameListeners,
        hiddenMeasurementReports,
        hiddenPresentationSubscriptions,
        hiddenRuntimeSubscriptions,
        hiddenPresentationNotifications: presentationNotifications,
        retainedRuntimePublications: runtimePublications,
        hiddenReactCommits,
        hiddenReactRenders: hiddenRuntimeRenders,
        mountedAfter,
        runtimeIdentityRetained,
        latestRevisionOnReveal,
      },
      timingsMs: { hiddenRuntimePublicationAndReactFlush: Number(hiddenSettlementMs.toFixed(6)) },
      samples: { warmup: 0, measured: 1 },
    })
  } finally {
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
    assert.equal(activeRuntimeSubscriptions, 0)
    runtime.dispose()
  }
}

async function reactPublicationBaseline(fixture: ReturnType<typeof buildTranscriptScalingFixture>): Promise<void> {
  forceGc()
  const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", { canonicalDamage: { kind: "full" } }))
  const commits: number[] = []
  const setup = await testRender(<RuntimePublicationProbe runtime={runtime} commits={commits} />, primaryViewport)
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    commits.length = 0
    let runtimeUpdateMs = 0, runtimePublications = 0
    const unsubscribe = runtime.subscribe(() => { runtimePublications++ })
    const started = performance.now()
    await act(async () => {
      const updateStarted = performance.now()
      runtime.update(runtimeInput(fixture, fixture.afterTailDelta, "follow", {
        canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
      }))
      runtimeUpdateMs = performance.now() - updateStarted
      await setup.flush()
      await setup.renderOnce()
    })
    unsubscribe()
    assert.equal(runtimePublications, 1)
    assert.equal(commits.length, 1)
    printResult({
      scenario: "follow-publication",
      materialization: "pass-through-reference",
      boundary: "react",
      blockCount: fixture.blockCount,
      viewport: primaryViewport,
      mode: "follow",
      fixture: { contentShape: "constant-one-node-subscriber", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
      operationCounts: { mountedBlocks: 0, measuredBlocks: 0, changedBlocks: 1, publications: runtimePublications,
        runtimePublications, reactCommits: commits.length },
      timingsMs: { runtimeUpdate: Number(runtimeUpdateMs.toFixed(6)), postUpdateFlushAndFrame: Number((performance.now() - started - runtimeUpdateMs).toFixed(6)), reactCommitDurations: stats(commits) },
      samples: { warmup: 0, measured: 1 },
    })
  } finally {
    runtime.dispose()
    await act(async () => setup.renderer.destroy())
  }
}

function runtimeCorrectionBaseline(fixture: ReturnType<typeof buildTranscriptScalingFixture>): void {
  forceGc()
  const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", { canonicalDamage: { kind: "full" } }), {
    windowPolicy: { viewportRows: 24, overscanRows: 24 },
  })
  try {
    const before = runtime.getSnapshot()
    const block = before.window.blocks.at(-1)!
    const base = runtime.measurementBase(before)
    const measurement: BlockGeometry = Object.freeze({
      key: Object.freeze({
        blockKey: blockKey(block),
        contentRevision: block.contentRevision,
        width: 80,
        styleRevision: "stage-5.3-correction",
        folded: block.key.kind === "item" && Boolean(before.transcript.folded[block.key.itemId]),
      }),
      nativeRevision: 1,
      rows: 4,
      pointCount: 1,
      points: sharedPoint,
      pointOffsetsByRow: sharedOffsets,
      lines: sharedLines,
      lineByRow: sharedLineByRow,
    })
    let publications = 0
    const unsubscribe = runtime.subscribe(() => { publications++ })
    const corrected = timed(() => runtime.reportMeasurements({ ...base, measurements: [measurement] }))
    assert.equal(publications, 1)
    assert.equal(corrected.value.geometry.totalRows, fixture.blockCount + 3)
    assert.equal(corrected.value.geometry.blockRows.length, corrected.value.window.blocks.length)
    assert(corrected.value.window.blocks.length <= 48)
    assert(Object.keys(corrected.value.geometry.byBlockKey).length <= corrected.value.window.blocks.length)
    const replay = timed(() => runtime.reportMeasurements({ ...base, measurements: [{ ...measurement, nativeRevision: 2 }] }))
    assert.equal(replay.value, corrected.value)
    assert.equal(publications, 1)
    unsubscribe()
    printResult({
      scenario: "runtime-height-correction",
      materialization: "windowed-production",
      boundary: "runtime-index-window-geometry-publication",
      blockCount: fixture.blockCount,
      viewport: { width: 80, height: 24 },
      mode: "follow",
      fixture: { contentShape: "mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
      operationCounts: {
        completeBlocks: fixture.blockCount,
        mountedBlocksBefore: before.window.blocks.length,
        mountedBlocksAfter: corrected.value.window.blocks.length,
        acceptedMeasurements: 1,
        changedHeights: 1,
        publications,
        staleReplayPublications: 0,
        geometryBlocksComposed: corrected.value.geometry.blockRows.length,
        retainedDetailedGeometry: Object.keys(corrected.value.geometry.byBlockKey).length,
        totalRowDelta: corrected.value.geometry.totalRows - before.geometry.totalRows,
      },
      timingsMs: {
        atomicCorrectionPublication: Number(corrected.milliseconds.toFixed(6)),
        staleReplay: Number(replay.milliseconds.toFixed(6)),
      },
      samples: { warmup: 0, measured: 1 },
    })
  } finally {
    runtime.dispose()
  }
}

function offWindowTargetBaseline(fixture: ReturnType<typeof buildTranscriptScalingFixture>): void {
  const anchor = Object.freeze({ itemId: fixture.targets.middle, graphemeOffset: 0 })
  const detachedTranscript = Object.freeze({
    ...fixture.before.transcript,
    cursor: anchor,
    viewport: Object.freeze({ kind: "point" as const, point: anchor, preferredScreenRow: 5 }),
  })
  const detachedSnapshot = Object.freeze({ ...fixture.before, transcript: detachedTranscript })
  const runtimeDiagnostics = {
    completePlanBuilds: 0,
    completePlanBlockVisits: 0,
    orderIndexBuilds: 0,
    orderIndexItemVisits: 0,
    orderIndexCacheHits: 0,
    textLengthIndexBuilds: 0,
    textLengthItemVisits: 0,
    textLengthIndexCacheHits: 0,
    textLengthIndexUpdates: 0,
    textLengthNodeVisits: 0,
    urlIndexBuilds: 0,
    urlIndexItemVisits: 0,
    urlIndexCacheHits: 0,
    urlIndexUpdates: 0,
    urlIndexNodeVisits: 0,
    heightIndexBuilds: 0,
    heightIndexBlockVisits: 0,
    heightIndexUpdates: 0,
    heightIndexNodeVisits: 0,
    heightIndexNodesCopied: 0,
    completeGeometryBlockVisits: 0,
    windowGeometryBlockVisits: 0,
    blockPlanWindowSliceItems: 0,
    projectionRecordUpdates: 0, projectionRecordNodeVisits: 0, projectionRecordNodesCopied: 0,
    blockPlanUpdates: 0, blockPlanNodeVisits: 0, blockPlanNodesCopied: 0, changedItemBuilds: 0,
  }
  const runtime = new TranscriptRuntime(runtimeInput(fixture, detachedSnapshot, "detached", { canonicalDamage: { kind: "full" } }), {
    windowPolicy: { viewportRows: 24, overscanRows: 24 },
    diagnostics: runtimeDiagnostics,
  })
  try {
    const before = runtime.getSnapshot()
    const hidden = appendTranscriptScalingTail(detachedSnapshot, fixture.tailItemId, fixture.tailDelta)
    assert.equal(runtime.update(runtimeInput(fixture, hidden, "detached", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
    })), before)
    const motionDiagnostics = { wrappedItems: 0, itemTransitions: 0 }
    const motion = timed(() => movePointInTranscript(detachedTranscript, 73, anchor, "first", 1, motionDiagnostics))
    assert.deepEqual(motion.value?.point, { itemId: fixture.targets.first, graphemeOffset: 0 })
    assert.deepEqual(motionDiagnostics, { wrappedItems: 1, itemTransitions: 0 })
    const target = Object.freeze(motion.value!.point)
    assert(!pointIsMaterialized(before.window.blocks, target))
    const targetTranscript = Object.freeze({
      ...hidden.transcript,
      cursor: target,
      viewport: Object.freeze({ kind: "point" as const, point: target, preferredScreenRow: 5 }),
    })
    let publications = 0
    const unsubscribe = runtime.subscribe(() => { publications++ })
    const diagnosticsBeforeReveal = { ...runtimeDiagnostics }
    const revealed = timed(() => runtime.update(runtimeInput(fixture, Object.freeze({ ...hidden, transcript: targetTranscript }), "detached", {
      presentationDamage: { kind: "view" },
      reveal: { id: fixture.blockCount, point: target, reason: "jump" },
    })))
    unsubscribe()
    assert.equal(publications, 1)
    assert.equal(revealed.value.blocks, before.blocks)
    assert.equal(revealed.value.displayedCanonicalRevision, before.displayedCanonicalRevision)
    assert(pointIsMaterialized(revealed.value.window.blocks, target))
    assert(revealed.value.window.blocks.length <= 72)
    const completePlanBuilds = runtimeDiagnostics.completePlanBuilds - diagnosticsBeforeReveal.completePlanBuilds
    const completePlanBlockVisits = runtimeDiagnostics.completePlanBlockVisits - diagnosticsBeforeReveal.completePlanBlockVisits
    const orderIndexBuilds = runtimeDiagnostics.orderIndexBuilds - diagnosticsBeforeReveal.orderIndexBuilds
    const orderIndexItemVisits = runtimeDiagnostics.orderIndexItemVisits - diagnosticsBeforeReveal.orderIndexItemVisits
    assert.equal(completePlanBuilds, 0)
    assert.equal(completePlanBlockVisits, 0)
    assert.equal(orderIndexBuilds, 0)
    assert.equal(orderIndexItemVisits, 0)
    printResult({
      scenario: "off-window-target-materialization",
      materialization: "windowed-production",
      boundary: "semantic-target-runtime-window-publication",
      blockCount: fixture.blockCount,
      viewport: { width: 80, height: 24 },
      mode: "detached",
      fixture: { contentShape: "mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
      operationCounts: {
        completeBlocks: fixture.blockCount,
        mountedBlocksBefore: before.window.blocks.length,
        mountedBlocksAfter: revealed.value.window.blocks.length,
        wrappedItems: motionDiagnostics.wrappedItems,
        itemTransitions: motionDiagnostics.itemTransitions,
        retainedCompleteBlockPlanIdentity: revealed.value.blocks === before.blocks ? 1 : 0,
        completePlanBuilds,
        completePlanBlockVisits,
        orderIndexBuilds,
        orderIndexItemVisits,
        publications,
      },
      timingsMs: {
        targetedMotion: Number(motion.milliseconds.toFixed(6)),
        windowPublication: Number(revealed.milliseconds.toFixed(6)),
      },
      samples: { warmup: 0, measured: 1 },
    })
  } finally { runtime.dispose() }
}

function indexedUrlAndFoldBaseline(fixture: ReturnType<typeof buildTranscriptScalingFixture>): void {
  const anchor = Object.freeze({ itemId: fixture.targets.quarter, graphemeOffset: 0 })
  const foldTarget = fixture.targets.threeQuarter
  const foldPoint = Object.freeze({ itemId: foldTarget, graphemeOffset: 0 })
  const targetTranscript = Object.freeze({
    ...fixture.before.transcript,
    folded: setTranscriptFoldValue(fixture.before.transcript.folded, foldTarget, false),
    cursor: foldPoint,
    viewport: Object.freeze({ kind: "point" as const, point: foldPoint, preferredScreenRow: 5 }),
  })
  const detachedTranscript = Object.freeze({
    ...targetTranscript,
    cursor: anchor,
    viewport: Object.freeze({ kind: "point" as const, point: anchor, preferredScreenRow: 5 }),
  })
  const detachedSnapshot = Object.freeze({ ...fixture.before, transcript: detachedTranscript })
  const targetSnapshot = Object.freeze({ ...fixture.before, transcript: targetTranscript })
  const diagnostics = {
    completePlanBuilds: 0, completePlanBlockVisits: 0,
    orderIndexBuilds: 0, orderIndexItemVisits: 0, orderIndexCacheHits: 0,
    textLengthIndexBuilds: 0, textLengthItemVisits: 0, textLengthIndexCacheHits: 0, textLengthIndexUpdates: 0, textLengthNodeVisits: 0,
    urlIndexBuilds: 0, urlIndexItemVisits: 0, urlIndexCacheHits: 0, urlIndexUpdates: 0, urlIndexNodeVisits: 0,
    heightIndexBuilds: 0, heightIndexBlockVisits: 0, heightIndexUpdates: 0, heightIndexNodeVisits: 0, heightIndexNodesCopied: 0,
    completeGeometryBlockVisits: 0, windowGeometryBlockVisits: 0, blockPlanWindowSliceItems: 0,
    projectionRecordUpdates: 0, projectionRecordNodeVisits: 0, projectionRecordNodesCopied: 0,
    blockPlanUpdates: 0, blockPlanNodeVisits: 0, blockPlanNodesCopied: 0, changedItemBuilds: 0,
  }
  const runtime = new TranscriptRuntime(runtimeInput(fixture, targetSnapshot, "detached", { canonicalDamage: { kind: "full" } }), {
    windowPolicy: { viewportRows: 24, overscanRows: 24 }, diagnostics,
  })
  try {
    const targetBlock = runtime.getSnapshot().window.blocks.find(block => block.key.kind === "item" && block.key.itemId === foldTarget)!
    runtime.reportMeasurements({ ...runtime.measurementBase(), measurements: [{
      key: { blockKey: blockKey(targetBlock), contentRevision: targetBlock.contentRevision, width: 80,
        styleRevision: "stage-5.4-fold-path", folded: false },
      nativeRevision: 1, rows: 8, pointCount: 1, points: sharedPoint, pointOffsetsByRow: sharedOffsets,
      lines: sharedLines, lineByRow: sharedLineByRow,
    }] })
    runtime.update(runtimeInput(fixture, detachedSnapshot, "detached", { presentationDamage: { kind: "view" } }))
    const before = runtime.getSnapshot()
    assert(!pointIsMaterialized(before.window.blocks, foldPoint))
    const urlReference = moveByUrlReference(before.transcript, "backward", before.transcript.cursor, { wrap: true })
    const urlBefore = { ...diagnostics }
    const urlMotion = timed(() => moveByUrl(before.transcript, "backward", before.transcript.cursor, { wrap: true }, diagnostics))
    assert.deepEqual(urlMotion.value, urlReference)
    const urlCounts = {
      urlIndexBuilds: diagnostics.urlIndexBuilds - urlBefore.urlIndexBuilds,
      urlIndexItemVisits: diagnostics.urlIndexItemVisits - urlBefore.urlIndexItemVisits,
      urlIndexCacheHits: diagnostics.urlIndexCacheHits - urlBefore.urlIndexCacheHits,
      urlIndexNodeVisits: diagnostics.urlIndexNodeVisits - urlBefore.urlIndexNodeVisits,
    }
    assert.equal(urlCounts.urlIndexBuilds, 0)
    assert.equal(urlCounts.urlIndexItemVisits, 0)
    assert.equal(urlCounts.urlIndexCacheHits, 1)
    assert(urlCounts.urlIndexNodeVisits <= 4 * Math.ceil(Math.log2(fixture.blockCount)) + 5)

    const foldedTranscript = Object.freeze({
      ...before.transcript,
      folded: setTranscriptFoldValue(before.transcript.folded, foldTarget, true),
      cursor: foldPoint,
      viewport: Object.freeze({ kind: "point" as const, point: foldPoint, preferredScreenRow: 5 }),
    })
    const foldedSnapshot = Object.freeze({ ...detachedSnapshot, transcript: foldedTranscript })
    const foldBefore = { ...diagnostics }
    let publications = 0
    const unsubscribe = runtime.subscribe(() => { publications++ })
    const fold = timed(() => runtime.update(runtimeInput(fixture, foldedSnapshot, "detached", {
      presentationDamage: { kind: "folds", itemIds: [foldTarget] },
      reveal: { id: fixture.blockCount, point: foldPoint, reason: "url" },
    })))
    unsubscribe()
    const foldCounts = {
      completePlanBuilds: diagnostics.completePlanBuilds - foldBefore.completePlanBuilds,
      completePlanBlockVisits: diagnostics.completePlanBlockVisits - foldBefore.completePlanBlockVisits,
      heightIndexBuilds: diagnostics.heightIndexBuilds - foldBefore.heightIndexBuilds,
      heightIndexBlockVisits: diagnostics.heightIndexBlockVisits - foldBefore.heightIndexBlockVisits,
      heightIndexUpdates: diagnostics.heightIndexUpdates - foldBefore.heightIndexUpdates,
      heightIndexNodeVisits: diagnostics.heightIndexNodeVisits - foldBefore.heightIndexNodeVisits,
      heightIndexNodesCopied: diagnostics.heightIndexNodesCopied - foldBefore.heightIndexNodesCopied,
      completeGeometryBlockVisits: diagnostics.completeGeometryBlockVisits - foldBefore.completeGeometryBlockVisits,
      windowGeometryBlockVisits: diagnostics.windowGeometryBlockVisits - foldBefore.windowGeometryBlockVisits,
    }
    assert.equal(publications, 1)
    assert.equal(fold.value.blocks, before.blocks)
    assert(pointIsMaterialized(fold.value.window.blocks, foldPoint))
    assert.equal(foldCounts.completePlanBuilds, 0)
    assert.equal(foldCounts.completePlanBlockVisits, 0)
    assert.equal(foldCounts.heightIndexBuilds, 0)
    assert.equal(foldCounts.heightIndexBlockVisits, 0)
    assert.equal(foldCounts.heightIndexUpdates, 1)
    assert(foldCounts.heightIndexNodeVisits <= Math.ceil(Math.log2(fixture.blockCount)) + 1)
    assert(foldCounts.heightIndexNodesCopied > 0)
    assert.equal(foldCounts.heightIndexNodesCopied, foldCounts.heightIndexNodeVisits)
    assert.equal(foldCounts.completeGeometryBlockVisits, 0)
    assert(foldCounts.windowGeometryBlockVisits <= 144)
    assert(fold.value.window.blocks.length <= 72)
    assert.equal(fold.value.geometry.totalRows, before.geometry.totalRows - 7)

    printResult({
      scenario: "indexed-url-and-off-window-fold",
      materialization: "windowed-production",
      boundary: "semantic-index-runtime-window-geometry-publication",
      blockCount: fixture.blockCount,
      viewport: { width: 80, height: 24 },
      mode: "detached",
      fixture: { contentShape: "mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
      operationCounts: {
        completeBlocks: fixture.blockCount,
        mountedBlocksBefore: before.window.blocks.length,
        mountedBlocksAfter: fold.value.window.blocks.length,
        publications,
        retainedCompleteBlockPlanIdentity: fold.value.blocks === before.blocks ? 1 : 0,
        ...urlCounts,
        ...foldCounts,
      },
      timingsMs: {
        warmUrlMotion: Number(urlMotion.milliseconds.toFixed(6)),
        offWindowFoldPublication: Number(fold.milliseconds.toFixed(6)),
      },
      samples: { warmup: 0, measured: 1 },
    })
  } finally { runtime.dispose() }
}

function RuntimeNativeMountProbeInner(props: {
  runtime: TranscriptRuntime
  scrollRef: RefObject<ScrollBoxRenderable | null>
  syntax: ReturnType<typeof createEmberTideSyntax>
}) {
  const frame = useSyncExternalStore(props.runtime.subscribe, props.runtime.getSnapshot, props.runtime.getSnapshot)
  return <TranscriptViewport window={frame.window} state={frame.transcript} surface="transcript"
    syntax={props.syntax} scrollRef={props.scrollRef} />
}

function RuntimeNativeMountProbe(props: {
  runtime: TranscriptRuntime
  commits: number[]
  scrollRef: RefObject<ScrollBoxRenderable | null>
  syntax: ReturnType<typeof createEmberTideSyntax>
}) {
  return <Profiler id="native-mount" onRender={(_id, _phase, duration) => props.commits.push(duration)}>
    <RuntimeNativeMountProbeInner runtime={props.runtime} scrollRef={props.scrollRef} syntax={props.syntax} />
  </Profiler>
}

function DetachedStatusNativeProbeInner(props: {
  runtime: TranscriptRuntime
  presentationHost: WorkbenchPublicationHost
  threadId: TranscriptRuntimeInput["threadId"]
  viewport: Readonly<{ width: number; height: number }>
  syntax: ReturnType<typeof createEmberTideSyntax>
  diagnostics: RenderedLayoutDiagnostics
  measurementTotals: { passes: number; attemptedMeasurements: number }
  observe: { unseenEntries?: number; frame?: TranscriptFrame }
}) {
  const state = useVisiblePresentationSnapshot(props.presentationHost, "main", true)
  const frame = useTranscriptRuntime({ transcriptRuntime: () => props.runtime }, "main", undefined, true)
  const scrollRef = useRef<ScrollBoxRenderable>(null)
  useTranscriptLayout({
    threadId: props.threadId,
    transcript: frame.transcript,
    frame,
    runtime: props.runtime,
    styleRevision,
    width: props.viewport.width,
    height: props.viewport.height - 1,
    scrollRef,
    controller: inertController,
    measurementDiagnostics: props.diagnostics,
    onMeasurementDiagnostics: diagnostics => {
      props.measurementTotals.passes++
      props.measurementTotals.attemptedMeasurements += diagnostics.attemptedMeasurements
    },
  })
  props.observe.unseenEntries = state.workspaces[props.threadId]?.transcript.unseenEntries
  props.observe.frame = frame
  return <box width={props.viewport.width} height={props.viewport.height} flexDirection="column">
    <text id="detached-unseen-status">{`UNSEEN ${props.observe.unseenEntries ?? 0}`}</text>
    <TranscriptViewport window={frame.window} state={frame.transcript} surface="transcript"
      syntax={props.syntax} scrollRef={scrollRef} onManualScroll={() => {}} />
  </box>
}

function DetachedStatusNativeProbe(props: Parameters<typeof DetachedStatusNativeProbeInner>[0] & { commits: number[] }) {
  return <Profiler id="detached-status-native" onRender={(_id, _phase, duration) => props.commits.push(duration)}>
    <DetachedStatusNativeProbeInner {...props} />
  </Profiler>
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

function assertBoundedNativeShape(blocks: number, counts: Readonly<{ descendants: number; spacers: number }>): void {
  assert.equal(counts.spacers, 2, "both stable transcript spacer roots must remain mounted")
  assert(counts.descendants >= blocks + counts.spacers, "native tree must include each mounted block root")
  assert(counts.descendants <= blocks * 24 + counts.spacers, "native descendants must remain bounded by materialized blocks")
}

function assertMountedRoots(frame: TranscriptFrame, roots: ReadonlyMap<string, Renderable>): void {
  assert.equal(roots.size, frame.window.blocks.length)
  for (const block of frame.window.blocks) assert(roots.has(transcriptBlockRenderableId(block)), `missing mounted root ${blockKey(block)}`)
}

async function detachedStatusNativePublicationBaseline(
  fixture: ReturnType<typeof buildTranscriptStructuralScalingFixture>,
  viewport: Readonly<{ width: number; height: number }>,
): Promise<void> {
  forceGc()
  const anchorItemId = fixture.before.transcript.order[0]!
  const detachedTranscript = Object.freeze({
    ...fixture.before.transcript,
    cursor: Object.freeze({ itemId: anchorItemId, graphemeOffset: 0 }),
    viewport: Object.freeze({ kind: "point" as const,
      point: Object.freeze({ itemId: anchorItemId, graphemeOffset: 0 }), preferredScreenRow: 7 }),
    unseenEntries: fixture.blockCount,
    unseenItemIds: persistentTranscriptUnseenItemIds(fixture.before.transcript.order),
  })
  let state: WorkbenchState = {
    ...initialWorkbench(),
    activeThreadId: fixture.threadId,
    threadOrder: [fixture.threadId],
    workspaces: {
      [fixture.threadId]: {
        ...createWorkspace(fixture.threadId),
        conversation: fixture.before.conversation,
        canonicalRevision: fixture.before.canonicalRevision,
        transcript: detachedTranscript,
      },
    },
  }
  const initialSnapshot: TranscriptFixtureSnapshot = Object.freeze({
    canonicalRevision: fixture.before.canonicalRevision,
    conversation: fixture.before.conversation,
    transcript: detachedTranscript,
  })
  const runtime = new TranscriptRuntime(runtimeInput(fixture, initialSnapshot, "detached", {
    canonicalDamage: { kind: "full" },
  }), { windowPolicy: { viewportRows: viewport.height - 1, overscanRows: viewport.height - 1 } })
  const originalReportMeasurements = runtime.reportMeasurements.bind(runtime)
  let measurementReports = 0
  runtime.reportMeasurements = batch => { measurementReports++; return originalReportMeasurements(batch) }
  const presentationListeners = new Set<() => void>()
  let presentationSnapshot = captureWorkbenchPresentation(state, "main")
  let workbenchPublications = 0
  const presentationHost: WorkbenchPublicationHost = {
    getLayoutSnapshot: () => { throw new Error("layout is outside the detached status publication cell") },
    subscribeLayout: () => () => {},
    getPresentationSnapshot: () => presentationSnapshot,
    subscribePresentation: (_presentationId, listener) => {
      presentationListeners.add(listener)
      return () => presentationListeners.delete(listener)
    },
  }
  const publishProjectedState = (next: WorkbenchState): boolean => {
    const previous = state
    state = next
    if (!workbenchPresentationChanged(previous, next, "main")) return false
    presentationSnapshot = captureWorkbenchPresentation(next, "main")
    workbenchPublications++
    for (const listener of presentationListeners) listener()
    return true
  }
  const diagnostics = createDiagnostics()
  const measurementTotals = { passes: 0, attemptedMeasurements: 0 }
  const commits: number[] = []
  const observe: { unseenEntries?: number; frame?: TranscriptFrame } = {}
  const syntax = createEmberTideSyntax()
  const setup = await testRender(<DetachedStatusNativeProbe runtime={runtime} presentationHost={presentationHost}
    threadId={fixture.threadId} viewport={viewport} syntax={syntax} diagnostics={diagnostics}
    measurementTotals={measurementTotals} observe={observe} commits={commits} />, viewport)
  try {
    for (let pass = 0; pass < 8; pass++) {
      await act(async () => { await setup.flush(); await setup.renderOnce() })
      if (runtime.getSnapshot().geometry.measuredBlockCount > 0 && diagnostics.pendingAfter === 0) break
    }
    assert(runtime.getSnapshot().geometry.measuredBlockCount > 0, "connected detached probe must settle native geometry")
    assert.equal(diagnostics.pendingAfter, 0)
    let quiescentPasses = 0
    for (let pass = 0; pass < 8 && quiescentPasses < 2; pass++) {
      const attemptedBefore = measurementTotals.attemptedMeasurements
      await act(async () => { await setup.flush(); await setup.renderOnce() })
      const attempted = measurementTotals.attemptedMeasurements - attemptedBefore
      quiescentPasses = attempted === 0 && diagnostics.pendingAfter === 0 ? quiescentPasses + 1 : 0
    }
    assert.equal(quiescentPasses, 2, "connected detached probe must drain native measurement work before timing")
    const scroll = setup.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable
    const rootsBefore = mountedBlockRoots(scroll)
    const pinned = runtime.getSnapshot()
    assertMountedRoots(pinned, rootsBefore)
    assert.equal(observe.unseenEntries, fixture.blockCount)

    const item = Object.freeze({
      id: fixture.nextItemId, turnId: fixture.nextTurnId, kind: "assistant" as const,
      markdown: "Detached status-only publication.", status: "running" as const,
    })
    commits.length = 0
    measurementReports = 0
    workbenchPublications = 0
    const firstMeasurementPassesBefore = measurementTotals.passes
    const firstAttemptedMeasurementsBefore = measurementTotals.attemptedMeasurements
    let runtimePublications = 0
    const stopRuntime = runtime.subscribe(() => { runtimePublications++ })
    const firstStarted = performance.now()
    await act(async () => {
      const projected = applyConversationEvent(state, {
        type: "item.started", threadId: fixture.threadId, item,
      }).state
      assert.equal(publishProjectedState(projected), true)
      const workspace = state.workspaces[fixture.threadId]!
      const result = runtime.update({
        threadId: fixture.threadId,
        canonicalGeneration: workspace.canonicalGeneration,
        canonicalRevision: workspace.canonicalRevision,
        conversation: workspace.conversation,
        transcript: workspace.transcript,
        mode: "detached",
        canonicalDamage: { kind: "blocks", itemIds: [fixture.nextItemId] },
      })
      assert.equal(result, pinned)
      await setup.flush()
    })
    const firstSettlementMs = performance.now() - firstStarted
    const firstCommits = commits.length
    const firstMeasurementReports = measurementReports
    const firstMeasurementPasses = measurementTotals.passes - firstMeasurementPassesBefore
    const firstAttemptedMeasurements = measurementTotals.attemptedMeasurements - firstAttemptedMeasurementsBefore
    const rootsAfterFirst = mountedBlockRoots(scroll)
    let retainedAfterFirst = 0
    for (const [id, root] of rootsBefore) if (rootsAfterFirst.get(id) === root) retainedAfterFirst++
    assert.equal(state.workspaces[fixture.threadId]!.transcript.unseenEntries, fixture.blockCount + 1)
    assert.equal(observe.unseenEntries, fixture.blockCount + 1)
    assert.equal(workbenchPublications, 1)
    assert.equal(runtimePublications, 0)
    assert.equal(firstCommits, 1)
    assert.equal(firstMeasurementReports, 0)
    assert.equal(firstAttemptedMeasurements, 0)
    assert.equal(rootsAfterFirst.size, rootsBefore.size)
    assert.equal(retainedAfterFirst, rootsBefore.size)

    commits.length = 0
    measurementReports = 0
    workbenchPublications = 0
    const repeatMeasurementPassesBefore = measurementTotals.passes
    const repeatAttemptedMeasurementsBefore = measurementTotals.attemptedMeasurements
    const repeatStarted = performance.now()
    await act(async () => {
      const projected = applyConversationEvent(state, {
        type: "item.delta", threadId: fixture.threadId, itemId: fixture.nextItemId, delta: " More.",
      }).state
      assert.equal(publishProjectedState(projected), false)
      const workspace = state.workspaces[fixture.threadId]!
      const result = runtime.update({
        threadId: fixture.threadId,
        canonicalGeneration: workspace.canonicalGeneration,
        canonicalRevision: workspace.canonicalRevision,
        conversation: workspace.conversation,
        transcript: workspace.transcript,
        mode: "detached",
        canonicalDamage: { kind: "blocks", itemIds: [fixture.nextItemId] },
      })
      assert.equal(result, pinned)
      await setup.flush()
    })
    const repeatSettlementMs = performance.now() - repeatStarted
    const repeatMeasurementPasses = measurementTotals.passes - repeatMeasurementPassesBefore
    const repeatAttemptedMeasurements = measurementTotals.attemptedMeasurements - repeatAttemptedMeasurementsBefore
    stopRuntime()
    const rootsAfterRepeat = mountedBlockRoots(scroll)
    let retainedAfterRepeat = 0
    for (const [id, root] of rootsBefore) if (rootsAfterRepeat.get(id) === root) retainedAfterRepeat++
    assert.equal(state.workspaces[fixture.threadId]!.transcript.unseenEntries, fixture.blockCount + 1)
    assert.equal(observe.unseenEntries, fixture.blockCount + 1)
    assert.equal(workbenchPublications, 0)
    assert.equal(runtimePublications, 0)
    assert.equal(commits.length, 0)
    assert.equal(measurementReports, 0)
    assert.equal(repeatAttemptedMeasurements, 0)
    assert.equal(rootsAfterRepeat.size, rootsBefore.size)
    assert.equal(retainedAfterRepeat, rootsBefore.size)

    printResult({
      scenario: "detached-status-native-publication",
      materialization: "windowed-production",
      boundary: "workbench-selector-react-runtime-native-root-and-measurement-scheduler",
      blockCount: fixture.blockCount,
      viewport,
      mode: "detached",
      fixture: { contentShape: "one-semantic-item-per-turn-with-complete-unseen-backlog",
        contentHash: fixture.contentHash, setupExcludedFromTiming: true,
        excludedSetup: "initial Workbench/runtime construction, React/OpenTUI mount, and native geometry settlement" },
      operationCounts: {
        mountedBlocks: rootsBefore.size,
        unseenEntriesBefore: fixture.blockCount,
        unseenEntriesAfter: fixture.blockCount + 1,
        firstDistinctItem: {
          workbenchPublications: 1, runtimePublications: 0, reactCommits: firstCommits,
          measurementPasses: firstMeasurementPasses, measurementReports: firstMeasurementReports,
          attemptedMeasurements: firstAttemptedMeasurements,
          retainedNativeRoots: retainedAfterFirst, mountedNativeRoots: rootsAfterFirst.size - retainedAfterFirst,
          unmountedNativeRoots: rootsBefore.size - retainedAfterFirst,
        },
        repeatedItemDelta: {
          workbenchPublications, runtimePublications, reactCommits: commits.length,
          measurementPasses: repeatMeasurementPasses, measurementReports,
          attemptedMeasurements: repeatAttemptedMeasurements,
          retainedNativeRoots: retainedAfterRepeat, mountedNativeRoots: rootsAfterRepeat.size - retainedAfterRepeat,
          unmountedNativeRoots: rootsBefore.size - retainedAfterRepeat,
        },
      },
      timingsMs: {
        firstDistinctStatusSettlement: Number(firstSettlementMs.toFixed(6)),
        repeatedItemNoPublicationSettlement: Number(repeatSettlementMs.toFixed(6)),
      },
      samples: { warmup: 0, measured: 1 },
    })
  } finally {
    runtime.dispose()
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
}

async function nativeStructuralAdmissionBaseline(
  fixture: ReturnType<typeof buildTranscriptStructuralScalingFixture>,
  viewport: Readonly<{ width: number; height: number }>,
): Promise<void> {
  forceGc()
  const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", {
    canonicalDamage: { kind: "full" },
  }), { windowPolicy: { viewportRows: viewport.height, overscanRows: viewport.height } })
  const commits: number[] = []
  const scrollRef = createRef<ScrollBoxRenderable | null>()
  const syntax = createEmberTideSyntax()
  const setup = await testRender(
    <RuntimeNativeMountProbe runtime={runtime} commits={commits} scrollRef={scrollRef} syntax={syntax} />,
    viewport,
  )
  try {
    for (let frameIndex = 0; frameIndex < 4; frameIndex++) {
      await act(async () => { await setup.flush(); await setup.renderOnce(); await Bun.sleep(2) })
    }
    const scroll = scrollRef.current
    assert(scroll, "TranscriptViewport did not mount its scrollbox")

    // Establish native geometry outside the measured structural admission so
    // the post-append pass can prove it measures only newly mounted work.
    let seedDiagnostics = createDiagnostics()
    let seededLayout: ReturnType<typeof measureRenderedTranscript>
    for (let pass = 0; pass < 8; pass++) {
      seedDiagnostics = createDiagnostics()
      await act(async () => {
        seededLayout = measureRenderedTranscript(setup.renderer, scroll, {
          frame: runtime.getSnapshot(), runtime, styleRevision, diagnostics: seedDiagnostics,
        })
        await setup.flush(); await setup.renderOnce()
      })
      if (seededLayout && seedDiagnostics.pendingAfter === 0) break
    }
    assert(seededLayout, "seeded structural geometry must produce a layout before admission")
    assert.equal(seedDiagnostics.pendingAfter, 0, "seeded structural geometry must drain pending measurements")
    const initial = runtime.getSnapshot()
    const rootsBefore = mountedBlockRoots(scroll)
    assertMountedRoots(initial, rootsBefore)
    assertBoundedNativeShape(initial.window.blocks.length, mountedTreeCounts(scroll))

    const turnEvent = Object.freeze({
      type: "turn.started" as const, threadId: fixture.threadId, turnId: fixture.nextTurnId,
    })
    const item = Object.freeze({
      id: fixture.nextItemId, turnId: fixture.nextTurnId, kind: "assistant" as const,
      markdown: "New structural native tail block.", status: "running" as const,
    })
    const canonicalDiagnostics = createConversationReductionDiagnostics()
    const afterTurn: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: fixture.before.canonicalRevision + 1,
      conversation: reduceConversationWithDiagnostics(fixture.before.conversation, turnEvent, canonicalDiagnostics),
      transcript: fixture.before.transcript,
    })
    const afterItem: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: afterTurn.canonicalRevision + 1,
      conversation: reduceConversationWithDiagnostics(afterTurn.conversation, Object.freeze({
        type: "item.started" as const, threadId: fixture.threadId, item,
      }), canonicalDiagnostics),
      transcript: syncTranscriptItem(afterTurn.transcript, item),
    })

    let runtimePublications = 0
    const unsubscribe = runtime.subscribe(() => { runtimePublications++ })
    commits.length = 0
    const emptyStarted = performance.now()
    await act(async () => {
      runtime.update(runtimeInput(fixture, afterTurn, "follow", {
        canonicalDamage: { kind: "blocks", itemIds: [] },
      }))
      await setup.flush(); await setup.renderOnce()
    })
    const emptyTurnSettlementMs = performance.now() - emptyStarted
    const emptyTurnReactCommits = commits.length
    const emptyTurnReactDurations = [...commits]
    const emptyFrame = runtime.getSnapshot()
    const rootsAfterEmptyTurn = mountedBlockRoots(scroll)
    assert.equal(emptyFrame.window, initial.window)
    assert.equal(emptyFrame.geometry, initial.geometry)
    assert.equal(rootsAfterEmptyTurn.size, rootsBefore.size)
    for (const [id, root] of rootsBefore) assert.equal(rootsAfterEmptyTurn.get(id), root)

    commits.length = 0
    const itemStarted = performance.now()
    let itemRuntimeUpdateMs = 0
    await act(async () => {
      const updateStarted = performance.now()
      runtime.update(runtimeInput(fixture, afterItem, "follow", {
        canonicalDamage: { kind: "blocks", itemIds: [fixture.nextItemId] },
      }))
      itemRuntimeUpdateMs = performance.now() - updateStarted
      await setup.flush(); await setup.renderOnce()
    })
    const itemSettlementMs = performance.now() - itemStarted
    const itemReactCommits = commits.length
    const itemReactDurations = [...commits]
    unsubscribe()
    const admitted = runtime.getSnapshot()
    const rootsAfterItem = mountedBlockRoots(scroll)
    assertMountedRoots(admitted, rootsAfterItem)
    assertBoundedNativeShape(admitted.window.blocks.length, mountedTreeCounts(scroll))
    let retainedRoots = 0
    for (const [id, root] of rootsAfterEmptyTurn) if (rootsAfterItem.get(id) === root) retainedRoots++
    const mountedRoots = rootsAfterItem.size - retainedRoots
    const unmountedRoots = rootsAfterEmptyTurn.size - retainedRoots
    assert.equal(mountedRoots, 1)
    assert(unmountedRoots <= 1)
    assert.equal(runtimePublications, 2)
    assert.equal(emptyTurnReactCommits, 1)
    assert.equal(itemReactCommits, 1)

    let measurementPublications = 0
    const unsubscribeMeasurement = runtime.subscribe(() => { measurementPublications++ })
    const measurementDiagnostics = createDiagnostics()
    let measurement!: ReturnType<typeof timed<ReturnType<typeof measureRenderedTranscript>>>
    commits.length = 0
    await act(async () => {
      measurement = timed(() => measureRenderedTranscript(setup.renderer, scroll, {
        frame: admitted, runtime, styleRevision, diagnostics: measurementDiagnostics,
      }))
      await setup.flush(); await setup.renderOnce()
    })
    unsubscribeMeasurement()
    assert.equal(measurementDiagnostics.attemptedMeasurements, 1)
    assert(measurementDiagnostics.changedMeasurements <= 1)
    assert(measurementDiagnostics.attemptedMeasurements <= viewport.height)
    assert.equal(measurementPublications, measurementDiagnostics.changedMeasurements > 0 ? 1 : 0)
    await act(async () => {
      const layout = measureRenderedTranscript(setup.renderer, scroll, {
        frame: runtime.getSnapshot(), runtime, styleRevision,
      })
      assert(layout, "structural native geometry must settle on its acknowledgement pass")
      await setup.flush(); await setup.renderOnce()
    })

    const beforeCompletion = runtime.getSnapshot()
    const rootsBeforeCompletion = mountedBlockRoots(scroll)
    const completedSnapshot: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: afterItem.canonicalRevision + 1,
      conversation: reduceConversationWithDiagnostics(afterItem.conversation, Object.freeze({
        type: "turn.completed" as const, threadId: fixture.threadId, turnId: fixture.nextTurnId,
        outcome: "complete" as const, durationMs: 0,
      }), createConversationReductionDiagnostics()),
      transcript: afterItem.transcript,
    })
    let completionRuntimePublications = 0
    const stopCompletionRuntime = runtime.subscribe(() => { completionRuntimePublications++ })
    commits.length = 0
    const completionStarted = performance.now()
    let completionRuntimeUpdateMs = 0
    await act(async () => {
      const updateStarted = performance.now()
      runtime.update(runtimeInput(fixture, completedSnapshot, "follow", {
        canonicalDamage: { kind: "blocks", itemIds: [] },
      }))
      completionRuntimeUpdateMs = performance.now() - updateStarted
      await setup.flush(); await setup.renderOnce()
    })
    const completionSettlementMs = performance.now() - completionStarted
    stopCompletionRuntime()
    const completionReactCommits = commits.length
    const completionReactDurations = [...commits]
    const completed = runtime.getSnapshot()
    const rootsAfterCompletion = mountedBlockRoots(scroll)
    assertMountedRoots(completed, rootsAfterCompletion)
    assertBoundedNativeShape(completed.window.blocks.length, mountedTreeCounts(scroll))
    let completionRetainedRoots = 0
    for (const [id, root] of rootsBeforeCompletion) if (rootsAfterCompletion.get(id) === root) completionRetainedRoots++
    const completionMountedRoots = rootsAfterCompletion.size - completionRetainedRoots
    const completionUnmountedRoots = rootsBeforeCompletion.size - completionRetainedRoots
    assert.equal(completionMountedRoots, 1)
    assert.equal(completionUnmountedRoots, 0)
    assert.equal(completionRuntimePublications, 1)
    assert.equal(completionReactCommits, 1)

    let completionMeasurementPublications = 0
    const stopCompletionMeasurement = runtime.subscribe(() => { completionMeasurementPublications++ })
    const completionMeasurementDiagnostics = createDiagnostics()
    commits.length = 0
    let completionMeasurement!: ReturnType<typeof timed<ReturnType<typeof measureRenderedTranscript>>>
    await act(async () => {
      completionMeasurement = timed(() => measureRenderedTranscript(setup.renderer, scroll, {
        frame: completed, runtime, styleRevision, diagnostics: completionMeasurementDiagnostics,
      }))
      await setup.flush(); await setup.renderOnce()
    })
    stopCompletionMeasurement()
    assert.equal(completionMeasurementDiagnostics.candidateBlocks, 2)
    assert.equal(completionMeasurementDiagnostics.attemptedMeasurements, 2)
    assert.equal(completionMeasurementDiagnostics.changedMeasurements, 2)
    assert.equal(completionMeasurementDiagnostics.trackedMountedRoots, rootsAfterCompletion.size)
    assert.equal(completionMeasurementPublications,
      completionMeasurementDiagnostics.changedMeasurements > 0 ? 1 : 0)
    await act(async () => {
      const layout = measureRenderedTranscript(setup.renderer, scroll, {
        frame: runtime.getSnapshot(), runtime, styleRevision,
      })
      assert(layout, "completion activity geometry must settle on its acknowledgement pass")
      await setup.flush(); await setup.renderOnce()
    })

    printResult({
      scenario: "tail-turn-completion-native-activity",
      materialization: "windowed-production",
      boundary: "runtime-react-native-root-and-measurement",
      blockCount: fixture.blockCount,
      viewport,
      mode: "follow",
      fixture: { contentShape: "one-semantic-item-per-turn-plus-one-running-tail", contentHash: fixture.contentHash,
        setupExcludedFromTiming: true,
        excludedSetup: "initial runtime/React/OpenTUI mount, tail admission, and settled native geometry" },
      operationCounts: {
        completeBlocksBefore: beforeCompletion.blocks.length,
        completeBlocksAfter: completed.blocks.length,
        mountedBlocksBefore: rootsBeforeCompletion.size,
        mountedBlocksAfter: rootsAfterCompletion.size,
        retainedRoots: completionRetainedRoots,
        mountedRoots: completionMountedRoots,
        unmountedRoots: completionUnmountedRoots,
        runtimePublications: completionRuntimePublications,
        reactCommits: completionReactCommits,
        measurementPublications: completionMeasurementPublications,
        measuredBlocks: completionMeasurementDiagnostics.attemptedMeasurements,
        acceptedHeightCorrections: completionMeasurementDiagnostics.changedMeasurements,
        candidateBlocks: completionMeasurementDiagnostics.candidateBlocks,
        trackedMountedRoots: completionMeasurementDiagnostics.trackedMountedRoots,
      },
      timingsMs: {
        runtimeUpdate: Number(completionRuntimeUpdateMs.toFixed(6)),
        reactCommitDurations: stats(completionReactDurations),
        postRuntimeReactNativeSettlement: Number((completionSettlementMs - completionRuntimeUpdateMs).toFixed(6)),
        completeRuntimeReactNativeSettlement: Number(completionSettlementMs.toFixed(6)),
        measurementPublication: Number(completionMeasurement.milliseconds.toFixed(6)),
      },
      samples: { warmup: 0, measured: 1 },
    })

    printResult({
      scenario: "structural-tail-native-admission",
      materialization: "windowed-production",
      boundary: "runtime-react-native-root-and-measurement",
      blockCount: fixture.blockCount,
      viewport,
      mode: "follow",
      fixture: { contentShape: "one-semantic-item-per-turn", contentHash: fixture.contentHash, setupExcludedFromTiming: true,
        excludedSetup: "initial runtime construction, React/OpenTUI mount, and initial native geometry settlement" },
      operationCounts: {
        completeBlocksBefore: initial.blocks.length, completeBlocksAfter: admitted.blocks.length,
        mountedBlocksBefore: rootsBefore.size, mountedBlocksAfter: rootsAfterItem.size,
        retainedRoots, mountedRoots, unmountedRoots, runtimePublications,
        emptyTurnReactCommits, itemReactCommits,
        measurementPublications, measuredBlocks: measurementDiagnostics.attemptedMeasurements,
        acceptedHeightCorrections: measurementDiagnostics.changedMeasurements,
        candidateBlocks: measurementDiagnostics.candidateBlocks,
        attemptedMeasurements: measurementDiagnostics.attemptedMeasurements,
        trackedMountedRoots: measurementDiagnostics.trackedMountedRoots,
      },
      timingsMs: {
        emptyTurnRuntimeReactNativeSettlement: Number(emptyTurnSettlementMs.toFixed(6)),
        emptyTurnReactCommitDurations: stats(emptyTurnReactDurations),
        itemRuntimeUpdate: Number(itemRuntimeUpdateMs.toFixed(6)),
        itemReactCommitDurations: stats(itemReactDurations),
        itemPostRuntimeReactNativeSettlement: Number((itemSettlementMs - itemRuntimeUpdateMs).toFixed(6)),
        itemRuntimeReactNativeSettlement: Number(itemSettlementMs.toFixed(6)),
        postAdmissionMeasurementPublication: Number(measurement.milliseconds.toFixed(6)),
      },
      samples: { warmup: 0, measured: 1 },
    })
  } finally {
    runtime.dispose()
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
}

const oversizedNativeFollowRoots = new Map<string, number>()
const oversizedNativeDetachedRoots = new Map<string, number>()
const oversizedNativeFollowMeasurements = new Map<string, number>()
const oversizedNativeDetachedMeasurements = new Map<string, number>()

async function oversizedCommandNativeBaseline(
  targetBlockCount: number,
  viewport: Readonly<{ width: number; height: number }>,
): Promise<void> {
  const fixture = buildTranscriptStructuralScalingFixture(targetBlockCount - oversizedCommandAddedBlockCount)
  const snapshot = oversizedCommandSnapshot(fixture)
  const transcript = snapshot.transcript
  forceGc()
  const runtime = new TranscriptRuntime(runtimeInput(fixture, snapshot, "follow", {
    canonicalDamage: { kind: "full" },
  }), { windowPolicy: { viewportRows: viewport.height, overscanRows: viewport.height } })
  const commits: number[] = []
  const scrollRef = createRef<ScrollBoxRenderable | null>()
  const syntax = createEmberTideSyntax()
  const setup = await testRender(<RuntimeNativeMountProbe runtime={runtime} commits={commits}
    scrollRef={scrollRef} syntax={syntax} />, viewport)
  try {
    for (let frameIndex = 0; frameIndex < 4; frameIndex++) {
      await act(async () => { await setup.flush(); await setup.renderOnce(); await Bun.sleep(2) })
    }
    const scroll = scrollRef.current
    assert(scroll, "oversized command viewport did not mount its scrollbox")
    const followFrame = runtime.getSnapshot()
    assert.equal(followFrame.blocks.length, targetBlockCount)
    const rootsBefore = mountedBlockRoots(scroll)
    assertMountedRoots(followFrame, rootsBefore)
    const viewportKey = `${viewport.width}x${viewport.height}`
    const followDiagnostics = createDiagnostics()
    let followMeasurementPublications = 0
    const stopFollowMeasurement = runtime.subscribe(() => { followMeasurementPublications++ })
    let followMeasured!: ReturnType<typeof timed<ReturnType<typeof measureRenderedTranscript>>>
    await act(async () => {
      followMeasured = timed(() => measureRenderedTranscript(setup.renderer, scroll, {
        frame: followFrame, runtime, styleRevision, diagnostics: followDiagnostics,
      }))
      await setup.flush()
    })
    stopFollowMeasurement()
    assert.equal(followMeasured.value, undefined)
    assert.equal(followDiagnostics.attemptedMeasurements, rootsBefore.size)
    assert.equal(followDiagnostics.trackedMountedRoots, rootsBefore.size)
    assert.equal(followMeasurementPublications, 1)
    const followAckDiagnostics = createDiagnostics()
    let followAckPublications = 0
    const stopFollowAck = runtime.subscribe(() => { followAckPublications++ })
    let followAcknowledged!: ReturnType<typeof timed<ReturnType<typeof measureRenderedTranscript>>>
    await act(async () => {
      followAcknowledged = timed(() => measureRenderedTranscript(setup.renderer, scroll, {
        frame: runtime.getSnapshot(), runtime, styleRevision, diagnostics: followAckDiagnostics,
      }))
      assert(followAcknowledged.value, "oversized command follow geometry did not settle")
      await setup.flush(); await setup.renderOnce()
    })
    stopFollowAck()
    assert.equal(followAckDiagnostics.changedMeasurements, 0)
    assert.equal(followAckDiagnostics.pendingAfter, 0)
    assert.equal(followAckPublications, 0)
    const settledFollowFrame = runtime.getSnapshot()
    const settledFollowRoots = mountedBlockRoots(scroll)
    assertMountedRoots(settledFollowFrame, settledFollowRoots)
    assertBoundedNativeShape(settledFollowFrame.window.blocks.length, mountedTreeCounts(scroll))
    assert(settledFollowRoots.size <= viewport.height * 2)
    oversizedNativeFollowRoots.set(viewportKey,
      oversizedNativeFollowRoots.get(viewportKey) ?? settledFollowRoots.size)
    assert.equal(settledFollowRoots.size, oversizedNativeFollowRoots.get(viewportKey))
    const followMeasurementAttempts = followDiagnostics.attemptedMeasurements + followAckDiagnostics.attemptedMeasurements
    oversizedNativeFollowMeasurements.set(viewportKey,
      oversizedNativeFollowMeasurements.get(viewportKey) ?? followMeasurementAttempts)
    assert.equal(followMeasurementAttempts, oversizedNativeFollowMeasurements.get(viewportKey))

    const projection = transcript.projectionById[oversizedCommandFixture.item.id]!
    const point = Object.freeze({ itemId: oversizedCommandFixture.item.id,
      graphemeOffset: Math.floor(projection.sourceSpans.length / 2) })
    const detachedTranscript = Object.freeze({ ...transcript, cursor: point,
      viewport: Object.freeze({ kind: "point" as const, point, preferredScreenRow: 8 }) })
    const detachedSnapshot: TranscriptFixtureSnapshot = Object.freeze({ ...snapshot, transcript: detachedTranscript })
    commits.length = 0
    let revealPublications = 0
    const stopReveal = runtime.subscribe(() => { revealPublications++ })
    const completeSettlementStarted = performance.now()
    const revealStarted = performance.now()
    await act(async () => {
      runtime.update(runtimeInput(fixture, detachedSnapshot, "detached", {
        presentationDamage: { kind: "view" },
        reveal: { id: targetBlockCount, point, reason: "jump" },
      }))
      await setup.flush(); await setup.renderOnce()
    })
    const revealSettlementMs = performance.now() - revealStarted
    stopReveal()
    const detachedFrame = runtime.getSnapshot()
    const rootsAfterReveal = mountedBlockRoots(scroll)
    assertMountedRoots(detachedFrame, rootsAfterReveal)
    assert(pointIsMaterialized(detachedFrame.window.blocks, point))
    assert.equal(revealPublications, 1)
    assert.equal(commits.length, 1)
    const revealReactCommits = commits.length

    const detachedDiagnostics = createDiagnostics()
    let detachedMeasurementPublications = 0
    const stopDetachedMeasurement = runtime.subscribe(() => { detachedMeasurementPublications++ })
    let detachedMeasured!: ReturnType<typeof timed<ReturnType<typeof measureRenderedTranscript>>>
    await act(async () => {
      detachedMeasured = timed(() => measureRenderedTranscript(setup.renderer, scroll, {
        frame: detachedFrame, runtime, styleRevision, diagnostics: detachedDiagnostics,
      }))
      await setup.flush()
    })
    stopDetachedMeasurement()
    assert(detachedDiagnostics.attemptedMeasurements <= rootsAfterReveal.size)
    assert(detachedDiagnostics.trackedMountedRoots <= rootsAfterReveal.size)
    assert(detachedMeasurementPublications <= 1)
    const detachedAckPasses: RenderedLayoutDiagnostics[] = []
    let detachedAckPublications = 0, detachedAckMilliseconds = 0
    let detachedAcknowledged: ReturnType<typeof measureRenderedTranscript>
    for (let pass = 0; pass < 4; pass++) {
      const passDiagnostics = createDiagnostics()
      let passPublications = 0
      const stopDetachedAck = runtime.subscribe(() => { passPublications++ })
      let measured!: ReturnType<typeof timed<ReturnType<typeof measureRenderedTranscript>>>
      await act(async () => {
        measured = timed(() => measureRenderedTranscript(setup.renderer, scroll, {
          frame: runtime.getSnapshot(), runtime, styleRevision, diagnostics: passDiagnostics,
        }))
        await setup.flush(); await setup.renderOnce()
      })
      stopDetachedAck()
      detachedAckPasses.push(passDiagnostics)
      detachedAckPublications += passPublications
      detachedAckMilliseconds += measured.milliseconds
      detachedAcknowledged = measured.value
      if (detachedAcknowledged && passDiagnostics.changedMeasurements === 0 && passDiagnostics.pendingAfter === 0) break
    }
    const finalDetachedAck = detachedAckPasses.at(-1)!
    assert(detachedAcknowledged, "oversized command detached geometry did not settle")
    assert.equal(finalDetachedAck.changedMeasurements, 0)
    assert.equal(finalDetachedAck.pendingAfter, 0)
    const settledDetachedFrame = runtime.getSnapshot()
    const settledDetachedRoots = mountedBlockRoots(scroll)
    assertMountedRoots(settledDetachedFrame, settledDetachedRoots)
    assert(pointIsMaterialized(settledDetachedFrame.window.blocks, point))
    assertBoundedNativeShape(settledDetachedFrame.window.blocks.length, mountedTreeCounts(scroll))
    assert(settledDetachedRoots.size <= viewport.height * 2)
    oversizedNativeDetachedRoots.set(viewportKey,
      oversizedNativeDetachedRoots.get(viewportKey) ?? settledDetachedRoots.size)
    assert.equal(settledDetachedRoots.size, oversizedNativeDetachedRoots.get(viewportKey))
    const detachedAckAttemptedMeasurements = detachedAckPasses.reduce((sum, pass) => sum + pass.attemptedMeasurements, 0)
    const detachedAckChangedMeasurements = detachedAckPasses.reduce((sum, pass) => sum + pass.changedMeasurements, 0)
    const detachedAckCandidateBlocks = detachedAckPasses.reduce((sum, pass) => sum + pass.candidateBlocks, 0)
    const detachedMeasurementAttempts = detachedDiagnostics.attemptedMeasurements + detachedAckAttemptedMeasurements
    oversizedNativeDetachedMeasurements.set(viewportKey,
      oversizedNativeDetachedMeasurements.get(viewportKey) ?? detachedMeasurementAttempts)
    assert.equal(detachedMeasurementAttempts, oversizedNativeDetachedMeasurements.get(viewportKey))
    const completeRevealMeasurementSettlementMs = performance.now() - completeSettlementStarted
    const measurementSettlementReactCommits = commits.length - revealReactCommits
    assert.equal(measurementSettlementReactCommits,
      detachedMeasurementPublications + detachedAckPublications)

    printResult({
      fixtureVersion: fixture.fixtureVersion,
      scenario: "oversized-command-native-fragments",
      materialization: "windowed-production",
      boundary: "runtime-react-native-root-and-measurement",
      blockCount: targetBlockCount,
      historyBlockCount: fixture.blockCount,
      viewport,
      mode: "follow-to-detached-reveal",
      fixture: { contentShape: oversizedCommandFixture.shape, contentHash: oversizedCommandContentHash,
        chars: oversizedCommandFixture.source.length,
        deterministicFixtureSegments: oversizedCommandFixture.segments.length, setupExcludedFromTiming: true },
      operationCounts: {
        followMountedBlocks: settledFollowRoots.size,
        followCandidateBlocks: followDiagnostics.candidateBlocks,
        followAttemptedMeasurements: followDiagnostics.attemptedMeasurements,
        followChangedMeasurements: followDiagnostics.changedMeasurements,
        followTrackedMountedRoots: followDiagnostics.trackedMountedRoots,
        followAckCandidateBlocks: followAckDiagnostics.candidateBlocks,
        followAckAttemptedMeasurements: followAckDiagnostics.attemptedMeasurements,
        followAckChangedMeasurements: followAckDiagnostics.changedMeasurements,
        followFinalPendingMeasurements: followAckDiagnostics.pendingAfter,
        followMeasurementPublications,
        followAckPublications,
        detachedMountedBlocks: settledDetachedRoots.size,
        detachedCandidateBlocks: detachedDiagnostics.candidateBlocks,
        detachedAttemptedMeasurements: detachedDiagnostics.attemptedMeasurements,
        detachedChangedMeasurements: detachedDiagnostics.changedMeasurements,
        detachedTrackedMountedRoots: detachedDiagnostics.trackedMountedRoots,
        detachedAcknowledgementPasses: detachedAckPasses.length,
        detachedAckCandidateBlocks,
        detachedAckAttemptedMeasurements,
        detachedAckChangedMeasurements,
        detachedFinalPendingMeasurements: finalDetachedAck.pendingAfter,
        detachedMeasurementPublications,
        detachedAckPublications,
        revealPublications,
        revealReactCommits,
        measurementSettlementReactCommits,
        totalReactCommits: commits.length,
        targetMaterialized: pointIsMaterialized(settledDetachedFrame.window.blocks, point),
      },
      timingsMs: { followMeasurementPublication: Number(followMeasured.milliseconds.toFixed(6)),
        followMeasurementAcknowledgement: Number(followAcknowledged.milliseconds.toFixed(6)),
        revealRuntimeReactNativeSettlement: Number(revealSettlementMs.toFixed(6)),
        detachedMeasurementPublication: Number(detachedMeasured.milliseconds.toFixed(6)),
        detachedMeasurementAcknowledgement: Number(detachedAckMilliseconds.toFixed(6)),
        completeRevealMeasurementSettlement: Number(completeRevealMeasurementSettlementMs.toFixed(6)) },
      samples: { warmup: 0, measured: 1 },
    })
  } finally {
    runtime.dispose()
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
}

async function nativeMountBaseline(fixture: ReturnType<typeof buildTranscriptScalingFixture>, viewport: Readonly<{ width: number; height: number }>): Promise<void> {
  forceGc()
  const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", { canonicalDamage: { kind: "full" } }), {
    windowPolicy: { viewportRows: viewport.height, overscanRows: viewport.height },
  })
  const frame = runtime.getSnapshot()
  const commits: number[] = []
  const scrollRef = createRef<ScrollBoxRenderable | null>()
  const syntax = createEmberTideSyntax()
  const started = performance.now()
  const setup = await testRender(<RuntimeNativeMountProbe runtime={runtime} commits={commits} scrollRef={scrollRef} syntax={syntax} />, viewport)
  try {
    for (let frameIndex = 0; frameIndex < 4; frameIndex++) {
      await act(async () => { await setup.flush(); await setup.renderOnce(); await Bun.sleep(2) })
    }
    const nativeMountAndLayoutMs = performance.now() - started
    const scroll = scrollRef.current
    assert(scroll, "TranscriptViewport did not mount its scrollbox")
    const rootsBefore = mountedBlockRoots(scroll)
    let steadyRoots = rootsBefore
    const nativeTreeBefore = mountedTreeCounts(scroll)
    assertMountedRoots(frame, rootsBefore)
    assertBoundedNativeShape(frame.window.blocks.length, nativeTreeBefore)
    if (process.env.VIMEX_WINDOWING_GEOMETRY_BASELINE === "1") {
      let measurementPublications = 0
      const unsubscribeMeasurement = runtime.subscribe(() => { measurementPublications++ })
      let measurement!: ReturnType<typeof timed<ReturnType<typeof measureRenderedTranscript>>>
      const diagnostics = createDiagnostics()
      await act(async () => {
        measurement = timed(() => measureRenderedTranscript(setup.renderer, scroll, {
          frame: runtime.getSnapshot(), runtime, styleRevision, diagnostics,
        }))
        await setup.flush()
      })
      unsubscribeMeasurement()
      assert.equal(measurement.value, undefined, "the first scheduler pass must publish geometry before returning a layout")
      const measuredFrame = runtime.getSnapshot()
      const measuredBlocks = diagnostics.changedMeasurements
      assert.equal(measuredBlocks, frame.window.blocks.length)
      assert(measuredFrame.geometry.measuredBlockCount <= measuredFrame.window.blocks.length)
      assert.equal(measuredFrame.geometry.blockRows.length, measuredFrame.window.blocks.length)
      assert.equal(diagnostics.attemptedMeasurements, frame.window.blocks.length)
      assert.equal(diagnostics.trackedMountedRoots, frame.window.blocks.length)
      assert.equal(diagnostics.visibleBeforeOverscan, true)
      assert.equal(measurementPublications, 1)
      let settledLayout: ReturnType<typeof measureRenderedTranscript>
      await act(async () => {
        settledLayout = measureRenderedTranscript(setup.renderer, scroll, { frame: measuredFrame, runtime, styleRevision })
        await setup.flush(); await setup.renderOnce()
      })
      assert(settledLayout, "published native geometry must build a layout on the next scheduler pass")
      steadyRoots = mountedBlockRoots(scroll)
      assertMountedRoots(runtime.getSnapshot(), steadyRoots)
      const blocksWithPoints = Object.values(measuredFrame.geometry.byBlockKey).filter(geometry => (geometry.pointCount ?? Object.keys(geometry.points).length) > 0).length
      printResult({
        scenario: "native-geometry-measurement",
        materialization: "windowed-production",
        boundary: "rendered-layout-scheduler",
        blockCount: fixture.blockCount,
        viewport,
        mode: "follow",
        fixture: { contentShape: "rendered-mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
        operationCounts: { mountedBlocksBeforeCorrection: rootsBefore.size, measuredBlocks, changedBlocks: 0, publications: measurementPublications,
          materializedWindowBlocksAfterCorrection: measuredFrame.window.blocks.length, acceptedHeightCorrections: diagnostics.changedMeasurements,
          retainedDetailedGeometryAfterCorrection: measuredFrame.geometry.measuredBlockCount,
          candidateBlocks: diagnostics.candidateBlocks, visibleCandidates: diagnostics.visibleCandidates,
          overscanCandidates: diagnostics.overscanCandidates, attemptedMeasurements: diagnostics.attemptedMeasurements,
          trackedMountedRoots: diagnostics.trackedMountedRoots, pendingMeasurementAcknowledgements: diagnostics.pendingAfter,
          mountedNativeDescendantsBeforeCorrection: nativeTreeBefore.descendants, stableSpacerRoots: nativeTreeBefore.spacers,
          blocksWithPoints, retainedZeroPointGeometry: measuredFrame.geometry.measuredBlockCount - blocksWithPoints,
          measuredPoints: measuredFrame.geometry.totalPoints },
        timingsMs: { measurementSchedulerAndGeometryPublication: Number(measurement.milliseconds.toFixed(6)) },
        samples: { warmup: 0, measured: 1 },
      })
    }
    commits.length = 0
    let runtimePublications = 0, runtimeUpdateMs = 0
    const unsubscribe = runtime.subscribe(() => { runtimePublications++ })
    const settlementStarted = performance.now()
    await act(async () => {
      const updateStarted = performance.now()
      runtime.update(runtimeInput(fixture, fixture.afterTailDelta, "follow", {
        canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
      }))
      runtimeUpdateMs = performance.now() - updateStarted
      await setup.flush()
      await setup.renderOnce()
    })
    const endToEndFollowSettlementMs = performance.now() - settlementStarted
    unsubscribe()
    const rootsAfter = mountedBlockRoots(scroll)
    let settledFollowRoots = rootsAfter
    let settledFollowFrame = runtime.getSnapshot()
    assertMountedRoots(runtime.getSnapshot(), rootsAfter)
    let retainedBlockRoots = 0
    for (const [id, root] of steadyRoots) if (rootsAfter.get(id) === root) retainedBlockRoots++
    assert.equal(retainedBlockRoots, steadyRoots.size)
    assert.equal(runtimePublications, 1)
    assert.equal(commits.length, 1)
    printResult({
      scenario: "native-root-mount-and-follow-reconciliation",
      materialization: "windowed-production",
      boundary: "runtime-react-native-root",
      blockCount: fixture.blockCount,
      viewport,
      mode: "follow",
      fixture: { contentShape: "rendered-mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: false },
      operationCounts: { mountedBlocks: steadyRoots.size, measuredBlocks: 0, changedBlocks: 1, publications: runtimePublications,
        completeBlocks: frame.blocks.length, materializedWindowBlocks: runtime.getSnapshot().window.blocks.length, observedMountedBlockRoots: steadyRoots.size,
        retainedBlockRoots, mountedRootsDuringFollow: rootsAfter.size - retainedBlockRoots, unmountedRootsDuringFollow: steadyRoots.size - retainedBlockRoots,
        runtimePublications, reactCommits: commits.length },
      timingsMs: { testRendererReactSetupAndNativeMount: Number(nativeMountAndLayoutMs.toFixed(6)), runtimeUpdate: Number(runtimeUpdateMs.toFixed(6)),
        postUpdateReactAndNativeFrame: Number((endToEndFollowSettlementMs - runtimeUpdateMs).toFixed(6)), presentationSettlement: Number(endToEndFollowSettlementMs.toFixed(6)),
        reactCommitDurations: stats(commits) },
      samples: { warmup: 0, measured: 1 },
    })

    if (process.env.VIMEX_WINDOWING_GEOMETRY_BASELINE === "1") {
      const beforeFollowMeasurement = new Map(runtime.getSnapshot().window.blocks.map(block => {
        const root = rootsAfter.get(transcriptBlockRenderableId(block))!
        return [blockKey(block), blockNativeRevision(root)] as const
      }))
      let followMeasurementPublications = 0
      const unsubscribeFollowMeasurement = runtime.subscribe(() => { followMeasurementPublications++ })
      let followMeasurement!: ReturnType<typeof timed<ReturnType<typeof measureRenderedTranscript>>>
      const followDiagnostics = createDiagnostics()
      await act(async () => {
        followMeasurement = timed(() => measureRenderedTranscript(setup.renderer, scroll, {
          frame: runtime.getSnapshot(), runtime, styleRevision, diagnostics: followDiagnostics,
        }))
        await setup.flush()
      })
      unsubscribeFollowMeasurement()
      const followMeasuredFrame = runtime.getSnapshot()
      const measuredBlocks = followMeasuredFrame.window.blocks.filter(block => {
        const root = rootsAfter.get(transcriptBlockRenderableId(block))!
        return blockNativeRevision(root) > (beforeFollowMeasurement.get(blockKey(block)) ?? 0)
      }).length
      assert.equal(measuredBlocks, 1)
      assert(followDiagnostics.candidateBlocks <= viewport.height, "follow candidates must remain viewport-bounded")
      assert(followDiagnostics.attemptedMeasurements <= viewport.height, "follow measurement attempts must remain viewport-bounded")
      assert.equal(followMeasurementPublications, 1)
      let followedLayout: ReturnType<typeof measureRenderedTranscript>
      await act(async () => {
        followedLayout = measureRenderedTranscript(setup.renderer, scroll, { frame: followMeasuredFrame, runtime, styleRevision })
        await setup.flush(); await setup.renderOnce()
      })
      assert(followedLayout, "changed tail geometry must settle on the next scheduler pass")
      settledFollowRoots = mountedBlockRoots(scroll)
      settledFollowFrame = runtime.getSnapshot()
      assertMountedRoots(runtime.getSnapshot(), settledFollowRoots)
      printResult({
        scenario: "follow-tail-native-measurement",
        materialization: "windowed-production",
        boundary: "rendered-layout-scheduler",
        blockCount: fixture.blockCount,
        viewport,
        mode: "follow",
        fixture: { contentShape: "rendered-mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
        operationCounts: { mountedBlocks: rootsAfter.size, measuredBlocks, changedBlocks: 1, publications: followMeasurementPublications,
          materializedWindowBlocks: followMeasuredFrame.window.blocks.length, retainedMeasurements: followMeasuredFrame.geometry.measuredBlockCount,
          candidateBlocks: followDiagnostics.candidateBlocks, visibleCandidates: followDiagnostics.visibleCandidates,
          overscanCandidates: followDiagnostics.overscanCandidates, attemptedMeasurements: followDiagnostics.attemptedMeasurements,
          trackedMountedRoots: followDiagnostics.trackedMountedRoots, pendingMeasurementAcknowledgements: followDiagnostics.pendingAfter,
          measuredPoints: followMeasuredFrame.geometry.totalPoints },
        timingsMs: { measurementSchedulerAndGeometryPublication: Number(followMeasurement.milliseconds.toFixed(6)) },
        samples: { warmup: 0, measured: 1 },
      })
    }

    // Detached movement owns an exact departed-root cleanup gate even when the
    // optional geometry-reporting cell is disabled. Seed and fully acknowledge
    // the pre-move scheduler outside the measured movement boundary.
    let movementSeedDiagnostics = createDiagnostics()
    let movementSeedLayout: ReturnType<typeof measureRenderedTranscript>
    for (let pass = 0; pass < 8; pass++) {
      movementSeedDiagnostics = createDiagnostics()
      await act(async () => {
        movementSeedLayout = measureRenderedTranscript(setup.renderer, scroll, {
          frame: runtime.getSnapshot(), runtime, styleRevision, diagnostics: movementSeedDiagnostics,
        })
        await setup.flush(); await setup.renderOnce()
      })
      if (movementSeedLayout && movementSeedDiagnostics.pendingAfter === 0) break
    }
    assert(movementSeedLayout, "pre-move native geometry must settle before detached cleanup measurement")
    assert.equal(movementSeedDiagnostics.pendingAfter, 0)
    settledFollowRoots = mountedBlockRoots(scroll)
    settledFollowFrame = runtime.getSnapshot()
    assertMountedRoots(settledFollowFrame, settledFollowRoots)

    const detachedTranscript = Object.freeze({
      ...fixture.afterTailDelta.transcript,
      viewport: Object.freeze({ kind: "point" as const, point: Object.freeze({ itemId: fixture.targets.middle, graphemeOffset: 0 }), preferredScreenRow: 7 }),
    })
    const detachedSnapshot = Object.freeze({ ...fixture.afterTailDelta, transcript: detachedTranscript })
    let movementPublications = 0
    const unsubscribeMovement = runtime.subscribe(() => { movementPublications++ })
    const movementStarted = performance.now()
    await act(async () => {
      runtime.update(runtimeInput(fixture, detachedSnapshot, "detached", { presentationDamage: { kind: "view" } }))
      await setup.flush(); await setup.renderOnce()
    })
    const runtimeReactNativeRootMs = performance.now() - movementStarted
    const detachedRootsBefore = mountedBlockRoots(scroll)
    assertMountedRoots(runtime.getSnapshot(), detachedRootsBefore)
    let overlap = 0
    for (const [id, root] of settledFollowRoots) if (detachedRootsBefore.get(id) === root) overlap++
    const targetBlock = runtime.getSnapshot().window.blocks.find(block => block.key.kind === "item" && block.key.itemId === fixture.targets.middle)
      ?? runtime.getSnapshot().window.blocks[Math.floor(runtime.getSnapshot().window.blocks.length / 2)]!
    const targetRoot = detachedRootsBefore.get(transcriptBlockRenderableId(targetBlock))!
    await act(async () => {
      scroll.scrollBy(targetRoot.screenY - scroll.viewport.screenY - 7, "step")
      await setup.flush(); await setup.renderOnce()
    })
    const visibleTop = scroll.viewport.screenY, visibleBottom = visibleTop + scroll.viewport.height
    const independentlyVisibleKeys = runtime.getSnapshot().window.blocks.flatMap(block => {
      const root = detachedRootsBefore.get(transcriptBlockRenderableId(block))
      return root && root.screenY < visibleBottom && root.screenY + root.height > visibleTop ? [blockKey(block)] : []
    })
    assert(independentlyVisibleKeys.length > 0, "detached movement must put planned roots in the native viewport")
    const shiftDiagnostics = createDiagnostics()
    const shiftFrame = runtime.getSnapshot()
    const shiftStarted = performance.now()
    await act(async () => {
      measureRenderedTranscript(setup.renderer, scroll, {
        frame: shiftFrame, runtime, styleRevision, diagnostics: shiftDiagnostics,
      })
      await setup.flush(); await setup.renderOnce()
    })
    const measurementPublicationMs = performance.now() - shiftStarted
    let settledDiagnostics = createDiagnostics()
    let settlementPasses = 0
    for (; settlementPasses < 4; settlementPasses++) {
      settledDiagnostics = createDiagnostics()
      await act(async () => {
        const layout = measureRenderedTranscript(setup.renderer, scroll, {
          frame: runtime.getSnapshot(), runtime, styleRevision, diagnostics: settledDiagnostics,
        })
        assert(layout, "detached movement geometry must settle on an acknowledgement pass")
        await setup.flush(); await setup.renderOnce()
      })
      if (settledDiagnostics.pendingAfter === 0) break
    }
    settlementPasses++
    unsubscribeMovement()
    const shiftSettlementMs = performance.now() - movementStarted
    assert.equal(shiftDiagnostics.trackedMountedRoots, detachedRootsBefore.size)
    const detachedBlockKeys = new Set(shiftFrame.window.blocks.map(blockKey))
    const departedMeasuredKeys = settledFollowFrame.window.blocks
      .map(blockKey).filter(key => !detachedBlockKeys.has(key)).sort()
    assert.equal(shiftDiagnostics.prunedRoots, departedMeasuredKeys.length)
    assert.deepEqual(shiftDiagnostics.prunedKeys?.slice().sort(), departedMeasuredKeys)
    assert(shiftDiagnostics.attemptedMeasurements <= detachedRootsBefore.size)
    assert.equal(shiftDiagnostics.visibleCandidates, independentlyVisibleKeys.length)
    assert.deepEqual(shiftDiagnostics.attemptedKeys?.slice(0, independentlyVisibleKeys.length), independentlyVisibleKeys)
    assert.equal(shiftDiagnostics.visibleBeforeOverscan, true)
    assert.equal(settledDiagnostics.pendingAfter, 0)
    const pinned = runtime.getSnapshot()
    const pinnedRoots = mountedBlockRoots(scroll)
    assertMountedRoots(pinned, pinnedRoots)
    printResult({
      scenario: "detached-window-movement",
      materialization: "windowed-production",
      boundary: "runtime-react-native-root-scroll-and-measurement",
      blockCount: fixture.blockCount,
      viewport,
      mode: "detached",
      fixture: { contentShape: "rendered-mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
      operationCounts: {
        mountedBlocks: detachedRootsBefore.size, measuredBlocks: shiftDiagnostics.changedMeasurements,
        changedBlocks: 0, publications: movementPublications,
        retainedBlockRoots: overlap, mountedRootsDuringMove: detachedRootsBefore.size - overlap,
        unmountedRootsDuringMove: settledFollowRoots.size - overlap, candidateBlocks: shiftDiagnostics.candidateBlocks,
        attemptedMeasurements: shiftDiagnostics.attemptedMeasurements, trackedMountedRoots: shiftDiagnostics.trackedMountedRoots,
        prunedRoots: shiftDiagnostics.prunedRoots, visibleCandidates: shiftDiagnostics.visibleCandidates,
        overscanCandidates: shiftDiagnostics.overscanCandidates, pendingMeasurementsAfterAcknowledgement: settledDiagnostics.pendingAfter,
        acknowledgementPasses: settlementPasses,
        mountedNativeDescendants: mountedTreeCounts(scroll).descendants, stableSpacerRoots: mountedTreeCounts(scroll).spacers,
      },
      timingsMs: { runtimeReactNativeRoot: Number(runtimeReactNativeRootMs.toFixed(6)),
        postMoveMeasurementPublication: Number(measurementPublicationMs.toFixed(6)),
        completeMovementSettlement: Number(shiftSettlementMs.toFixed(6)) },
      samples: { warmup: 0, measured: 1 },
    })
    const backloggedTranscript = Object.freeze({
      ...detachedTranscript,
      unseenEntries: fixture.blockCount,
      unseenItemIds: persistentTranscriptUnseenItemIds(detachedTranscript.order),
    })
    const backloggedSnapshot = Object.freeze({ ...detachedSnapshot, transcript: backloggedTranscript })
    const hidden = appendTranscriptScalingTail(backloggedSnapshot, fixture.tailItemId, fixture.tailDelta)
    assert.equal(hidden.transcript.unseenEntries, fixture.blockCount)
    assert.equal(hidden.transcript.unseenItemIds, backloggedTranscript.unseenItemIds)
    let detachedPublications = 0
    const unsubscribeDetached = runtime.subscribe(() => { detachedPublications++ })
    commits.length = 0
    const detachedStarted = performance.now()
    await act(async () => {
      const result = runtime.update(runtimeInput(fixture, hidden, "detached", {
        canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
      }))
      assert.equal(result, pinned)
      await setup.flush(); await setup.renderOnce()
    })
    const detachedSettlementMs = performance.now() - detachedStarted
    unsubscribeDetached()
    const detachedRootsAfter = mountedBlockRoots(scroll)
    assertMountedRoots(pinned, detachedRootsAfter)
    let detachedRetainedRoots = 0
    for (const [id, root] of pinnedRoots) if (detachedRootsAfter.get(id) === root) detachedRetainedRoots++
    assert.equal(detachedRetainedRoots, pinnedRoots.size)
    assert.equal(detachedPublications, 0)
    assert.equal(commits.length, 0)
    printResult({
      scenario: "detached-hidden-delta-presentation",
      materialization: "windowed-production",
      boundary: "runtime-react-native-root",
      blockCount: fixture.blockCount,
      viewport,
      mode: "detached",
      fixture: { contentShape: "rendered-mixed-semantic-root-blocks-with-complete-unseen-backlog",
        contentHash: fixture.contentHash, setupExcludedFromTiming: true },
      operationCounts: { mountedBlocks: pinnedRoots.size, changedBlocks: 0, publications: detachedPublications,
        canonicalChangedBlocks: 1, unseenBacklog: backloggedTranscript.unseenItemIds.length,
        retainedBlockRoots: detachedRetainedRoots, mountedRootsDuringHiddenDelta: 0,
        unmountedRootsDuringHiddenDelta: 0, runtimePublications: detachedPublications, reactCommits: commits.length },
      timingsMs: { hiddenDeltaPresentationSettlement: Number(detachedSettlementMs.toFixed(6)) },
      samples: { warmup: 0, measured: 1 },
    })
  } finally {
    runtime.dispose()
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
}

const requestedSizes = process.env.VIMEX_WINDOWING_SIZES
  ? process.env.VIMEX_WINDOWING_SIZES.split(",").map(Number)
  : [...transcriptScalingBlockCounts]
const requestedNativeViewports = process.env.VIMEX_WINDOWING_VIEWPORTS
  ? process.env.VIMEX_WINDOWING_VIEWPORTS.split(",").map(value => {
    const [width, height] = value.split("x").map(Number)
    assert(Number.isInteger(width) && width! > 0 && Number.isInteger(height) && height! > 0, `invalid viewport ${value}`)
    return Object.freeze({ width: width!, height: height! })
  })
  : defaultNativeViewports
if (process.env.VIMEX_WINDOWING_NATIVE_BASELINE === "1" && !process.env.VIMEX_WINDOWING_SIZES) {
  throw new Error("Native production-window baselines require an explicit VIMEX_WINDOWING_SIZES selection; see the file header")
}
for (const blockCount of requestedSizes) {
  assert(transcriptScalingBlockCounts.includes(blockCount as typeof transcriptScalingBlockCounts[number]), `unsupported block count ${blockCount}`)
  const fixture = buildTranscriptScalingFixture(blockCount)
  boundedCanonicalIngressBaseline(fixture)
  const structuralFixture = buildTranscriptStructuralScalingFixture(blockCount)
  structuralTailAdmissionBaseline(structuralFixture)
  tailTurnCompletionBaseline(structuralFixture)
  detachedUnseenAccumulationBaseline(structuralFixture)
  oversizedCommandProductionBaseline(blockCount)
  sideInheritedMembershipBaseline(blockCount)
  runtimeBaseline(fixture)
  boundedFollowRuntimeBaseline(fixture)
  await reactPublicationBaseline(fixture)
  await hiddenPresentationResourceBaseline(fixture)
  runtimeCorrectionBaseline(fixture)
  offWindowTargetBaseline(fixture)
  indexedUrlAndFoldBaseline(fixture)
  if (process.env.VIMEX_WINDOWING_NATIVE_BASELINE === "1") {
    const structuralFixture = buildTranscriptStructuralScalingFixture(blockCount)
    for (const viewport of requestedNativeViewports) {
      await nativeStructuralAdmissionBaseline(structuralFixture, viewport)
      await detachedStatusNativePublicationBaseline(structuralFixture, viewport)
      await oversizedCommandNativeBaseline(blockCount, viewport)
      await nativeMountBaseline(fixture, viewport)
    }
  }
}

for (const fixture of buildOversizedTranscriptFixtures()) printResult({
  scenario: "oversized-fixture",
  materialization: "fixture-only",
  boundary: "fixture",
  blockCount: 1,
  viewport: primaryViewport,
  mode: "follow-and-detached",
  fixture: { contentShape: fixture.shape, chars: fixture.source.length, stableSegments: fixture.segments.length, rootBlocksBeforeSubBlockPlanning: 1 },
  operationCounts: { fixtureItems: 1, deterministicFixtureSegments: fixture.segments.length },
  samples: { warmup: 0, measured: 1 },
})
