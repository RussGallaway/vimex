// Diagnostic Stage 5 scaling benchmark; timings are curves, never CI gates.
//
// Native production-window baselines intentionally require an explicit size
// selection so each memory/timing curve has a clear fixture boundary. Run one
// or more explicit cells, for example:
//   VIMEX_WINDOWING_NATIVE_BASELINE=1 VIMEX_WINDOWING_GEOMETRY_BASELINE=1 \
//   VIMEX_WINDOWING_SIZES=100 VIMEX_WINDOWING_VIEWPORTS=80x24 \
//   bun scripts/benchmark-transcript-windowing.tsx
import assert from "node:assert/strict"
import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import {
  appendTranscriptScalingTail,
  buildOversizedTranscriptFixtures,
  buildTranscriptScalingFixture,
  transcriptScalingBlockCounts,
  type TranscriptFixtureSnapshot,
} from "@vimex/testkit"
import {
  conversationItemAt,
  reduceConversationReference,
  reduceConversationWithDiagnostics,
  type ConversationItemRecordDiagnostics,
} from "@vimex/conversation"
import {
  blockKey,
  createTranscriptFrame,
  moveByUrl,
  moveByUrlReference,
  passThroughWindow,
  pointIsMaterialized,
  primeTranscriptUrlIndex,
  setTranscriptFoldValue,
  syncTranscriptItem,
  transcriptOrderIndex,
  transcriptTextLengthRange,
  TranscriptRuntime,
  type BlockGeometry,
  type TranscriptFrame,
  type TranscriptRuntimeInput,
} from "@vimex/transcript"
import { act, createRef, Profiler, useSyncExternalStore, type RefObject } from "react"
import { createEmberTideSyntax } from "../packages/ui-opentui-react/src/theme"
import { blockNativeRevision } from "../packages/ui-opentui-react/src/transcript/measure-rendered-block"
import { movePointInTranscript } from "../packages/ui-opentui-react/src/transcript/layout"
import { measureRenderedTranscript, transcriptBlockRenderableId, type RenderedLayoutDiagnostics } from "../packages/ui-opentui-react/src/transcript/rendered-layout"
import { TranscriptViewport } from "../packages/ui-opentui-react/src/transcript/TranscriptViewport"

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
    visibleBeforeOverscan: true, attemptedKeys: [],
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
  fixture: ReturnType<typeof buildTranscriptScalingFixture>,
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
    const shiftStarted = performance.now()
    await act(async () => {
      measureRenderedTranscript(setup.renderer, scroll, {
        frame: runtime.getSnapshot(), runtime, styleRevision, diagnostics: shiftDiagnostics,
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
    assert.equal(shiftDiagnostics.prunedRoots, settledFollowRoots.size - overlap)
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
    const hidden = appendTranscriptScalingTail(detachedSnapshot, fixture.tailItemId, fixture.tailDelta)
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
      fixture: { contentShape: "rendered-mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
      operationCounts: { mountedBlocks: pinnedRoots.size, measuredBlocks: 0, changedBlocks: 0, publications: detachedPublications,
        canonicalChangedBlocks: 1, retainedBlockRoots: detachedRetainedRoots, mountedRootsDuringHiddenDelta: 0,
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
  runtimeBaseline(fixture)
  boundedFollowRuntimeBaseline(fixture)
  await reactPublicationBaseline(fixture)
  runtimeCorrectionBaseline(fixture)
  offWindowTargetBaseline(fixture)
  indexedUrlAndFoldBaseline(fixture)
  if (process.env.VIMEX_WINDOWING_NATIVE_BASELINE === "1") {
    for (const viewport of requestedNativeViewports) await nativeMountBaseline(fixture, viewport)
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
