import { afterEach, expect, test } from "bun:test"
import {
  createConversationReductionDiagnostics,
  forkBoundary,
  reduceConversationWithDiagnostics,
  type ConversationState,
} from "@vimex/conversation"
import {
  appendTranscriptScalingTail,
  buildOversizedTranscriptFixtures,
  buildTranscriptNavigationFixture,
  buildTranscriptScalingFixture,
  buildTranscriptStructuralScalingFixture,
  transcriptScalingBlockCounts,
  type TranscriptFixtureSnapshot,
} from "@vimex/testkit"
import {
  syncTranscriptItem,
  type TranscriptItemSyncDiagnostics,
} from "./application/project-conversation"
import { primeTranscriptUrlIndex } from "./application/transcript-url-index"
import { findSearchMatches } from "./application/transcript-search"
import {
  selectedGraphemeCount,
  selectedText,
  urlAt,
} from "./application/transcript-operations"
import {
  referenceText,
  urlCandidates,
} from "./application/transcript-navigation"
import {
  persistentTranscriptUnseenItemIds,
  setTranscriptFoldValue,
  transcriptTextLengthRange,
  type TranscriptState,
} from "./domain/transcript-document"
import type { BlockGeometry } from "./geometry"
import {
  createTranscriptFrame,
  TranscriptRuntime,
  type TranscriptFrame,
  type TranscriptRuntimeDiagnostics,
  type TranscriptRuntimeInput,
} from "./runtime"
import {
  blockKey,
  buildTranscriptBlocks,
  passThroughWindow,
  pointIsMaterialized,
  transcriptPointBlockIndex,
} from "./window"
import { createHeightIndex } from "./height-index"

// Each stress case allocates several 100k-block immutable histories, including
// weakly keyed geometry/projection caches. Reclaim those dead fixtures after
// their owning test, rather than charging the next small test for deferred GC.
// Runtime disposal alone cannot collect immutable snapshots still on its stack.
afterEach(() => {
  Bun.gc(true)
})

function runtimeInput(
  fixture: Readonly<{ threadId: TranscriptRuntimeInput["threadId"] }>,
  snapshot: TranscriptFixtureSnapshot,
  mode: "follow" | "detached",
  options: Pick<
    TranscriptRuntimeInput,
    "canonicalDamage" | "presentationDamage" | "reveal"
  > = {},
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

const point = Object.freeze({
  0: Object.freeze({ graphemeOffset: 0, x: 0, y: 0, row: 0, column: 0 }),
})
const offsets = Object.freeze({ 0: Object.freeze([0]) })
const line = Object.freeze({ from: 0, to: 0, row: 0 })
const lines = Object.freeze([line])
const lineByRow = Object.freeze({ 0: line })

function scalingRuntimeDiagnostics(): TranscriptRuntimeDiagnostics {
  return {
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
    projectionRecordUpdates: 0,
    projectionRecordNodeVisits: 0,
    projectionRecordNodesCopied: 0,
    blockPlanUpdates: 0,
    blockPlanNodeVisits: 0,
    blockPlanNodesCopied: 0,
    heightIndexBuilds: 0,
    heightIndexBlockVisits: 0,
    heightIndexUpdates: 0,
    heightIndexNodeVisits: 0,
    heightIndexNodesCopied: 0,
    completeGeometryBlockVisits: 0,
    windowGeometryBlockVisits: 0,
    blockPlanWindowSliceItems: 0,
    changedItemBuilds: 0,
    hiddenDamageMerges: 0,
    hiddenDamageInputItemVisits: 0,
    hiddenDamageItemAdditions: 0,
    hiddenDamageSnapshots: 0,
    hiddenDamageSnapshotItemVisits: 0,
  }
}

function itemSyncDiagnostics(): TranscriptItemSyncDiagnostics {
  return {
    projectionRecordUpdates: 0,
    projectionRecordNodeVisits: 0,
    projectionRecordNodesCopied: 0,
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
    unseenItemSequenceNormalizations: 0,
    unseenItemSequenceNormalizationItemVisits: 0,
    unseenItemMembershipChecks: 0,
    unseenItemMembershipNodeVisits: 0,
    unseenItemAppends: 0,
    unseenItemAppendNodeVisits: 0,
    unseenItemIndexUpdateNodeVisits: 0,
    unseenItemIndexUpdateNodesCopied: 0,
  }
}

function measurements(frame: TranscriptFrame): readonly BlockGeometry[] {
  return frame.blocks.map((block) =>
    Object.freeze({
      key: Object.freeze({
        blockKey: blockKey(block),
        contentRevision: block.contentRevision,
        width: 80,
        styleRevision: "scaling-test",
        folded:
          block.key.kind === "item" &&
          Boolean(frame.transcript.folded[block.key.itemId]),
      }),
      nativeRevision: 1,
      rows: 1,
      pointCount: 1,
      points: point,
      pointOffsetsByRow: offsets,
      lines,
      lineByRow,
    }),
  )
}

function semanticEvidence(
  transcript: TranscriptState,
  conversation: ConversationState,
) {
  const urlState = transcript.selection
    ? { ...transcript, cursor: transcript.selection.anchor }
    : transcript
  const urls = urlCandidates(urlState, "current-item")
  return {
    transcript,
    copyPlain: selectedText(transcript, "plain"),
    copySource: selectedText(transcript, "source"),
    referencePlain: referenceText(transcript, "plain"),
    referenceSource: referenceText(transcript, "source"),
    searchMatches: findSearchMatches(
      transcript,
      transcript.search?.query ?? "",
    ),
    urls,
    firstUrlAtPoint: urls[0] ? urlAt(transcript, urls[0].from) : undefined,
    marks: transcript.marks,
    jumps: transcript.jumps,
    foldedItems: Object.entries(transcript.folded)
      .filter(([, folded]) => folded)
      .map(([itemId]) => ({
        itemId,
        nodeKind: transcript.projectionById[itemId]?.nodeKind,
      })),
    forkBoundary: forkBoundary(conversation, transcript.cursor?.itemId),
  }
}

/**
 * Test-only full-materialization oracle. Its identity and zero-spacer assertions
 * prevent Stage 5's production planner from silently turning this reference
 * into another windowed candidate.
 */
function passThroughOracle(snapshot: TranscriptFixtureSnapshot) {
  const blocks = buildTranscriptBlocks(snapshot)
  const window = passThroughWindow(blocks)
  expect(window.blocks).toBe(blocks)
  expect(window.blocks).toHaveLength(snapshot.transcript.order.length)
  expect(window.topSpacerRows).toBe(0)
  expect(window.bottomSpacerRows).toBe(0)
  expect(window.overscanRows).toBe(0)
  return {
    blockKeys: blocks.map(blockKey),
    semantics: semanticEvidence(snapshot.transcript, snapshot.conversation),
  }
}

function expectPassThroughEquivalent(
  frame: TranscriptFrame,
  snapshot: TranscriptFixtureSnapshot,
): void {
  const reference = passThroughOracle(snapshot)
  expect(frame.blocks.map(blockKey)).toEqual(reference.blockKeys)
  expect(semanticEvidence(frame.transcript, snapshot.conversation)).toEqual(
    reference.semantics,
  )
}

// This exhaustive reference deliberately materializes the full history. Its
// timeout is a CI execution guard, not an interactive latency budget; the
// production scaling tests below assert bounded operation counts separately.
// Separate sizes also lets afterEach reclaim each discarded fixture graph.
test.each([...transcriptScalingBlockCounts])(
  "scaling workload at %i blocks retains pass-through semantics and deterministic publication counts",
  (blockCount) => {
    const fixture = buildTranscriptScalingFixture(blockCount)
    const runtime = new TranscriptRuntime(
      runtimeInput(fixture, fixture.before, "follow", {
        canonicalDamage: { kind: "full" },
      }),
    )
    runtime.reportMeasurements({
      ...runtime.measurementBase(),
      measurements: measurements(runtime.getSnapshot()),
    })
    const initial = runtime.getSnapshot()
    expect(initial.blocks).toHaveLength(blockCount)
    expect(initial.window.blocks).toBe(initial.blocks)
    expect(initial.geometry.measuredBlockCount).toBe(blockCount)

    let publications = 0
    runtime.subscribe(() => {
      publications++
    })
    const followed = runtime.update(
      runtimeInput(fixture, fixture.afterTailDelta, "follow", {
        canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
      }),
    )
    expect(publications).toBe(1)
    let preservedBlocks = 0,
      preservedGeometry = 0
    const changedKeys: string[] = []
    for (let index = 0; index < blockCount; index++) {
      const key = blockKey(followed.blocks[index]!)
      if (followed.blocks[index] === initial.blocks[index]) preservedBlocks++
      else changedKeys.push(key)
      if (
        followed.geometry.byBlockKey[key] === initial.geometry.byBlockKey[key]
      )
        preservedGeometry++
    }
    expect(preservedBlocks).toBe(blockCount - 1)
    expect(preservedGeometry).toBe(blockCount - 1)
    expect(changedKeys).toEqual([`item:${fixture.tailItemId}:root`])
    expect(followed.blocks.at(-1)).not.toBe(initial.blocks.at(-1))
    expect(blockKey(followed.blocks.at(-1)!)).toBe(
      `item:${fixture.tailItemId}:root`,
    )
    expect(followed.window.blocks).toBe(followed.blocks)
    expect(followed.geometry.measuredBlockCount).toBe(blockCount - 1)
    expectPassThroughEquivalent(followed, fixture.afterTailDelta)

    const navigatedTranscript = Object.freeze({
      ...fixture.afterTailDelta.transcript,
      cursor: Object.freeze({
        itemId: fixture.targets.quarter,
        graphemeOffset: 0,
      }),
      viewport: Object.freeze({
        kind: "point" as const,
        point: Object.freeze({
          itemId: fixture.targets.quarter,
          graphemeOffset: 0,
        }),
        preferredScreenRow: 7,
      }),
    })
    const navigatedSnapshot = Object.freeze({
      ...fixture.afterTailDelta,
      transcript: navigatedTranscript,
    })
    const navigated = runtime.update(
      runtimeInput(fixture, navigatedSnapshot, "follow", {
        presentationDamage: { kind: "view" },
      }),
    )
    expect(publications).toBe(2)
    expectPassThroughEquivalent(navigated, navigatedSnapshot)

    runtime.update(runtimeInput(fixture, navigatedSnapshot, "detached"))
    expect(publications).toBe(3)
    const pinned = runtime.getSnapshot()
    expectPassThroughEquivalent(pinned, navigatedSnapshot)
    const hidden = appendTranscriptScalingTail(
      navigatedSnapshot,
      fixture.tailItemId,
      fixture.tailDelta,
    )
    expect(
      runtime.update(
        runtimeInput(fixture, hidden, "detached", {
          canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
        }),
      ),
    ).toBe(pinned)
    expect(publications).toBe(3)

    const hiddenTail = hidden.transcript.projectionById[fixture.tailItemId]!
    const revealPoint = Object.freeze({
      itemId: fixture.tailItemId,
      graphemeOffset: hiddenTail.sourceSpans.length,
    })
    const revealedTranscript = Object.freeze({
      ...hidden.transcript,
      cursor: revealPoint,
      viewport: Object.freeze({
        kind: "point" as const,
        point: revealPoint,
        preferredScreenRow: 7,
      }),
    })
    const revealedSnapshot = Object.freeze({
      ...hidden,
      transcript: revealedTranscript,
    })
    const revealed = runtime.update(
      runtimeInput(fixture, revealedSnapshot, "detached", {
        reveal: { id: blockCount, point: revealPoint, reason: "jump" },
      }),
    )
    expect(publications).toBe(4)
    expect(revealed.displayedCanonicalRevision).toBe(hidden.canonicalRevision)
    expect(revealed.mode).toBe("detached")
    expect(revealed.transcript.cursor).toEqual(revealPoint)
    expect(revealed.transcript.viewport).toEqual({
      kind: "point",
      point: revealPoint,
      preferredScreenRow: 7,
    })
    expectPassThroughEquivalent(revealed, revealedSnapshot)

    const latest = appendTranscriptScalingTail(
      revealedSnapshot,
      fixture.tailItemId,
      fixture.tailDelta,
    )
    expect(
      runtime.update(
        runtimeInput(fixture, latest, "detached", {
          canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
        }),
      ),
    ).toBe(revealed)
    expect(publications).toBe(4)
    const reattached = runtime.update(runtimeInput(fixture, latest, "follow"))
    expect(publications).toBe(5)
    expect(reattached.displayedCanonicalRevision).toBe(latest.canonicalRevision)
    expectPassThroughEquivalent(reattached, latest)
    runtime.dispose()
  },
  60_000,
)

test("canonical structural tail admission stays logarithmic with bounded runtime work at every scale", () => {
  for (const blockCount of transcriptScalingBlockCounts) {
    const fixture = buildTranscriptStructuralScalingFixture(blockCount)
    transcriptTextLengthRange(fixture.before.transcript, 0, 0)
    primeTranscriptUrlIndex(fixture.before.transcript)
    const runtimeCounters = scalingRuntimeDiagnostics()
    const runtime = new TranscriptRuntime(
      runtimeInput(fixture, fixture.before, "follow", {
        canonicalDamage: { kind: "full" },
      }),
      {
        windowPolicy: { viewportRows: 24, overscanRows: 24 },
        diagnostics: runtimeCounters,
      },
    )
    const before = runtime.getSnapshot()
    const runtimeBaseline = { ...runtimeCounters }
    const canonicalCounters = createConversationReductionDiagnostics()
    const semanticCounters = itemSyncDiagnostics()
    let publications = 0
    runtime.subscribe(() => {
      publications++
    })

    const turnConversation = reduceConversationWithDiagnostics(
      fixture.before.conversation,
      {
        type: "turn.started",
        threadId: fixture.threadId,
        turnId: fixture.nextTurnId,
      },
      canonicalCounters,
    )
    const afterTurnSnapshot: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: fixture.before.canonicalRevision + 1,
      conversation: turnConversation,
      transcript: fixture.before.transcript,
    })
    const afterTurn = runtime.update(
      runtimeInput(fixture, afterTurnSnapshot, "follow", {
        canonicalDamage: { kind: "blocks", itemIds: [] },
      }),
    )
    expect(afterTurn.blocks).toBe(before.blocks)
    expect(afterTurn.window).toBe(before.window)
    expect(afterTurn.geometry).toBe(before.geometry)
    expect(afterTurn.transcript).toBe(before.transcript)

    const admittedItem = Object.freeze({
      id: fixture.nextItemId,
      turnId: fixture.nextTurnId,
      kind: "assistant" as const,
      markdown: "New structural tail block.",
      status: "running" as const,
    })
    const itemConversation = reduceConversationWithDiagnostics(
      turnConversation,
      {
        type: "item.started",
        threadId: fixture.threadId,
        item: admittedItem,
      },
      canonicalCounters,
    )
    const itemTranscript = syncTranscriptItem(
      fixture.before.transcript,
      admittedItem,
      semanticCounters,
    )
    const afterItemSnapshot: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: afterTurnSnapshot.canonicalRevision + 1,
      conversation: itemConversation,
      transcript: itemTranscript,
    })
    const appended = runtime.update(
      runtimeInput(fixture, afterItemSnapshot, "follow", {
        canonicalDamage: { kind: "blocks", itemIds: [fixture.nextItemId] },
      }),
    )
    const reference = createTranscriptFrame(
      runtimeInput(fixture, afterItemSnapshot, "follow", {
        canonicalDamage: { kind: "full" },
      }),
    )

    expect(publications).toBe(2)
    expect(appended.blocks.map(blockKey)).toEqual(
      reference.blocks.map(blockKey),
    )
    expectPassThroughEquivalent(appended, afterItemSnapshot)
    expect(appended.window.blocks.length).toBeLessThanOrEqual(48)
    expect(
      appended.blocks
        .slice(0, blockCount)
        .every((block, index) => block === before.blocks[index]),
    ).toBe(true)
    expect(appended.transcript.order).toBe(itemTranscript.order)
    const beforeWarmQueries = { ...runtimeCounters }
    transcriptTextLengthRange(
      appended.transcript,
      0,
      appended.transcript.order.length,
      runtimeCounters,
    )
    primeTranscriptUrlIndex(appended.transcript, runtimeCounters)
    expect(runtimeCounters.textLengthIndexBuilds).toBe(
      beforeWarmQueries.textLengthIndexBuilds,
    )
    expect(runtimeCounters.textLengthItemVisits).toBe(
      beforeWarmQueries.textLengthItemVisits,
    )
    expect(runtimeCounters.textLengthIndexCacheHits).toBe(
      beforeWarmQueries.textLengthIndexCacheHits + 1,
    )
    expect(runtimeCounters.urlIndexBuilds).toBe(
      beforeWarmQueries.urlIndexBuilds,
    )
    expect(runtimeCounters.urlIndexItemVisits).toBe(
      beforeWarmQueries.urlIndexItemVisits,
    )
    expect(runtimeCounters.urlIndexCacheHits).toBe(
      beforeWarmQueries.urlIndexCacheHits + 1,
    )
    let preservedItems = 0,
      preservedTurns = 0,
      preservedProjections = 0
    for (let index = 0; index < blockCount; index++) {
      const itemId = fixture.before.transcript.order[index]!
      const turnId = fixture.before.conversation.turnIds[index]!
      if (
        itemConversation.items[itemId] ===
        fixture.before.conversation.items[itemId]
      )
        preservedItems++
      if (
        itemConversation.turns[turnId] ===
        fixture.before.conversation.turns[turnId]
      )
        preservedTurns++
      if (
        itemTranscript.projectionById[itemId] ===
        fixture.before.transcript.projectionById[itemId]
      )
        preservedProjections++
    }
    expect(preservedItems).toBe(blockCount)
    expect(preservedTurns).toBe(blockCount)
    expect(preservedProjections).toBe(blockCount)

    expect(canonicalCounters.conversationTurnIdSequenceNormalizations).toBe(0)
    expect(
      canonicalCounters.conversationTurnIdSequenceNormalizationVisits,
    ).toBe(0)
    expect(canonicalCounters.conversationTurnRecordNormalizations).toBe(0)
    expect(canonicalCounters.conversationTurnRecordNormalizationVisits).toBe(0)
    expect(canonicalCounters.conversationTurnItemIdSequenceNormalizations).toBe(
      0,
    )
    expect(
      canonicalCounters.conversationTurnItemIdSequenceNormalizationVisits,
    ).toBe(0)
    expect(canonicalCounters.conversationItemRecordNormalizations).toBe(0)
    expect(
      canonicalCounters.conversationItemRecordNormalizationItemVisits,
    ).toBe(0)
    expect(canonicalCounters.conversationTurnIdSequenceAppends).toBe(1)
    expect(canonicalCounters.conversationTurnItemIdSequenceAppends).toBe(1)
    expect(canonicalCounters.conversationTurnRecordUpdates).toBe(2)
    expect(canonicalCounters.conversationItemRecordUpdates).toBe(1)
    const logarithmicBound = 12 * (Math.ceil(Math.log2(blockCount + 1)) + 1)
    expect(
      canonicalCounters.conversationTurnIdSequenceNodeVisits,
    ).toBeLessThanOrEqual(logarithmicBound)
    expect(
      canonicalCounters.conversationTurnRecordNodeVisits,
    ).toBeLessThanOrEqual(logarithmicBound)
    expect(
      canonicalCounters.conversationItemRecordNodeVisits,
    ).toBeLessThanOrEqual(logarithmicBound)

    expect(semanticCounters.projectionRecordUpdates).toBe(1)
    expect(semanticCounters.orderIndexBuilds).toBe(0)
    expect(semanticCounters.orderIndexItemVisits).toBe(0)
    expect(semanticCounters.textLengthIndexBuilds).toBe(0)
    expect(semanticCounters.textLengthItemVisits).toBe(0)
    expect(semanticCounters.textLengthIndexUpdates).toBe(1)
    expect(semanticCounters.urlIndexBuilds).toBe(0)
    expect(semanticCounters.urlIndexItemVisits).toBe(0)
    expect(semanticCounters.urlIndexUpdates).toBe(1)

    expect(
      runtimeCounters.completePlanBuilds - runtimeBaseline.completePlanBuilds,
    ).toBe(0)
    expect(
      runtimeCounters.completePlanBlockVisits -
        runtimeBaseline.completePlanBlockVisits,
    ).toBe(0)
    expect(
      runtimeCounters.heightIndexBuilds - runtimeBaseline.heightIndexBuilds,
    ).toBe(0)
    expect(
      runtimeCounters.heightIndexBlockVisits -
        runtimeBaseline.heightIndexBlockVisits,
    ).toBe(0)
    expect(
      runtimeCounters.completeGeometryBlockVisits -
        runtimeBaseline.completeGeometryBlockVisits,
    ).toBe(0)
    expect(
      runtimeCounters.blockPlanUpdates - runtimeBaseline.blockPlanUpdates,
    ).toBe(1)
    expect(
      runtimeCounters.heightIndexUpdates - runtimeBaseline.heightIndexUpdates,
    ).toBe(1)
    expect(
      runtimeCounters.changedItemBuilds - runtimeBaseline.changedItemBuilds,
    ).toBe(1)
    expect(
      runtimeCounters.orderIndexBuilds - runtimeBaseline.orderIndexBuilds,
    ).toBe(0)
    expect(
      runtimeCounters.orderIndexItemVisits -
        runtimeBaseline.orderIndexItemVisits,
    ).toBe(0)
    expect(
      runtimeCounters.textLengthIndexBuilds -
        runtimeBaseline.textLengthIndexBuilds,
    ).toBe(0)
    expect(
      runtimeCounters.textLengthItemVisits -
        runtimeBaseline.textLengthItemVisits,
    ).toBe(0)
    expect(
      runtimeCounters.textLengthIndexUpdates -
        runtimeBaseline.textLengthIndexUpdates,
    ).toBe(1)
    expect(
      runtimeCounters.urlIndexBuilds - runtimeBaseline.urlIndexBuilds,
    ).toBe(0)
    expect(
      runtimeCounters.urlIndexItemVisits - runtimeBaseline.urlIndexItemVisits,
    ).toBe(0)
    expect(
      runtimeCounters.urlIndexUpdates - runtimeBaseline.urlIndexUpdates,
    ).toBe(1)
    expect(
      runtimeCounters.windowGeometryBlockVisits -
        runtimeBaseline.windowGeometryBlockVisits,
    ).toBeLessThanOrEqual(48)
    expect(
      runtimeCounters.blockPlanWindowSliceItems -
        runtimeBaseline.blockPlanWindowSliceItems,
    ).toBeLessThanOrEqual(48)
    runtime.dispose()
  }
}, 30_000)

test("tail turn completion and activity admission stay logarithmic with bounded runtime work at every scale", () => {
  for (const blockCount of transcriptScalingBlockCounts) {
    const fixture = buildTranscriptStructuralScalingFixture(blockCount)
    transcriptTextLengthRange(fixture.before.transcript, 0, 0)
    primeTranscriptUrlIndex(fixture.before.transcript)
    const runtimeCounters = scalingRuntimeDiagnostics()
    const runtime = new TranscriptRuntime(
      runtimeInput(fixture, fixture.before, "follow", {
        canonicalDamage: { kind: "full" },
      }),
      {
        windowPolicy: { viewportRows: 24, overscanRows: 24 },
        diagnostics: runtimeCounters,
      },
    )

    const turnConversation = reduceConversationWithDiagnostics(
      fixture.before.conversation,
      {
        type: "turn.started",
        threadId: fixture.threadId,
        turnId: fixture.nextTurnId,
      },
      createConversationReductionDiagnostics(),
    )
    const admittedItem = Object.freeze({
      id: fixture.nextItemId,
      turnId: fixture.nextTurnId,
      kind: "assistant" as const,
      markdown: "Terminal structural tail block.",
      status: "running" as const,
    })
    const itemConversation = reduceConversationWithDiagnostics(
      turnConversation,
      {
        type: "item.started",
        threadId: fixture.threadId,
        item: admittedItem,
      },
      createConversationReductionDiagnostics(),
    )
    const itemTranscript = syncTranscriptItem(
      fixture.before.transcript,
      admittedItem,
    )
    const setupSnapshot: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: fixture.before.canonicalRevision + 2,
      conversation: itemConversation,
      transcript: itemTranscript,
    })
    runtime.update(
      runtimeInput(fixture, setupSnapshot, "follow", {
        canonicalDamage: { kind: "blocks", itemIds: [fixture.nextItemId] },
      }),
    )
    const before = runtime.getSnapshot()
    const runtimeBaseline = { ...runtimeCounters }
    const canonicalCounters = createConversationReductionDiagnostics()
    let publications = 0
    runtime.subscribe(() => {
      publications++
    })

    const completedConversation = reduceConversationWithDiagnostics(
      itemConversation,
      {
        type: "turn.completed",
        threadId: fixture.threadId,
        turnId: fixture.nextTurnId,
        outcome: "complete",
        durationMs: 0,
      },
      canonicalCounters,
    )
    const completedSnapshot: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: setupSnapshot.canonicalRevision + 1,
      conversation: completedConversation,
      transcript: itemTranscript,
    })
    const completed = runtime.update(
      runtimeInput(fixture, completedSnapshot, "follow", {
        canonicalDamage: { kind: "blocks", itemIds: [] },
      }),
    )
    const reference = createTranscriptFrame(
      runtimeInput(fixture, completedSnapshot, "follow", {
        canonicalDamage: { kind: "full" },
      }),
    )

    expect(publications).toBe(1)
    expect(completed.blocks.map(blockKey)).toEqual(
      reference.blocks.map(blockKey),
    )
    expect(
      semanticEvidence(completed.transcript, completedConversation),
    ).toEqual(semanticEvidence(itemTranscript, completedConversation))
    expect(completed.blocks).toHaveLength(blockCount + 2)
    expect(completed.window.blocks.length).toBeLessThanOrEqual(48)
    expect(
      completed.blocks
        .slice(0, blockCount)
        .every((block, index) => block === before.blocks[index]),
    ).toBe(true)
    expect(completed.blocks[blockCount]).not.toBe(before.blocks[blockCount])
    expect(completed.blocks[blockCount]?.key).toEqual({
      kind: "item",
      itemId: fixture.nextItemId,
      blockId: "root",
    })
    expect(completed.blocks.at(-1)?.key).toEqual({
      kind: "turn-activity",
      turnId: fixture.nextTurnId,
    })
    expect(completed.blocks[blockCount]).toEqual(reference.blocks[blockCount])
    expect(completed.blocks.at(-1)).toEqual(reference.blocks.at(-1))
    expect(completed.transcript).toBe(before.transcript)
    for (let index = 0; index < blockCount; index++) {
      const itemId = fixture.before.transcript.order[index]!
      const turnId = fixture.before.conversation.turnIds[index]!
      expect(completedConversation.items[itemId]).toBe(
        fixture.before.conversation.items[itemId],
      )
      expect(completedConversation.turns[turnId]).toBe(
        fixture.before.conversation.turns[turnId],
      )
      expect(itemTranscript.projectionById[itemId]).toBe(
        fixture.before.transcript.projectionById[itemId],
      )
    }

    expect(canonicalCounters.conversationTurnIdSequenceNormalizations).toBe(0)
    expect(
      canonicalCounters.conversationTurnIdSequenceNormalizationVisits,
    ).toBe(0)
    expect(canonicalCounters.conversationTurnItemIdSequenceNormalizations).toBe(
      0,
    )
    expect(
      canonicalCounters.conversationTurnItemIdSequenceNormalizationVisits,
    ).toBe(0)
    expect(canonicalCounters.conversationTurnRecordNormalizations).toBe(0)
    expect(canonicalCounters.conversationTurnRecordNormalizationVisits).toBe(0)
    expect(canonicalCounters.conversationItemRecordNormalizations).toBe(0)
    expect(
      canonicalCounters.conversationItemRecordNormalizationItemVisits,
    ).toBe(0)
    expect(canonicalCounters.conversationTurnIdSequenceAppends).toBe(0)
    expect(canonicalCounters.conversationTurnItemIdSequenceAppends).toBe(0)
    expect(canonicalCounters.conversationItemRecordUpdates).toBe(0)
    expect(canonicalCounters.conversationTurnRecordUpdates).toBe(1)
    const logarithmicBound = 12 * (Math.ceil(Math.log2(blockCount + 2)) + 1)
    expect(canonicalCounters.conversationTurnRecordLookups).toBeGreaterThan(0)
    expect(
      canonicalCounters.conversationTurnRecordLookupNodeVisits,
    ).toBeLessThanOrEqual(logarithmicBound)
    expect(
      canonicalCounters.conversationTurnRecordNodeVisits,
    ).toBeLessThanOrEqual(logarithmicBound)
    expect(
      canonicalCounters.conversationTurnRecordNodesCopied,
    ).toBeLessThanOrEqual(logarithmicBound)

    expect(
      runtimeCounters.completePlanBuilds - runtimeBaseline.completePlanBuilds,
    ).toBe(0)
    expect(
      runtimeCounters.completePlanBlockVisits -
        runtimeBaseline.completePlanBlockVisits,
    ).toBe(0)
    expect(
      runtimeCounters.heightIndexBuilds - runtimeBaseline.heightIndexBuilds,
    ).toBe(0)
    expect(
      runtimeCounters.heightIndexBlockVisits -
        runtimeBaseline.heightIndexBlockVisits,
    ).toBe(0)
    expect(
      runtimeCounters.completeGeometryBlockVisits -
        runtimeBaseline.completeGeometryBlockVisits,
    ).toBe(0)
    expect(
      runtimeCounters.blockPlanUpdates - runtimeBaseline.blockPlanUpdates,
    ).toBe(2)
    expect(
      runtimeCounters.blockPlanNodeVisits - runtimeBaseline.blockPlanNodeVisits,
    ).toBeLessThanOrEqual(logarithmicBound)
    expect(
      runtimeCounters.blockPlanNodesCopied -
        runtimeBaseline.blockPlanNodesCopied,
    ).toBeLessThanOrEqual(logarithmicBound)
    expect(
      runtimeCounters.heightIndexUpdates - runtimeBaseline.heightIndexUpdates,
    ).toBe(2)
    expect(
      runtimeCounters.heightIndexNodeVisits -
        runtimeBaseline.heightIndexNodeVisits,
    ).toBeLessThanOrEqual(logarithmicBound)
    expect(
      runtimeCounters.heightIndexNodesCopied -
        runtimeBaseline.heightIndexNodesCopied,
    ).toBeLessThanOrEqual(logarithmicBound)
    expect(
      runtimeCounters.changedItemBuilds - runtimeBaseline.changedItemBuilds,
    ).toBe(1)
    expect(
      runtimeCounters.orderIndexBuilds - runtimeBaseline.orderIndexBuilds,
    ).toBe(0)
    expect(
      runtimeCounters.orderIndexItemVisits -
        runtimeBaseline.orderIndexItemVisits,
    ).toBe(0)
    expect(
      runtimeCounters.textLengthIndexBuilds -
        runtimeBaseline.textLengthIndexBuilds,
    ).toBe(0)
    expect(
      runtimeCounters.textLengthItemVisits -
        runtimeBaseline.textLengthItemVisits,
    ).toBe(0)
    expect(
      runtimeCounters.textLengthIndexUpdates -
        runtimeBaseline.textLengthIndexUpdates,
    ).toBe(0)
    expect(
      runtimeCounters.urlIndexBuilds - runtimeBaseline.urlIndexBuilds,
    ).toBe(0)
    expect(
      runtimeCounters.urlIndexItemVisits - runtimeBaseline.urlIndexItemVisits,
    ).toBe(0)
    expect(
      runtimeCounters.urlIndexUpdates - runtimeBaseline.urlIndexUpdates,
    ).toBe(0)
    expect(
      runtimeCounters.windowGeometryBlockVisits -
        runtimeBaseline.windowGeometryBlockVisits,
    ).toBeLessThanOrEqual(48)
    expect(
      runtimeCounters.blockPlanWindowSliceItems -
        runtimeBaseline.blockPlanWindowSliceItems,
    ).toBeLessThanOrEqual(48)
    runtime.dispose()
  }
}, 30_000)

test("one completed oversized command mounts and reveals bounded production fragments at every exact render-block scale", () => {
  const oversized = buildOversizedTranscriptFixtures().find(
    (fixture) => fixture.shape === "command-output",
  )!
  const appendOversized = (
    fixture: ReturnType<typeof buildTranscriptStructuralScalingFixture>,
  ) => {
    const turnConversation = reduceConversationWithDiagnostics(
      fixture.before.conversation,
      {
        type: "turn.started" as const,
        threadId: fixture.threadId,
        turnId: oversized.item.turnId,
      },
      createConversationReductionDiagnostics(),
    )
    const itemConversation = reduceConversationWithDiagnostics(
      turnConversation,
      {
        type: "item.started" as const,
        threadId: fixture.threadId,
        item: oversized.item,
      },
      createConversationReductionDiagnostics(),
    )
    const completedConversation = reduceConversationWithDiagnostics(
      itemConversation,
      {
        type: "turn.completed" as const,
        threadId: fixture.threadId,
        turnId: oversized.item.turnId,
        outcome: "complete" as const,
        durationMs: 1,
      },
      createConversationReductionDiagnostics(),
    )
    const transcript = syncTranscriptItem(
      fixture.before.transcript,
      oversized.item,
    )
    return Object.freeze({
      fixture,
      completedConversation,
      transcript,
      snapshot: Object.freeze({
        canonicalRevision: fixture.before.canonicalRevision + 3,
        conversation: completedConversation,
        transcript,
      }) satisfies TranscriptFixtureSnapshot,
    })
  }
  const seed = appendOversized(buildTranscriptStructuralScalingFixture(1))
  const addedBlocks =
    createTranscriptFrame(
      runtimeInput(seed.fixture, seed.snapshot, "follow", {
        canonicalDamage: { kind: "full" },
      }),
    ).blocks.length - 1
  let expectedFragmentCount: number | undefined
  let expectedMountedCount: number | undefined
  for (const blockCount of transcriptScalingBlockCounts) {
    const { fixture, completedConversation, transcript, snapshot } =
      appendOversized(
        buildTranscriptStructuralScalingFixture(blockCount - addedBlocks),
      )
    const diagnostics = scalingRuntimeDiagnostics()
    const runtime = new TranscriptRuntime(
      runtimeInput(fixture, snapshot, "follow", {
        canonicalDamage: { kind: "full" },
      }),
      { windowPolicy: { viewportRows: 24, overscanRows: 24 }, diagnostics },
    )
    const followed = runtime.getSnapshot()
    const fragments = followed.blocks.filter(
      (block) =>
        block.key.kind === "item" && block.key.itemId === oversized.item.id,
    )
    expectedFragmentCount ??= fragments.length
    expectedMountedCount ??= followed.window.blocks.length
    expect(fragments.length).toBe(expectedFragmentCount)
    expect(fragments.length).toBeGreaterThan(1)
    expect(
      fragments.every(
        (block) =>
          "projection" in block &&
          block.sourceSpan.to - block.sourceSpan.from <= 4_096,
      ),
    ).toBe(true)
    expect(followed.blocks).toHaveLength(blockCount)
    expect(followed.window.blocks.length).toBe(expectedMountedCount)
    expect(followed.window.blocks.length).toBeLessThanOrEqual(48)
    const reference = createTranscriptFrame(
      runtimeInput(fixture, snapshot, "follow", {
        canonicalDamage: { kind: "full" },
      }),
    )
    expect(followed.blocks.map(blockKey)).toEqual(
      reference.blocks.map(blockKey),
    )
    const referenceFragments = reference.blocks.filter(
      (block) =>
        block.key.kind === "item" && block.key.itemId === oversized.item.id,
    )
    expect(
      referenceFragments.every((block, index) => block === fragments[index]),
    ).toBe(true)
    for (let index = 0; index < fixture.blockCount; index++) {
      const itemId = fixture.before.transcript.order[index]!
      const turnId = fixture.before.conversation.turnIds[index]!
      expect(completedConversation.items[itemId]).toBe(
        fixture.before.conversation.items[itemId],
      )
      expect(completedConversation.turns[turnId]).toBe(
        fixture.before.conversation.turns[turnId],
      )
      expect(transcript.projectionById[itemId]).toBe(
        fixture.before.transcript.projectionById[itemId],
      )
    }

    const projection = transcript.projectionById[oversized.item.id]!
    const point = Object.freeze({
      itemId: oversized.item.id,
      graphemeOffset: Math.floor(projection.sourceSpans.length / 2),
    })
    const heights = createHeightIndex(followed.blocks)!
    const targetDiagnostics = { targetLookupVisits: 0 }
    expect(
      transcriptPointBlockIndex(
        followed.blocks,
        heights,
        point,
        targetDiagnostics,
      ),
    ).toBeDefined()
    expect(targetDiagnostics.targetLookupVisits).toBeLessThanOrEqual(
      Math.ceil(Math.log2(fragments.length)) + 3,
    )
    const detachedTranscript = Object.freeze({
      ...transcript,
      cursor: point,
      viewport: Object.freeze({
        kind: "point" as const,
        point,
        preferredScreenRow: 8,
      }),
    })
    const detachedSnapshot = Object.freeze({
      ...snapshot,
      transcript: detachedTranscript,
    })
    const beforeMove = { ...diagnostics }
    let publications = 0
    runtime.subscribe(() => {
      publications++
    })
    const revealed = runtime.update(
      runtimeInput(fixture, detachedSnapshot, "detached", {
        presentationDamage: { kind: "view" },
        reveal: { id: blockCount, point, reason: "jump" },
      }),
    )
    expect(publications).toBe(1)
    expect(revealed.blocks).toBe(followed.blocks)
    expect(pointIsMaterialized(revealed.window.blocks, point)).toBe(true)
    expect(revealed.window.blocks.length).toBeLessThanOrEqual(48)
    expect(diagnostics.completePlanBuilds - beforeMove.completePlanBuilds).toBe(
      0,
    )
    expect(
      diagnostics.completePlanBlockVisits - beforeMove.completePlanBlockVisits,
    ).toBe(0)
    expect(diagnostics.heightIndexBuilds - beforeMove.heightIndexBuilds).toBe(0)
    expect(
      diagnostics.heightIndexBlockVisits - beforeMove.heightIndexBlockVisits,
    ).toBe(0)
    expect(
      diagnostics.completeGeometryBlockVisits -
        beforeMove.completeGeometryBlockVisits,
    ).toBe(0)
    expect(diagnostics.orderIndexBuilds - beforeMove.orderIndexBuilds).toBe(0)
    expect(
      diagnostics.orderIndexItemVisits - beforeMove.orderIndexItemVisits,
    ).toBe(0)
    expect(
      diagnostics.windowGeometryBlockVisits -
        beforeMove.windowGeometryBlockVisits,
    ).toBeLessThanOrEqual(96)
    expect(
      diagnostics.blockPlanWindowSliceItems -
        beforeMove.blockPlanWindowSliceItems,
    ).toBeLessThanOrEqual(96)
    runtime.dispose()
  }
}, 30_000)

test("oversized completed Markdown and split diffs stay bounded at every historical render-block scale", () => {
  for (const oversized of buildOversizedTranscriptFixtures().filter(
    (fixture) => fixture.shape !== "command-output",
  )) {
    const appendOversized = (
      fixture: ReturnType<typeof buildTranscriptStructuralScalingFixture>,
    ) => {
      const turnConversation = reduceConversationWithDiagnostics(
        fixture.before.conversation,
        {
          type: "turn.started" as const,
          threadId: fixture.threadId,
          turnId: oversized.item.turnId,
        },
        createConversationReductionDiagnostics(),
      )
      const itemConversation = reduceConversationWithDiagnostics(
        turnConversation,
        {
          type: "item.started" as const,
          threadId: fixture.threadId,
          item: oversized.item,
        },
        createConversationReductionDiagnostics(),
      )
      const completedConversation = reduceConversationWithDiagnostics(
        itemConversation,
        {
          type: "turn.completed" as const,
          threadId: fixture.threadId,
          turnId: oversized.item.turnId,
          outcome: "complete" as const,
          durationMs: 1,
        },
        createConversationReductionDiagnostics(),
      )
      const transcript = syncTranscriptItem(
        fixture.before.transcript,
        oversized.item,
      )
      return Object.freeze({
        fixture,
        snapshot: Object.freeze({
          canonicalRevision: fixture.before.canonicalRevision + 3,
          conversation: completedConversation,
          transcript,
        }) satisfies TranscriptFixtureSnapshot,
      })
    }
    const seed = appendOversized(buildTranscriptStructuralScalingFixture(1))
    const addedBlocks =
      createTranscriptFrame(
        runtimeInput(seed.fixture, seed.snapshot, "follow", {
          canonicalDamage: { kind: "full" },
        }),
      ).blocks.length - 1
    expect(addedBlocks).toBeLessThan(200)
    let expectedFragmentCount: number | undefined
    let expectedFollowMounted: number | undefined
    let expectedDetachedMounted: number | undefined
    for (const blockCount of transcriptScalingBlockCounts) {
      const { fixture, snapshot } = appendOversized(
        buildTranscriptStructuralScalingFixture(blockCount),
      )
      const diagnostics = scalingRuntimeDiagnostics()
      const runtime = new TranscriptRuntime(
        runtimeInput(fixture, snapshot, "follow", {
          canonicalDamage: { kind: "full" },
        }),
        { windowPolicy: { viewportRows: 24, overscanRows: 24 }, diagnostics },
      )
      const followed = runtime.getSnapshot()
      const fragments = followed.blocks.filter(
        (block) =>
          block.key.kind === "item" && block.key.itemId === oversized.item.id,
      )
      expectedFragmentCount ??= fragments.length
      expectedFollowMounted ??= followed.window.blocks.length
      expect(fragments).toHaveLength(expectedFragmentCount)
      expect(fragments.length).toBeGreaterThan(1)
      expect(
        fragments.every(
          (block) =>
            "projection" in block &&
            block.sourceSpan.to - block.sourceSpan.from <=
              (oversized.shape === "markdown" ? 4_096 : 240),
        ),
      ).toBe(true)
      expect(followed.blocks).toHaveLength(blockCount + addedBlocks)
      expect(followed.window.blocks.length).toBe(expectedFollowMounted)
      expect(followed.window.blocks.length).toBeLessThanOrEqual(48)
      const reference = createTranscriptFrame(
        runtimeInput(fixture, snapshot, "follow", {
          canonicalDamage: { kind: "full" },
        }),
      )
      const referenceFragments = reference.blocks.filter(
        (block) =>
          block.key.kind === "item" && block.key.itemId === oversized.item.id,
      )
      expect(
        referenceFragments.every((block, index) => block === fragments[index]),
      ).toBe(true)
      expect(reference.blocks.map(blockKey)).toEqual(
        followed.blocks.map(blockKey),
      )

      const projection = snapshot.transcript.projectionById[oversized.item.id]!
      const point = Object.freeze({
        itemId: oversized.item.id,
        graphemeOffset: Math.floor(projection.sourceSpans.length / 2),
      })
      const detachedTranscript = Object.freeze({
        ...snapshot.transcript,
        cursor: point,
        viewport: Object.freeze({
          kind: "point" as const,
          point,
          preferredScreenRow: 8,
        }),
      })
      const beforeMove = { ...diagnostics }
      let publications = 0
      runtime.subscribe(() => {
        publications++
      })
      const revealed = runtime.update(
        runtimeInput(
          fixture,
          Object.freeze({ ...snapshot, transcript: detachedTranscript }),
          "detached",
          {
            presentationDamage: { kind: "view" },
            reveal: { id: blockCount, point, reason: "jump" },
          },
        ),
      )
      expectedDetachedMounted ??= revealed.window.blocks.length
      expect(revealed.blocks).toBe(followed.blocks)
      expect(revealed.window.blocks.length).toBe(expectedDetachedMounted)
      expect(revealed.window.blocks.length).toBeLessThanOrEqual(48)
      expect(pointIsMaterialized(revealed.window.blocks, point)).toBe(true)
      expect(publications).toBe(1)
      expect(
        diagnostics.completePlanBuilds - beforeMove.completePlanBuilds,
      ).toBe(0)
      expect(
        diagnostics.completePlanBlockVisits -
          beforeMove.completePlanBlockVisits,
      ).toBe(0)
      expect(diagnostics.heightIndexBuilds - beforeMove.heightIndexBuilds).toBe(
        0,
      )
      expect(
        diagnostics.heightIndexBlockVisits - beforeMove.heightIndexBlockVisits,
      ).toBe(0)
      expect(
        diagnostics.completeGeometryBlockVisits -
          beforeMove.completeGeometryBlockVisits,
      ).toBe(0)
      expect(diagnostics.orderIndexBuilds - beforeMove.orderIndexBuilds).toBe(0)
      expect(
        diagnostics.orderIndexItemVisits - beforeMove.orderIndexItemVisits,
      ).toBe(0)
      expect(
        diagnostics.windowGeometryBlockVisits -
          beforeMove.windowGeometryBlockVisits,
      ).toBeLessThanOrEqual(96)
      expect(
        diagnostics.blockPlanWindowSliceItems -
          beforeMove.blockPlanWindowSliceItems,
      ).toBeLessThanOrEqual(96)
      runtime.dispose()
    }
  }
}, 60_000)

test("detached unseen accumulation stays logarithmic and publishes no content frame at every scale", () => {
  for (const blockCount of transcriptScalingBlockCounts) {
    const fixture = buildTranscriptStructuralScalingFixture(blockCount)
    const anchorItemId = fixture.before.transcript.order[0]!
    const unseenItemIds = persistentTranscriptUnseenItemIds(
      fixture.before.transcript.order,
    )
    const detachedTranscript = Object.freeze({
      ...fixture.before.transcript,
      cursor: Object.freeze({ itemId: anchorItemId, graphemeOffset: 0 }),
      viewport: Object.freeze({
        kind: "point" as const,
        point: Object.freeze({ itemId: anchorItemId, graphemeOffset: 0 }),
        preferredScreenRow: 7,
      }),
      unseenEntries: blockCount,
      unseenItemIds,
    })
    const detachedSnapshot: TranscriptFixtureSnapshot = Object.freeze({
      ...fixture.before,
      transcript: detachedTranscript,
    })
    transcriptTextLengthRange(detachedTranscript, 0, 0)
    primeTranscriptUrlIndex(detachedTranscript)
    const runtimeCounters = scalingRuntimeDiagnostics()
    const runtime = new TranscriptRuntime(
      runtimeInput(fixture, detachedSnapshot, "detached", {
        canonicalDamage: { kind: "full" },
      }),
      {
        windowPolicy: { viewportRows: 24, overscanRows: 24 },
        diagnostics: runtimeCounters,
      },
    )
    const pinned = runtime.getSnapshot()
    const hiddenDamageBacklog = Array.from(
      { length: blockCount },
      (_, index) =>
        `detached-hidden-damage-${blockCount}-${index}` as import("@vimex/conversation").ItemId,
    )
    const seededSnapshot: TranscriptFixtureSnapshot = Object.freeze({
      ...detachedSnapshot,
      canonicalRevision: detachedSnapshot.canonicalRevision + 1,
    })
    const runtimeBeforeSeed = { ...runtimeCounters }
    expect(
      runtime.update(
        runtimeInput(fixture, seededSnapshot, "detached", {
          canonicalDamage: { kind: "blocks", itemIds: hiddenDamageBacklog },
        }),
      ),
    ).toBe(pinned)
    expect(
      runtimeCounters.hiddenDamageMerges! -
        runtimeBeforeSeed.hiddenDamageMerges!,
    ).toBe(1)
    expect(
      runtimeCounters.hiddenDamageInputItemVisits! -
        runtimeBeforeSeed.hiddenDamageInputItemVisits!,
    ).toBe(blockCount)
    expect(
      runtimeCounters.hiddenDamageItemAdditions! -
        runtimeBeforeSeed.hiddenDamageItemAdditions!,
    ).toBe(blockCount)
    expect(
      runtimeCounters.hiddenDamageSnapshots! -
        runtimeBeforeSeed.hiddenDamageSnapshots!,
    ).toBe(0)
    expect(
      runtimeCounters.hiddenDamageSnapshotItemVisits! -
        runtimeBeforeSeed.hiddenDamageSnapshotItemVisits!,
    ).toBe(0)
    const runtimeBaseline = { ...runtimeCounters }
    const semanticCounters = itemSyncDiagnostics()
    const canonicalCounters = createConversationReductionDiagnostics()
    let publications = 0
    runtime.subscribe(() => {
      publications++
    })

    const turnConversation = reduceConversationWithDiagnostics(
      seededSnapshot.conversation,
      {
        type: "turn.started",
        threadId: fixture.threadId,
        turnId: fixture.nextTurnId,
      },
      canonicalCounters,
    )
    const afterTurn: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: seededSnapshot.canonicalRevision + 1,
      conversation: turnConversation,
      transcript: detachedTranscript,
    })
    expect(
      runtime.update(
        runtimeInput(fixture, afterTurn, "detached", {
          canonicalDamage: { kind: "blocks", itemIds: [] },
        }),
      ),
    ).toBe(pinned)

    const admittedItem = Object.freeze({
      id: fixture.nextItemId,
      turnId: fixture.nextTurnId,
      kind: "assistant" as const,
      markdown: "Detached unseen tail block.",
      status: "running" as const,
    })
    const itemConversation = reduceConversationWithDiagnostics(
      turnConversation,
      {
        type: "item.started",
        threadId: fixture.threadId,
        item: admittedItem,
      },
      canonicalCounters,
    )
    const itemTranscript = syncTranscriptItem(
      detachedTranscript,
      admittedItem,
      semanticCounters,
    )
    const afterItem: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: afterTurn.canonicalRevision + 1,
      conversation: itemConversation,
      transcript: itemTranscript,
    })
    expect(
      runtime.update(
        runtimeInput(fixture, afterItem, "detached", {
          canonicalDamage: { kind: "blocks", itemIds: [fixture.nextItemId] },
        }),
      ),
    ).toBe(pinned)

    const deltaConversation = reduceConversationWithDiagnostics(
      itemConversation,
      {
        type: "item.delta",
        threadId: fixture.threadId,
        itemId: fixture.nextItemId,
        delta: " More.",
      },
      canonicalCounters,
    )
    const changedItem = deltaConversation.items[fixture.nextItemId]!
    const repeatedTranscript = syncTranscriptItem(
      itemTranscript,
      changedItem,
      semanticCounters,
    )
    const afterDelta: TranscriptFixtureSnapshot = Object.freeze({
      canonicalRevision: afterItem.canonicalRevision + 1,
      conversation: deltaConversation,
      transcript: repeatedTranscript,
    })
    expect(
      runtime.update(
        runtimeInput(fixture, afterDelta, "detached", {
          canonicalDamage: { kind: "blocks", itemIds: [fixture.nextItemId] },
        }),
      ),
    ).toBe(pinned)

    expect(publications).toBe(0)
    expect(runtime.getSnapshot()).toBe(pinned)
    expect(repeatedTranscript.unseenEntries).toBe(blockCount + 1)
    expect(repeatedTranscript.unseenItemIds).toBe(itemTranscript.unseenItemIds)
    expect([...repeatedTranscript.unseenItemIds]).toEqual([
      ...unseenItemIds,
      fixture.nextItemId,
    ])
    expect(semanticCounters.unseenItemSequenceNormalizations).toBe(0)
    expect(semanticCounters.unseenItemSequenceNormalizationItemVisits).toBe(0)
    expect(semanticCounters.unseenItemMembershipChecks).toBe(2)
    expect(semanticCounters.unseenItemMembershipNodeVisits).toBeLessThanOrEqual(
      64,
    )
    expect(semanticCounters.unseenItemAppends).toBe(1)
    expect(semanticCounters.unseenItemAppendNodeVisits).toBeLessThanOrEqual(32)
    expect(
      semanticCounters.unseenItemIndexUpdateNodeVisits,
    ).toBeLessThanOrEqual(32)
    expect(
      semanticCounters.unseenItemIndexUpdateNodesCopied,
    ).toBeLessThanOrEqual(64)
    expect(semanticCounters.textLengthIndexBuilds).toBe(0)
    expect(semanticCounters.textLengthItemVisits).toBe(0)
    expect(semanticCounters.textLengthIndexUpdates).toBe(2)
    expect(semanticCounters.urlIndexBuilds).toBe(0)
    expect(semanticCounters.urlIndexItemVisits).toBe(0)
    expect(semanticCounters.urlIndexUpdates).toBe(2)
    expect(canonicalCounters.conversationTurnIdSequenceNormalizations).toBe(0)
    expect(
      canonicalCounters.conversationTurnIdSequenceNormalizationVisits,
    ).toBe(0)
    expect(canonicalCounters.conversationTurnRecordNormalizations).toBe(0)
    expect(canonicalCounters.conversationTurnRecordNormalizationVisits).toBe(0)
    expect(canonicalCounters.conversationItemRecordNormalizations).toBe(0)
    expect(
      canonicalCounters.conversationItemRecordNormalizationItemVisits,
    ).toBe(0)
    expect(
      runtimeCounters.hiddenDamageMerges! -
        (runtimeBaseline.hiddenDamageMerges ?? 0),
    ).toBe(3)
    expect(
      runtimeCounters.hiddenDamageInputItemVisits! -
        (runtimeBaseline.hiddenDamageInputItemVisits ?? 0),
    ).toBe(2)
    expect(
      runtimeCounters.hiddenDamageItemAdditions! -
        (runtimeBaseline.hiddenDamageItemAdditions ?? 0),
    ).toBe(1)
    expect(
      runtimeCounters.hiddenDamageSnapshots! -
        (runtimeBaseline.hiddenDamageSnapshots ?? 0),
    ).toBe(0)
    expect(
      runtimeCounters.completePlanBuilds - runtimeBaseline.completePlanBuilds,
    ).toBe(0)
    expect(
      runtimeCounters.completePlanBlockVisits -
        runtimeBaseline.completePlanBlockVisits,
    ).toBe(0)
    expect(
      runtimeCounters.blockPlanUpdates - runtimeBaseline.blockPlanUpdates,
    ).toBe(0)
    expect(
      runtimeCounters.heightIndexBuilds - runtimeBaseline.heightIndexBuilds,
    ).toBe(0)
    expect(
      runtimeCounters.heightIndexUpdates - runtimeBaseline.heightIndexUpdates,
    ).toBe(0)
    expect(
      runtimeCounters.completeGeometryBlockVisits -
        runtimeBaseline.completeGeometryBlockVisits,
    ).toBe(0)
    expect(
      runtimeCounters.windowGeometryBlockVisits -
        runtimeBaseline.windowGeometryBlockVisits,
    ).toBe(0)
    expect(
      runtimeCounters.changedItemBuilds - runtimeBaseline.changedItemBuilds,
    ).toBe(0)

    const presented = runtime.update({
      ...runtimeInput(fixture, afterDelta, "detached"),
      presentationDamage: { kind: "view" },
    })
    expect(publications).toBe(1)
    expect(presented.blocks).toBe(pinned.blocks)
    expect(presented.window).toBe(pinned.window)
    expect(presented.geometry).toBe(pinned.geometry)
    expect(presented.transcript.unseenItemIds).toBe(
      repeatedTranscript.unseenItemIds,
    )
    runtime.dispose()
  }
}, 30_000)

test("production window policy bounds initial, detached, reveal, and measured materialization at every scale", () => {
  const policy = Object.freeze({ viewportRows: 24, overscanRows: 24 })
  for (const blockCount of transcriptScalingBlockCounts) {
    const fixture = buildTranscriptScalingFixture(blockCount)
    const runtime = new TranscriptRuntime(
      runtimeInput(fixture, fixture.before, "follow", {
        canonicalDamage: { kind: "full" },
      }),
      { windowPolicy: policy },
    )
    const initial = runtime.getSnapshot()
    expect(initial.blocks).toHaveLength(blockCount)
    expect(initial.window.blocks).toHaveLength(48)
    expect(initial.window.bottomSpacerRows).toBe(0)
    expect(initial.window.topSpacerRows).toBe(blockCount - 48)
    expect(
      initial.window.blocks.every(
        (block, index) => block === initial.blocks[blockCount - 48 + index],
      ),
    ).toBe(true)
    expectPassThroughEquivalent(initial, fixture.before)

    let publications = 0
    runtime.subscribe(() => {
      publications++
    })
    expect(runtime.setWindowViewport(24, 24)).toBe(initial)
    expect(publications).toBe(0)
    const narrower = runtime.setWindowViewport(12, 12)
    expect(publications).toBe(1)
    expect(narrower.window.blocks).toHaveLength(24)
    expect(narrower.window.bottomSpacerRows).toBe(0)

    const offWindow = narrower.blocks[0]!
    const staleNative: BlockGeometry = {
      key: {
        blockKey: blockKey(offWindow),
        contentRevision: offWindow.contentRevision,
        width: 80,
        styleRevision: "scaling-test",
        folded: false,
      },
      nativeRevision: 1,
      rows: 1,
      points: point,
      lines,
    }
    expect(
      runtime.reportMeasurements({
        ...runtime.measurementBase(),
        measurements: [staleNative],
      }),
    ).toBe(narrower)
    expect(publications).toBe(1)

    const detachedPoint = Object.freeze({
      itemId: fixture.targets.quarter,
      graphemeOffset: 0,
    })
    const detachedTranscript = Object.freeze({
      ...fixture.before.transcript,
      cursor: detachedPoint,
      viewport: Object.freeze({
        kind: "point" as const,
        point: detachedPoint,
        preferredScreenRow: 5,
      }),
    })
    const detachedSnapshot = Object.freeze({
      ...fixture.before,
      transcript: detachedTranscript,
    })
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
      projectionRecordUpdates: 0,
      projectionRecordNodeVisits: 0,
      projectionRecordNodesCopied: 0,
      blockPlanUpdates: 0,
      blockPlanNodeVisits: 0,
      blockPlanNodesCopied: 0,
      changedItemBuilds: 0,
    }
    const detached = new TranscriptRuntime(
      runtimeInput(fixture, detachedSnapshot, "detached", {
        canonicalDamage: { kind: "full" },
      }),
      {
        windowPolicy: policy,
        diagnostics: runtimeDiagnostics,
      },
    )
    const pinned = detached.getSnapshot()
    expect(pinned.blocks).toHaveLength(blockCount)
    expect(pinned.window.blocks.length).toBeLessThanOrEqual(72)
    expect(pointIsMaterialized(pinned.window.blocks, detachedPoint)).toBe(true)
    expect(
      pinned.window.topSpacerRows +
        pinned.window.blocks.length +
        pinned.window.bottomSpacerRows,
    ).toBe(blockCount)

    const hidden = appendTranscriptScalingTail(
      detachedSnapshot,
      fixture.tailItemId,
      fixture.tailDelta,
    )
    expect(
      detached.update(
        runtimeInput(fixture, hidden, "detached", {
          canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
        }),
      ),
    ).toBe(pinned)
    const diagnosticsBeforeReveal = { ...runtimeDiagnostics }
    const tailPoint = Object.freeze({
      itemId: fixture.targets.tail,
      graphemeOffset: 0,
    })
    const revealedTranscript = Object.freeze({
      ...hidden.transcript,
      cursor: tailPoint,
      viewport: Object.freeze({
        kind: "point" as const,
        point: tailPoint,
        preferredScreenRow: 5,
      }),
    })
    const revealedSnapshot = Object.freeze({
      ...hidden,
      transcript: revealedTranscript,
    })
    let revealPublications = 0
    detached.subscribe(() => {
      revealPublications++
    })
    const revealed = detached.update(
      runtimeInput(fixture, revealedSnapshot, "detached", {
        reveal: { id: blockCount, point: tailPoint, reason: "jump" },
        presentationDamage: { kind: "view" },
      }),
    )
    expect(revealed.window.blocks.length).toBeLessThanOrEqual(72)
    expect(pointIsMaterialized(revealed.window.blocks, tailPoint)).toBe(true)
    expect(revealed.blocks).toBe(pinned.blocks)
    expect(revealed.displayedCanonicalRevision).toBe(
      pinned.displayedCanonicalRevision,
    )
    expect(revealPublications).toBe(1)
    expect(
      runtimeDiagnostics.completePlanBuilds -
        diagnosticsBeforeReveal.completePlanBuilds,
    ).toBe(0)
    expect(
      runtimeDiagnostics.completePlanBlockVisits -
        diagnosticsBeforeReveal.completePlanBlockVisits,
    ).toBe(0)
    expect(
      runtimeDiagnostics.orderIndexBuilds -
        diagnosticsBeforeReveal.orderIndexBuilds,
    ).toBe(0)
    expect(
      runtimeDiagnostics.orderIndexItemVisits -
        diagnosticsBeforeReveal.orderIndexItemVisits,
    ).toBe(0)
    runtime.dispose()
    detached.dispose()
  }
}, 30_000)

test.each([...transcriptScalingBlockCounts])(
  "accepted height correction is atomic, window-local, immutable, and bounded at %i blocks",
  (blockCount) => {
    const fixture = buildTranscriptScalingFixture(blockCount)
    const runtime = new TranscriptRuntime(
      runtimeInput(fixture, fixture.before, "follow", {
        canonicalDamage: { kind: "full" },
      }),
      { windowPolicy: { viewportRows: 24, overscanRows: 24 } },
    )
    const before = runtime.getSnapshot()
    const block = before.window.blocks.at(-1)!
    const key = blockKey(block)
    const base = runtime.measurementBase(before)
    let publications = 0
    runtime.subscribe(() => {
      publications++
    })
    const corrected = runtime.reportMeasurements({
      ...base,
      measurements: [
        Object.freeze({
          key: Object.freeze({
            blockKey: key,
            contentRevision: block.contentRevision,
            width: 80,
            styleRevision: "correction-scaling",
            folded:
              block.key.kind === "item" &&
              Boolean(before.transcript.folded[block.key.itemId]),
          }),
          nativeRevision: 1,
          rows: 4,
          pointCount: 1,
          points: point,
          pointOffsetsByRow: offsets,
          lines,
          lineByRow,
        }),
      ],
    })

    expect(publications).toBe(1)
    expect(corrected).not.toBe(before)
    expect(before.geometry.totalRows).toBe(blockCount)
    expect(before.geometry.byBlockKey[key]).toBeUndefined()
    expect(corrected.geometry.totalRows).toBe(blockCount + 3)
    expect(corrected.geometry.blockRows).toHaveLength(
      corrected.window.blocks.length,
    )
    expect(
      Object.keys(corrected.geometry.byBlockKey).length,
    ).toBeLessThanOrEqual(corrected.window.blocks.length)
    expect(corrected.window.blocks.length).toBeLessThanOrEqual(48)
    expect(corrected.blocks).toBe(before.blocks)
    expect(corrected.transcript).toBe(before.transcript)
    expect(runtime.reportMeasurements({ ...base, measurements: [] })).toBe(
      corrected,
    )
    expect(
      runtime.reportMeasurements({
        ...base,
        measurements: [
          Object.freeze({
            ...corrected.geometry.byBlockKey[key]!,
            nativeRevision: 2,
          }),
        ],
      }),
    ).toBe(corrected)
    expect(publications).toBe(1)

    const reset = runtime.resetLayout("width")
    expect(publications).toBe(2)
    expect(reset.geometry.measuredBlockCount).toBe(0)
    expect(reset.geometry.totalRows).toBe(blockCount)
    expect(reset.window.blocks.length).toBe(48)
    runtime.dispose()
  },
  30_000,
)

test.each([...transcriptScalingBlockCounts])(
  "incremental runtime projection updates preserve the warm selection-length index at %i blocks",
  (blockCount) => {
    const fixture = buildTranscriptScalingFixture(blockCount)
    const diagnostics = {
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
      projectionRecordUpdates: 0,
      projectionRecordNodeVisits: 0,
      projectionRecordNodesCopied: 0,
      blockPlanUpdates: 0,
      blockPlanNodeVisits: 0,
      blockPlanNodesCopied: 0,
      changedItemBuilds: 0,
    }
    const runtime = new TranscriptRuntime(
      runtimeInput(fixture, fixture.before, "follow", {
        canonicalDamage: { kind: "full" },
      }),
      {
        windowPolicy: { viewportRows: 24, overscanRows: 24 },
        diagnostics,
      },
    )
    const before = selectedGraphemeCount(runtime.getSnapshot().transcript)
    const beforeUpdate = { ...diagnostics }
    const followed = runtime.update(
      runtimeInput(fixture, fixture.afterTailDelta, "follow", {
        canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
      }),
    )
    expect(diagnostics.changedItemBuilds - beforeUpdate.changedItemBuilds).toBe(
      1,
    )
    expect(
      diagnostics.completePlanBuilds - beforeUpdate.completePlanBuilds,
    ).toBe(0)
    expect(
      diagnostics.completePlanBlockVisits -
        beforeUpdate.completePlanBlockVisits,
    ).toBe(0)
    expect(
      diagnostics.projectionRecordUpdates -
        beforeUpdate.projectionRecordUpdates,
    ).toBe(1)
    expect(
      diagnostics.projectionRecordNodeVisits -
        beforeUpdate.projectionRecordNodeVisits,
    ).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(blockCount + 1)) + 1)
    expect(
      diagnostics.projectionRecordNodesCopied -
        beforeUpdate.projectionRecordNodesCopied,
    ).toBe(
      diagnostics.projectionRecordNodeVisits -
        beforeUpdate.projectionRecordNodeVisits,
    )
    expect(diagnostics.blockPlanUpdates - beforeUpdate.blockPlanUpdates).toBe(1)
    expect(
      diagnostics.blockPlanNodeVisits - beforeUpdate.blockPlanNodeVisits,
    ).toBeLessThanOrEqual(2 * (Math.ceil(Math.log2(blockCount)) + 1))
    expect(
      diagnostics.blockPlanNodesCopied - beforeUpdate.blockPlanNodesCopied,
    ).toBeGreaterThan(0)
    expect(
      diagnostics.blockPlanNodesCopied - beforeUpdate.blockPlanNodesCopied,
    ).toBeLessThanOrEqual(Math.ceil(Math.log2(blockCount)) + 1)
    expect(diagnostics.heightIndexBuilds - beforeUpdate.heightIndexBuilds).toBe(
      0,
    )
    expect(
      diagnostics.heightIndexBlockVisits - beforeUpdate.heightIndexBlockVisits,
    ).toBe(0)
    expect(
      diagnostics.heightIndexUpdates - beforeUpdate.heightIndexUpdates,
    ).toBe(1)
    expect(
      diagnostics.heightIndexNodeVisits - beforeUpdate.heightIndexNodeVisits,
    ).toBeLessThanOrEqual(Math.ceil(Math.log2(blockCount)) + 1)
    expect(
      diagnostics.completeGeometryBlockVisits -
        beforeUpdate.completeGeometryBlockVisits,
    ).toBe(0)
    expect(
      diagnostics.windowGeometryBlockVisits -
        beforeUpdate.windowGeometryBlockVisits,
    ).toBeLessThanOrEqual(48)
    expect(
      diagnostics.blockPlanWindowSliceItems -
        beforeUpdate.blockPlanWindowSliceItems,
    ).toBeLessThanOrEqual(48)
    expect(
      diagnostics.textLengthIndexBuilds - beforeUpdate.textLengthIndexBuilds,
    ).toBe(0)
    expect(
      diagnostics.textLengthItemVisits - beforeUpdate.textLengthItemVisits,
    ).toBe(0)
    expect(
      diagnostics.textLengthIndexUpdates - beforeUpdate.textLengthIndexUpdates,
    ).toBe(1)
    const beforeQuery = { ...diagnostics }
    expect(selectedGraphemeCount(followed.transcript, diagnostics)).toBe(before)
    expect(
      diagnostics.textLengthIndexBuilds - beforeQuery.textLengthIndexBuilds,
    ).toBe(0)
    expect(
      diagnostics.textLengthItemVisits - beforeQuery.textLengthItemVisits,
    ).toBe(0)
    expect(
      diagnostics.textLengthIndexCacheHits -
        beforeQuery.textLengthIndexCacheHits,
    ).toBe(1)
    expect(
      diagnostics.textLengthNodeVisits - beforeQuery.textLengthNodeVisits,
    ).toBeLessThan(64)
    runtime.dispose()
  },
  30_000,
)

test("unchanged detached history returns to the tail without rebuilding at every scale", () => {
  for (const blockCount of transcriptScalingBlockCounts) {
    const fixture = buildTranscriptScalingFixture(blockCount)
    const diagnostics = scalingRuntimeDiagnostics()
    const runtime = new TranscriptRuntime(
      runtimeInput(fixture, fixture.before, "follow"),
      {
        windowPolicy: { viewportRows: 24, overscanRows: 24 },
        diagnostics,
      },
    )
    const initial = runtime.getSnapshot()
    const anchor = Object.freeze({
      itemId: fixture.targets.quarter,
      graphemeOffset: 0,
    })
    const detachedTranscript = Object.freeze({
      ...fixture.before.transcript,
      cursor: anchor,
      viewport: Object.freeze({
        kind: "point" as const,
        point: anchor,
        preferredScreenRow: 5,
      }),
    })
    const detachedSnapshot = Object.freeze({
      ...fixture.before,
      transcript: detachedTranscript,
    })
    runtime.update(
      runtimeInput(fixture, detachedSnapshot, "detached", {
        presentationDamage: { kind: "view" },
      }),
    )
    const tailTranscript = Object.freeze({
      ...fixture.before.transcript,
      cursor: Object.freeze({ itemId: fixture.tailItemId, graphemeOffset: 0 }),
      viewport: Object.freeze({ kind: "tail" as const }),
    })
    const tailSnapshot = Object.freeze({
      ...fixture.before,
      transcript: tailTranscript,
    })
    const before = { ...diagnostics }
    let publications = 0
    const unsubscribe = runtime.subscribe(() => {
      publications++
    })
    const reattached = runtime.update(
      runtimeInput(fixture, tailSnapshot, "follow", {
        presentationDamage: { kind: "view" },
      }),
    )
    unsubscribe()

    expect(publications).toBe(1)
    expect(reattached.mode).toBe("follow")
    expect(reattached.transcript.cursor).toEqual(tailTranscript.cursor)
    expect(reattached.transcript.viewport).toEqual(tailTranscript.viewport)
    expect(reattached.displayedCanonicalRevision).toBe(
      fixture.before.canonicalRevision,
    )
    expect(reattached.blocks).toBe(initial.blocks)
    expect(reattached.window.bottomSpacerRows).toBe(0)
    expect(reattached.window.blocks.length).toBeLessThanOrEqual(48)
    expect(diagnostics.completePlanBuilds - before.completePlanBuilds).toBe(0)
    expect(
      diagnostics.completePlanBlockVisits - before.completePlanBlockVisits,
    ).toBe(0)
    expect(diagnostics.heightIndexBuilds - before.heightIndexBuilds).toBe(0)
    expect(diagnostics.heightIndexUpdates - before.heightIndexUpdates).toBe(0)
    expect(
      diagnostics.windowGeometryBlockVisits - before.windowGeometryBlockVisits,
    ).toBeLessThanOrEqual(48)
    expect(
      diagnostics.blockPlanWindowSliceItems - before.blockPlanWindowSliceItems,
    ).toBeLessThanOrEqual(48)
    runtime.dispose()
  }
}, 30_000)

test("hidden same-item output reattaches once with bounded reconciliation at every scale", () => {
  for (const blockCount of transcriptScalingBlockCounts) {
    const fixture = buildTranscriptScalingFixture(blockCount)
    const diagnostics = {
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
      projectionRecordUpdates: 0,
      projectionRecordNodeVisits: 0,
      projectionRecordNodesCopied: 0,
      blockPlanUpdates: 0,
      blockPlanNodeVisits: 0,
      blockPlanNodesCopied: 0,
      changedItemBuilds: 0,
    }
    const runtime = new TranscriptRuntime(
      runtimeInput(fixture, fixture.before, "follow", {
        canonicalDamage: { kind: "full" },
      }),
      {
        windowPolicy: { viewportRows: 24, overscanRows: 24 },
        diagnostics,
      },
    )
    const anchor = Object.freeze({
      itemId: fixture.targets.quarter,
      graphemeOffset: 0,
    })
    const detachedTranscript = Object.freeze({
      ...fixture.before.transcript,
      cursor: anchor,
      viewport: Object.freeze({
        kind: "point" as const,
        point: anchor,
        preferredScreenRow: 5,
      }),
    })
    const detachedSnapshot = Object.freeze({
      ...fixture.before,
      transcript: detachedTranscript,
    })
    runtime.update(
      runtimeInput(fixture, detachedSnapshot, "detached", {
        presentationDamage: { kind: "view" },
      }),
    )
    const pinned = runtime.getSnapshot()
    const staleBase = runtime.measurementBase(pinned)
    const hidden = appendTranscriptScalingTail(
      detachedSnapshot,
      fixture.tailItemId,
      fixture.tailDelta,
    )
    expect(
      runtime.update(
        runtimeInput(fixture, hidden, "detached", {
          canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
        }),
      ),
    ).toBe(pinned)
    const latestTranscript = Object.freeze({
      ...hidden.transcript,
      viewport: Object.freeze({ kind: "tail" as const }),
      unseenEntries: 0,
      unseenItemIds: Object.freeze([]),
    })
    const latest = Object.freeze({ ...hidden, transcript: latestTranscript })
    const before = { ...diagnostics }
    let publications = 0
    const unsubscribe = runtime.subscribe(() => {
      publications++
    })
    const reattached = runtime.update(
      runtimeInput(fixture, latest, "follow", {
        presentationDamage: { kind: "view" },
      }),
    )
    unsubscribe()

    expect(publications).toBe(1)
    expect(reattached.mode).toBe("follow")
    expect(reattached.displayedCanonicalRevision).toBe(latest.canonicalRevision)
    expect(reattached.window.bottomSpacerRows).toBe(0)
    expect(reattached.window.blocks.length).toBeLessThanOrEqual(48)
    expectPassThroughEquivalent(reattached, latest)
    expect(diagnostics.completePlanBuilds - before.completePlanBuilds).toBe(0)
    expect(
      diagnostics.completePlanBlockVisits - before.completePlanBlockVisits,
    ).toBe(0)
    expect(diagnostics.heightIndexBuilds - before.heightIndexBuilds).toBe(0)
    expect(
      diagnostics.heightIndexBlockVisits - before.heightIndexBlockVisits,
    ).toBe(0)
    expect(diagnostics.heightIndexUpdates - before.heightIndexUpdates).toBe(1)
    expect(
      diagnostics.heightIndexNodeVisits - before.heightIndexNodeVisits,
    ).toBeLessThanOrEqual(Math.ceil(Math.log2(blockCount)) + 1)
    expect(diagnostics.blockPlanUpdates - before.blockPlanUpdates).toBe(1)
    expect(
      diagnostics.blockPlanNodeVisits - before.blockPlanNodeVisits,
    ).toBeLessThanOrEqual(2 * (Math.ceil(Math.log2(blockCount)) + 1))
    expect(
      diagnostics.completeGeometryBlockVisits -
        before.completeGeometryBlockVisits,
    ).toBe(0)
    expect(
      diagnostics.windowGeometryBlockVisits - before.windowGeometryBlockVisits,
    ).toBeLessThanOrEqual(48)
    expect(
      diagnostics.blockPlanWindowSliceItems - before.blockPlanWindowSliceItems,
    ).toBeLessThanOrEqual(48)

    const staleBlock = pinned.window.blocks[0]!
    expect(
      runtime.reportMeasurements({
        ...staleBase,
        measurements: [
          {
            key: {
              blockKey: blockKey(staleBlock),
              contentRevision: staleBlock.contentRevision,
              width: 80,
              styleRevision: "stale-reattach",
              folded: false,
            },
            nativeRevision: 1,
            rows: 2,
            points: point,
            lines,
          },
        ],
      }),
    ).toBe(reattached)
    runtime.dispose()
  }
}, 15_000)

test("an equal-height native revision publishes once and its acknowledgement is a no-op", () => {
  const fixture = buildTranscriptScalingFixture(100)
  const runtime = new TranscriptRuntime(
    runtimeInput(fixture, fixture.before, "follow", {
      canonicalDamage: { kind: "full" },
    }),
    { windowPolicy: { viewportRows: 12, overscanRows: 12 } },
  )
  const before = runtime.getSnapshot()
  const block = before.window.blocks.at(-1)!
  const geometry = Object.freeze({
    key: Object.freeze({
      blockKey: blockKey(block),
      contentRevision: block.contentRevision,
      width: 80,
      styleRevision: "equal-height-reflow",
      folded:
        block.key.kind === "item" &&
        Boolean(before.transcript.folded[block.key.itemId]),
    }),
    nativeRevision: 1,
    rows: block.estimatedRows,
    pointCount: 1,
    points: point,
    pointOffsetsByRow: offsets,
    lines,
    lineByRow,
  })
  let publications = 0
  runtime.subscribe(() => {
    publications++
  })

  const accepted = runtime.reportMeasurements({
    ...runtime.measurementBase(before),
    measurements: [geometry],
  })
  expect(accepted).not.toBe(before)
  expect(accepted.geometry.totalRows).toBe(before.geometry.totalRows)
  expect(
    accepted.geometry.byBlockKey[geometry.key.blockKey]?.nativeRevision,
  ).toBe(1)
  expect(publications).toBe(1)

  expect(
    runtime.reportMeasurements({
      ...runtime.measurementBase(accepted),
      measurements: [geometry],
    }),
  ).toBe(accepted)
  expect(publications).toBe(1)
  runtime.dispose()
})

test("detached correction replans from the measured row inside the logical anchor block", () => {
  const fixture = buildTranscriptScalingFixture(100)
  const projection =
    fixture.before.transcript.projectionById[fixture.targets.middle]!
  const anchor = Object.freeze({
    itemId: fixture.targets.middle,
    graphemeOffset: Math.min(5, projection.sourceSpans.length),
  })
  const transcript = Object.freeze({
    ...fixture.before.transcript,
    cursor: anchor,
    viewport: Object.freeze({
      kind: "point" as const,
      point: anchor,
      preferredScreenRow: 2,
    }),
  })
  const snapshot = Object.freeze({ ...fixture.before, transcript })
  const runtime = new TranscriptRuntime(
    runtimeInput(fixture, snapshot, "detached", {
      canonicalDamage: { kind: "full" },
    }),
    { windowPolicy: { viewportRows: 8, overscanRows: 8 } },
  )
  const before = runtime.getSnapshot()
  const block = before.window.blocks.find(
    (candidate) =>
      candidate.key.kind === "item" && candidate.key.itemId === anchor.itemId,
  )!
  const key = blockKey(block)
  const corrected = runtime.reportMeasurements({
    ...runtime.measurementBase(before),
    measurements: [
      Object.freeze({
        key: Object.freeze({
          blockKey: key,
          contentRevision: block.contentRevision,
          width: 80,
          styleRevision: "anchor-correction",
          folded: false,
        }),
        nativeRevision: 1,
        rows: 10,
        points: Object.freeze({
          [anchor.graphemeOffset]: Object.freeze({
            graphemeOffset: anchor.graphemeOffset,
            x: 0,
            y: 6,
            row: 6,
            column: 0,
          }),
        }),
        lines: Object.freeze([
          { from: anchor.graphemeOffset, to: anchor.graphemeOffset, row: 6 },
        ]),
      }),
    ],
  })

  expect(corrected.transcript.viewport).toEqual(before.transcript.viewport)
  expect(corrected.window.topSpacerRows).toBeGreaterThan(
    before.window.topSpacerRows,
  )
  expect(pointIsMaterialized(corrected.window.blocks, anchor)).toBe(true)
  expect(corrected.geometry.rowByBlockKey[key]! + 6 - 2 - 8).toBe(
    corrected.window.topSpacerRows,
  )
  expect(
    corrected.geometry.byBlockKey[key]?.points[anchor.graphemeOffset]?.row,
  ).toBe(6)
  expect(before.window.topSpacerRows).toBeLessThan(
    corrected.window.topSpacerRows,
  )
  runtime.dispose()
})

test("a mixed invalid windowed batch cannot leak a staged height replacement", () => {
  const fixture = buildTranscriptScalingFixture(100)
  const runtime = new TranscriptRuntime(
    runtimeInput(fixture, fixture.before, "follow", {
      canonicalDamage: { kind: "full" },
    }),
    { windowPolicy: { viewportRows: 8, overscanRows: 8 } },
  )
  const before = runtime.getSnapshot()
  const [first, second] = before.window.blocks.slice(-2)
  const geometry = (
    block: typeof first,
    rows: number,
    contentRevision = block!.contentRevision,
  ): BlockGeometry => ({
    key: {
      blockKey: blockKey(block!),
      contentRevision,
      width: 80,
      styleRevision: "atomic-correction",
      folded:
        block!.key.kind === "item" &&
        Boolean(before.transcript.folded[block!.key.itemId]),
    },
    nativeRevision: 1,
    rows,
    points: point,
    lines,
  })
  const base = runtime.measurementBase(before)
  expect(
    runtime.reportMeasurements({
      ...base,
      measurements: [
        geometry(first, 7),
        geometry(second, 3, second!.contentRevision + 1),
      ],
    }),
  ).toBe(before)
  const accepted = runtime.reportMeasurements({
    ...base,
    measurements: [geometry(first, 2)],
  })
  expect(accepted.geometry.totalRows).toBe(101)
  expect(before.geometry.totalRows).toBe(100)
  runtime.dispose()
})

test("a fold transition discards the incompatible measured height before replanning", () => {
  const fixture = buildTranscriptScalingFixture(100)
  const runtime = new TranscriptRuntime(
    runtimeInput(fixture, fixture.before, "follow", {
      canonicalDamage: { kind: "full" },
    }),
    { windowPolicy: { viewportRows: 12, overscanRows: 12 } },
  )
  const before = runtime.getSnapshot()
  const block = before.window.blocks.find(
    (candidate) =>
      candidate.key.kind === "item" &&
      !before.transcript.folded[candidate.key.itemId],
  )!
  expect(block).toBeDefined()
  const key = blockKey(block)
  const measured = runtime.reportMeasurements({
    ...runtime.measurementBase(before),
    measurements: [
      {
        key: {
          blockKey: key,
          contentRevision: block.contentRevision,
          width: 80,
          styleRevision: "fold-height",
          folded: false,
        },
        nativeRevision: 1,
        rows: 8,
        points: point,
        lines,
      },
    ],
  })
  expect(measured.geometry.totalRows).toBe(107)

  const foldedTranscript = Object.freeze({
    ...fixture.before.transcript,
    folded: Object.freeze({
      ...fixture.before.transcript.folded,
      [block.key.kind === "item" ? block.key.itemId : ""]: true,
    }),
  })
  const foldedSnapshot = Object.freeze({
    ...fixture.before,
    transcript: foldedTranscript,
  })
  const folded = runtime.update(
    runtimeInput(fixture, foldedSnapshot, "follow", {
      presentationDamage: { kind: "view" },
    }),
  )
  expect(folded.geometry.totalRows).toBe(100)
  expect(folded.geometry.byBlockKey[key]).toBeUndefined()
  runtime.dispose()
})

test.each([...transcriptScalingBlockCounts])(
  "single off-window folds update logarithmic height paths and bounded geometry at %i blocks",
  (blockCount) => {
    const fixture = buildTranscriptScalingFixture(blockCount)
    const anchor = { itemId: fixture.targets.quarter, graphemeOffset: 0 }
    const target = fixture.targets.threeQuarter
    const targetPoint = { itemId: target, graphemeOffset: 0 }
    const targetTranscript = Object.freeze({
      ...fixture.before.transcript,
      folded: setTranscriptFoldValue(
        fixture.before.transcript.folded,
        target,
        false,
      ),
      cursor: targetPoint,
      viewport: Object.freeze({
        kind: "point" as const,
        point: targetPoint,
        preferredScreenRow: 4,
      }),
    })
    const targetSnapshot = Object.freeze({
      ...fixture.before,
      transcript: targetTranscript,
    })
    const diagnostics = {
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
      projectionRecordUpdates: 0,
      projectionRecordNodeVisits: 0,
      projectionRecordNodesCopied: 0,
      blockPlanUpdates: 0,
      blockPlanNodeVisits: 0,
      blockPlanNodesCopied: 0,
      changedItemBuilds: 0,
    }
    const runtime = new TranscriptRuntime(
      runtimeInput(fixture, targetSnapshot, "detached", {
        canonicalDamage: { kind: "full" },
      }),
      {
        windowPolicy: { viewportRows: 24, overscanRows: 24 },
        diagnostics,
      },
    )
    const targetBlock = runtime
      .getSnapshot()
      .window.blocks.find(
        (block) => block.key.kind === "item" && block.key.itemId === target,
      )!
    runtime.reportMeasurements({
      ...runtime.measurementBase(),
      measurements: [
        {
          key: {
            blockKey: blockKey(targetBlock),
            contentRevision: targetBlock.contentRevision,
            width: 80,
            styleRevision: "fold-path",
            folded: false,
          },
          nativeRevision: 1,
          rows: 8,
          points: point,
          lines,
        },
      ],
    })
    const detachedTranscript = Object.freeze({
      ...targetTranscript,
      cursor: anchor,
      viewport: Object.freeze({
        kind: "point" as const,
        point: anchor,
        preferredScreenRow: 4,
      }),
    })
    const detached = Object.freeze({
      ...fixture.before,
      transcript: detachedTranscript,
    })
    runtime.update(
      runtimeInput(fixture, detached, "detached", {
        presentationDamage: { kind: "view" },
      }),
    )
    const before = runtime.getSnapshot(),
      beforeDiagnostics = { ...diagnostics }
    expect(pointIsMaterialized(before.window.blocks, targetPoint)).toBe(false)
    const foldedTranscript = Object.freeze({
      ...detachedTranscript,
      folded: setTranscriptFoldValue(detachedTranscript.folded, target, true),
      cursor: targetPoint,
      viewport: Object.freeze({
        kind: "point" as const,
        point: targetPoint,
        preferredScreenRow: 4,
      }),
    })
    const folded = Object.freeze({ ...detached, transcript: foldedTranscript })
    let publications = 0
    runtime.subscribe(() => {
      publications++
    })
    const after = runtime.update(
      runtimeInput(fixture, folded, "detached", {
        presentationDamage: { kind: "folds", itemIds: [target] },
        reveal: { id: blockCount, point: targetPoint, reason: "url" },
      }),
    )
    expect(publications).toBe(1)
    expect(after.blocks).toBe(before.blocks)
    expect(after.transcript.folded[target]).toBe(true)
    expect(pointIsMaterialized(after.window.blocks, targetPoint)).toBe(true)
    expect(after.geometry.totalRows).toBe(before.geometry.totalRows - 7)
    expect(after.window.blocks.length).toBeLessThanOrEqual(72)
    expect(after.geometry.blockRows.length).toBeLessThanOrEqual(72)
    expect(
      diagnostics.heightIndexBuilds - beforeDiagnostics.heightIndexBuilds,
    ).toBe(0)
    expect(
      diagnostics.heightIndexBlockVisits -
        beforeDiagnostics.heightIndexBlockVisits,
    ).toBe(0)
    expect(
      diagnostics.heightIndexUpdates - beforeDiagnostics.heightIndexUpdates,
    ).toBe(1)
    expect(
      diagnostics.heightIndexNodeVisits -
        beforeDiagnostics.heightIndexNodeVisits,
    ).toBeLessThanOrEqual(Math.ceil(Math.log2(blockCount)) + 1)
    expect(
      diagnostics.heightIndexNodesCopied -
        beforeDiagnostics.heightIndexNodesCopied,
    ).toBeGreaterThan(0)
    expect(
      diagnostics.heightIndexNodesCopied -
        beforeDiagnostics.heightIndexNodesCopied,
    ).toBe(
      diagnostics.heightIndexNodeVisits -
        beforeDiagnostics.heightIndexNodeVisits,
    )
    expect(
      diagnostics.completeGeometryBlockVisits -
        beforeDiagnostics.completeGeometryBlockVisits,
    ).toBe(0)
    expect(
      diagnostics.windowGeometryBlockVisits -
        beforeDiagnostics.windowGeometryBlockVisits,
    ).toBeLessThanOrEqual(144)
    runtime.dispose()
  },
  30_000,
)

test.each([...transcriptScalingBlockCounts])(
  "fragmented command fold and expansion splice one item at %i exact render blocks",
  (blockCount) => {
    const oversized = buildOversizedTranscriptFixtures().find(
      (candidate) => candidate.shape === "command-output",
    )!
    const point = Object.freeze({
      itemId: oversized.item.id,
      graphemeOffset: 0,
    })
    const withCompletedCommand = (
      fixture: ReturnType<typeof buildTranscriptStructuralScalingFixture>,
    ) => {
      const counters = createConversationReductionDiagnostics()
      const started = reduceConversationWithDiagnostics(
        fixture.before.conversation,
        {
          type: "turn.started",
          threadId: fixture.threadId,
          turnId: oversized.item.turnId,
        },
        counters,
      )
      const withItem = reduceConversationWithDiagnostics(
        started,
        {
          type: "item.started",
          threadId: fixture.threadId,
          item: oversized.item,
        },
        counters,
      )
      const conversation = reduceConversationWithDiagnostics(
        withItem,
        {
          type: "turn.completed",
          threadId: fixture.threadId,
          turnId: oversized.item.turnId,
          outcome: "complete",
          durationMs: 1,
        },
        counters,
      )
      const transcript = Object.freeze({
        ...syncTranscriptItem(fixture.before.transcript, oversized.item),
        cursor: point,
        viewport: Object.freeze({
          kind: "point" as const,
          point,
          preferredScreenRow: 4,
        }),
      })
      return Object.freeze({
        canonicalRevision: fixture.before.canonicalRevision + 3,
        conversation,
        transcript,
      })
    }
    const seedFixture = buildTranscriptStructuralScalingFixture(1)
    const seed = withCompletedCommand(seedFixture)
    const appendedBlockCount =
      createTranscriptFrame(
        runtimeInput(seedFixture, seed, "detached", {
          canonicalDamage: { kind: "full" },
        }),
      ).blocks.length - 1
    const fixture = buildTranscriptStructuralScalingFixture(
      blockCount - appendedBlockCount,
    )
    const snapshot = withCompletedCommand(fixture)
    const transcript = snapshot.transcript
    const diagnostics = scalingRuntimeDiagnostics()
    const runtime = new TranscriptRuntime(
      runtimeInput(fixture, snapshot, "detached", {
        canonicalDamage: { kind: "full" },
      }),
      {
        windowPolicy: { viewportRows: 24, overscanRows: 24 },
        diagnostics,
      },
    )
    const expanded = runtime.getSnapshot()
    expect(expanded.blocks.length).toBe(blockCount)
    const expandedKeys = expanded.blocks.map(blockKey)
    const priorCounters = { ...diagnostics }
    let publications = 0
    runtime.subscribe(() => publications++)
    for (const folded of [true, false, true]) {
      const nextTranscript = Object.freeze({
        ...transcript,
        folded: setTranscriptFoldValue(
          transcript.folded,
          oversized.item.id,
          folded,
        ),
      })
      const nextSnapshot = Object.freeze({
        ...snapshot,
        transcript: nextTranscript,
      })
      const after = runtime.update(
        runtimeInput(fixture, nextSnapshot, "detached", {
          presentationDamage: {
            kind: "folds",
            itemIds: [oversized.item.id],
          },
        }),
      )
      const reference = createTranscriptFrame(
        runtimeInput(fixture, nextSnapshot, "detached", {
          canonicalDamage: { kind: "full" },
        }),
      )
      expect(after.blocks.map(blockKey)).toEqual(reference.blocks.map(blockKey))
      expect(after.transcript.folded[oversized.item.id]).toBe(folded)
      expect(after.window.blocks.length).toBeLessThanOrEqual(48)
      expect(after.geometry.blockRows.length).toBeLessThanOrEqual(48)
      expect(pointIsMaterialized(after.window.blocks, point)).toBe(true)
      if (!folded) expect(after.blocks.map(blockKey)).toEqual(expandedKeys)
      expect(diagnostics.completePlanBuilds).toBe(
        priorCounters.completePlanBuilds,
      )
      expect(diagnostics.heightIndexBuilds).toBe(
        priorCounters.heightIndexBuilds,
      )
      expect(diagnostics.completeGeometryBlockVisits).toBe(
        priorCounters.completeGeometryBlockVisits,
      )
    }
    expect(publications).toBe(3)
    expect(expanded.blocks.map(blockKey)).toEqual(expandedKeys)
    expect(diagnostics.blockPlanUpdates - priorCounters.blockPlanUpdates).toBe(
      3,
    )
    runtime.dispose()
  },
  60_000,
)

test("mixed command, Markdown, and multi-file edit folds retain exact render plans", () => {
  const fixture = buildTranscriptNavigationFixture({ blockCount: 100 })
  const source = fixture.before
  const expanded = buildTranscriptBlocks(source)
  const kinds = ["command", "assistant", "edit"] as const
  for (const kind of kinds) {
    const target = source.transcript.order.find((itemId) => {
      if (source.conversation.items[itemId]?.kind !== kind) return false
      return (
        expanded.filter(
          (block) => block.key.kind === "item" && block.key.itemId === itemId,
        ).length > 1
      )
    })!
    expect(target).toBeDefined()
    const cursor = Object.freeze({ itemId: target, graphemeOffset: 0 })
    const transcript = Object.freeze({
      ...source.transcript,
      cursor,
      viewport: Object.freeze({
        kind: "point" as const,
        point: cursor,
        preferredScreenRow: 5,
      }),
    })
    const snapshot = Object.freeze({ ...source, transcript })
    const diagnostics = scalingRuntimeDiagnostics()
    const runtime = new TranscriptRuntime(
      runtimeInput(fixture, snapshot, "detached", {
        canonicalDamage: { kind: "full" },
      }),
      {
        windowPolicy: { viewportRows: 24, overscanRows: 24 },
        diagnostics,
      },
    )
    const baseline = { ...diagnostics }
    for (const folded of [true, false]) {
      const nextTranscript = Object.freeze({
        ...transcript,
        folded: setTranscriptFoldValue(transcript.folded, target, folded),
      })
      const nextSnapshot = Object.freeze({
        ...snapshot,
        transcript: nextTranscript,
      })
      const actual = runtime.update(
        runtimeInput(fixture, nextSnapshot, "detached", {
          presentationDamage: { kind: "folds", itemIds: [target] },
        }),
      )
      const reference = createTranscriptFrame(
        runtimeInput(fixture, nextSnapshot, "detached", {
          canonicalDamage: { kind: "full" },
        }),
      )
      expect(actual.blocks.map(blockKey)).toEqual(
        reference.blocks.map(blockKey),
      )
      expect(
        actual.blocks
          .filter(
            (block) => block.key.kind === "item" && block.key.itemId === target,
          )
          .map((block) =>
            "projection" in block ? block.sourceSpan : undefined,
          ),
      ).toEqual(
        reference.blocks
          .filter(
            (block) => block.key.kind === "item" && block.key.itemId === target,
          )
          .map((block) =>
            "projection" in block ? block.sourceSpan : undefined,
          ),
      )
      expect(pointIsMaterialized(actual.window.blocks, cursor)).toBe(true)
      expect(diagnostics.completePlanBuilds).toBe(baseline.completePlanBuilds)
      expect(diagnostics.heightIndexBuilds).toBe(baseline.heightIndexBuilds)
    }
    if (kind === "command") {
      const later = source.transcript.order
        .slice(source.transcript.order.indexOf(target) + 1)
        .find(
          (itemId) =>
            source.conversation.items[itemId]?.kind === "user" &&
            expanded.filter(
              (block) =>
                block.key.kind === "item" && block.key.itemId === itemId,
            ).length === 1,
        )!
      expect(later).toBeDefined()
      const laterTranscript = Object.freeze({
        ...transcript,
        folded: setTranscriptFoldValue(transcript.folded, later, true),
      })
      const laterSnapshot = Object.freeze({
        ...snapshot,
        transcript: laterTranscript,
      })
      const after = runtime.update(
        runtimeInput(fixture, laterSnapshot, "detached", {
          presentationDamage: { kind: "folds", itemIds: [later] },
        }),
      )
      expect(after.blocks.map(blockKey)).toEqual(
        createTranscriptFrame(
          runtimeInput(fixture, laterSnapshot, "detached", {
            canonicalDamage: { kind: "full" },
          }),
        ).blocks.map(blockKey),
      )
      expect(diagnostics.completePlanBuilds).toBe(baseline.completePlanBuilds)
      expect(diagnostics.heightIndexBuilds).toBe(baseline.heightIndexBuilds)
    }
    runtime.dispose()
  }
})

test("a fragmented historical fold keeps following tail stream updates incremental", () => {
  const fixture = buildTranscriptNavigationFixture({ blockCount: 100 })
  const snapshot = fixture.before
  const plan = buildTranscriptBlocks(snapshot)
  const target = snapshot.transcript.order.find(
    (itemId) =>
      snapshot.conversation.items[itemId]?.kind === "command" &&
      plan.filter(
        (block) => block.key.kind === "item" && block.key.itemId === itemId,
      ).length > 1,
  )!
  expect(target).toBeDefined()
  const diagnostics = scalingRuntimeDiagnostics()
  const runtime = new TranscriptRuntime(
    runtimeInput(fixture, snapshot, "follow", {
      canonicalDamage: { kind: "full" },
    }),
    {
      windowPolicy: { viewportRows: 24, overscanRows: 24 },
      diagnostics,
    },
  )
  const foldedTranscript = Object.freeze({
    ...snapshot.transcript,
    folded: setTranscriptFoldValue(snapshot.transcript.folded, target, true),
  })
  const folded = Object.freeze({ ...snapshot, transcript: foldedTranscript })
  const before = runtime.update(
    runtimeInput(fixture, folded, "follow", {
      presentationDamage: { kind: "folds", itemIds: [target] },
    }),
  )
  const baseline = { ...diagnostics }
  const conversation = reduceConversationWithDiagnostics(
    snapshot.conversation,
    {
      type: "item.delta",
      threadId: fixture.threadId,
      itemId: fixture.tailItemId,
      delta: " Additional streamed tail output.",
    },
    createConversationReductionDiagnostics(),
  )
  const transcript = syncTranscriptItem(
    foldedTranscript,
    conversation.items[fixture.tailItemId]!,
  )
  const latest = Object.freeze({
    canonicalRevision: snapshot.canonicalRevision + 1,
    conversation,
    transcript,
  })
  const after = runtime.update(
    runtimeInput(fixture, latest, "follow", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
    }),
  )
  expect(after.displayedCanonicalRevision).toBe(latest.canonicalRevision)
  expect(after.blocks.length).toBe(before.blocks.length)
  expect(after.blocks.at(-1)).not.toBe(before.blocks.at(-1))
  expect(after.transcript.folded[target]).toBe(true)
  expect(diagnostics.completePlanBuilds).toBe(baseline.completePlanBuilds)
  expect(diagnostics.heightIndexBuilds).toBe(baseline.heightIndexBuilds)
  expect(after.blocks.map(blockKey)).toEqual(
    createTranscriptFrame(
      runtimeInput(fixture, latest, "follow", {
        canonicalDamage: { kind: "full" },
      }),
    ).blocks.map(blockKey),
  )
  runtime.dispose()
})
