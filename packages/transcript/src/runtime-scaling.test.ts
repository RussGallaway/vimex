import { expect, test } from "bun:test"
import { forkBoundary, type ConversationState } from "@vimex/conversation"
import { appendTranscriptScalingTail, buildTranscriptScalingFixture, transcriptScalingBlockCounts, type TranscriptFixtureSnapshot } from "@vimex/testkit"
import { findSearchMatches } from "./application/transcript-search"
import { selectedGraphemeCount, selectedText, urlAt } from "./application/transcript-operations"
import { referenceText, urlCandidates } from "./application/transcript-navigation"
import { setTranscriptFoldValue, type TranscriptState } from "./domain/transcript-document"
import type { BlockGeometry } from "./geometry"
import { TranscriptRuntime, type TranscriptFrame, type TranscriptRuntimeInput } from "./runtime"
import { blockKey, buildTranscriptBlocks, passThroughWindow, pointIsMaterialized } from "./window"

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

const point = Object.freeze({ 0: Object.freeze({ graphemeOffset: 0, x: 0, y: 0, row: 0, column: 0 }) })
const offsets = Object.freeze({ 0: Object.freeze([0]) })
const line = Object.freeze({ from: 0, to: 0, row: 0 })
const lines = Object.freeze([line])
const lineByRow = Object.freeze({ 0: line })

function measurements(frame: TranscriptFrame): readonly BlockGeometry[] {
  return frame.blocks.map(block => Object.freeze({
    key: Object.freeze({ blockKey: blockKey(block), contentRevision: block.contentRevision, width: 80, styleRevision: "scaling-test", folded: block.key.kind === "item" && Boolean(frame.transcript.folded[block.key.itemId]) }),
    nativeRevision: 1,
    rows: 1,
    pointCount: 1,
    points: point,
    pointOffsetsByRow: offsets,
    lines,
    lineByRow,
  }))
}

function semanticEvidence(transcript: TranscriptState, conversation: ConversationState) {
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
    searchMatches: findSearchMatches(transcript, transcript.search?.query ?? ""),
    urls,
    firstUrlAtPoint: urls[0] ? urlAt(transcript, urls[0].from) : undefined,
    marks: transcript.marks,
    jumps: transcript.jumps,
    foldedItems: Object.entries(transcript.folded).filter(([, folded]) => folded).map(([itemId]) => ({
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

function expectPassThroughEquivalent(frame: TranscriptFrame, snapshot: TranscriptFixtureSnapshot): void {
  const reference = passThroughOracle(snapshot)
  expect(frame.blocks.map(blockKey)).toEqual(reference.blockKeys)
  expect(semanticEvidence(frame.transcript, snapshot.conversation)).toEqual(reference.semantics)
}

test("identical scaling workloads retain pass-through semantics and deterministic publication counts", () => {
  for (const blockCount of transcriptScalingBlockCounts) {
    const fixture = buildTranscriptScalingFixture(blockCount)
    const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", { canonicalDamage: { kind: "full" } }))
    runtime.reportMeasurements({ ...runtime.measurementBase(), measurements: measurements(runtime.getSnapshot()) })
    const initial = runtime.getSnapshot()
    expect(initial.blocks).toHaveLength(blockCount)
    expect(initial.window.blocks).toBe(initial.blocks)
    expect(initial.geometry.measuredBlockCount).toBe(blockCount)

    let publications = 0
    runtime.subscribe(() => { publications++ })
    const followed = runtime.update(runtimeInput(fixture, fixture.afterTailDelta, "follow", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
    }))
    expect(publications).toBe(1)
    let preservedBlocks = 0, preservedGeometry = 0
    const changedKeys: string[] = []
    for (let index = 0; index < blockCount; index++) {
      const key = blockKey(followed.blocks[index]!)
      if (followed.blocks[index] === initial.blocks[index]) preservedBlocks++
      else changedKeys.push(key)
      if (followed.geometry.byBlockKey[key] === initial.geometry.byBlockKey[key]) preservedGeometry++
    }
    expect(preservedBlocks).toBe(blockCount - 1)
    expect(preservedGeometry).toBe(blockCount - 1)
    expect(changedKeys).toEqual([`item:${fixture.tailItemId}:root`])
    expect(followed.blocks.at(-1)).not.toBe(initial.blocks.at(-1))
    expect(blockKey(followed.blocks.at(-1)!)).toBe(`item:${fixture.tailItemId}:root`)
    expect(followed.window.blocks).toBe(followed.blocks)
    expect(followed.geometry.measuredBlockCount).toBe(blockCount - 1)
    expectPassThroughEquivalent(followed, fixture.afterTailDelta)

    const navigatedTranscript = Object.freeze({
      ...fixture.afterTailDelta.transcript,
      cursor: Object.freeze({ itemId: fixture.targets.quarter, graphemeOffset: 0 }),
      viewport: Object.freeze({ kind: "point" as const, point: Object.freeze({ itemId: fixture.targets.quarter, graphemeOffset: 0 }), preferredScreenRow: 7 }),
    })
    const navigatedSnapshot = Object.freeze({ ...fixture.afterTailDelta, transcript: navigatedTranscript })
    const navigated = runtime.update(runtimeInput(fixture, navigatedSnapshot, "follow", { presentationDamage: { kind: "view" } }))
    expect(publications).toBe(2)
    expectPassThroughEquivalent(navigated, navigatedSnapshot)

    runtime.update(runtimeInput(fixture, navigatedSnapshot, "detached"))
    expect(publications).toBe(3)
    const pinned = runtime.getSnapshot()
    expectPassThroughEquivalent(pinned, navigatedSnapshot)
    const hidden = appendTranscriptScalingTail(navigatedSnapshot, fixture.tailItemId, fixture.tailDelta)
    expect(runtime.update(runtimeInput(fixture, hidden, "detached", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
    }))).toBe(pinned)
    expect(publications).toBe(3)

    const hiddenTail = hidden.transcript.projectionById[fixture.tailItemId]!
    const revealPoint = Object.freeze({ itemId: fixture.tailItemId, graphemeOffset: hiddenTail.sourceSpans.length })
    const revealedTranscript = Object.freeze({
      ...hidden.transcript,
      cursor: revealPoint,
      viewport: Object.freeze({ kind: "point" as const, point: revealPoint, preferredScreenRow: 7 }),
    })
    const revealedSnapshot = Object.freeze({ ...hidden, transcript: revealedTranscript })
    const revealed = runtime.update(runtimeInput(fixture, revealedSnapshot, "detached", {
      reveal: { id: blockCount, point: revealPoint, reason: "jump" },
    }))
    expect(publications).toBe(4)
    expect(revealed.displayedCanonicalRevision).toBe(hidden.canonicalRevision)
    expect(revealed.mode).toBe("detached")
    expect(revealed.transcript.cursor).toEqual(revealPoint)
    expect(revealed.transcript.viewport).toEqual({ kind: "point", point: revealPoint, preferredScreenRow: 7 })
    expectPassThroughEquivalent(revealed, revealedSnapshot)

    const latest = appendTranscriptScalingTail(revealedSnapshot, fixture.tailItemId, fixture.tailDelta)
    expect(runtime.update(runtimeInput(fixture, latest, "detached", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
    }))).toBe(revealed)
    expect(publications).toBe(4)
    const reattached = runtime.update(runtimeInput(fixture, latest, "follow"))
    expect(publications).toBe(5)
    expect(reattached.displayedCanonicalRevision).toBe(latest.canonicalRevision)
    expectPassThroughEquivalent(reattached, latest)
    runtime.dispose()
  }
}, 15_000)

test("production window policy bounds initial, detached, reveal, and measured materialization at every scale", () => {
  const policy = Object.freeze({ viewportRows: 24, overscanRows: 24 })
  for (const blockCount of transcriptScalingBlockCounts) {
    const fixture = buildTranscriptScalingFixture(blockCount)
    const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", { canonicalDamage: { kind: "full" } }), { windowPolicy: policy })
    const initial = runtime.getSnapshot()
    expect(initial.blocks).toHaveLength(blockCount)
    expect(initial.window.blocks).toHaveLength(48)
    expect(initial.window.bottomSpacerRows).toBe(0)
    expect(initial.window.topSpacerRows).toBe(blockCount - 48)
    expect(initial.window.blocks.every((block, index) => block === initial.blocks[blockCount - 48 + index])).toBe(true)
    expectPassThroughEquivalent(initial, fixture.before)

    let publications = 0
    runtime.subscribe(() => { publications++ })
    expect(runtime.setWindowViewport(24, 24)).toBe(initial)
    expect(publications).toBe(0)
    const narrower = runtime.setWindowViewport(12, 12)
    expect(publications).toBe(1)
    expect(narrower.window.blocks).toHaveLength(24)
    expect(narrower.window.bottomSpacerRows).toBe(0)

    const offWindow = narrower.blocks[0]!
    const staleNative: BlockGeometry = {
      key: { blockKey: blockKey(offWindow), contentRevision: offWindow.contentRevision, width: 80, styleRevision: "scaling-test", folded: false },
      nativeRevision: 1,
      rows: 1,
      points: point,
      lines,
    }
    expect(runtime.reportMeasurements({ ...runtime.measurementBase(), measurements: [staleNative] })).toBe(narrower)
    expect(publications).toBe(1)

    const detachedPoint = Object.freeze({ itemId: fixture.targets.quarter, graphemeOffset: 0 })
    const detachedTranscript = Object.freeze({
      ...fixture.before.transcript,
      cursor: detachedPoint,
      viewport: Object.freeze({ kind: "point" as const, point: detachedPoint, preferredScreenRow: 5 }),
    })
    const detachedSnapshot = Object.freeze({ ...fixture.before, transcript: detachedTranscript })
    const runtimeDiagnostics = {
      completePlanBuilds: 0, completePlanBlockVisits: 0,
      orderIndexBuilds: 0, orderIndexItemVisits: 0, orderIndexCacheHits: 0,
      textLengthIndexBuilds: 0, textLengthItemVisits: 0, textLengthIndexCacheHits: 0,
      textLengthIndexUpdates: 0, textLengthNodeVisits: 0,
      urlIndexBuilds: 0, urlIndexItemVisits: 0, urlIndexCacheHits: 0,
      urlIndexUpdates: 0, urlIndexNodeVisits: 0,
      heightIndexBuilds: 0, heightIndexBlockVisits: 0, heightIndexUpdates: 0, heightIndexNodeVisits: 0, heightIndexNodesCopied: 0,
      completeGeometryBlockVisits: 0, windowGeometryBlockVisits: 0, blockPlanWindowSliceItems: 0,
      projectionRecordUpdates: 0, projectionRecordNodeVisits: 0, projectionRecordNodesCopied: 0,
      blockPlanUpdates: 0, blockPlanNodeVisits: 0, blockPlanNodesCopied: 0, changedItemBuilds: 0,
    }
    const detached = new TranscriptRuntime(runtimeInput(fixture, detachedSnapshot, "detached", { canonicalDamage: { kind: "full" } }), {
      windowPolicy: policy,
      diagnostics: runtimeDiagnostics,
    })
    const pinned = detached.getSnapshot()
    expect(pinned.blocks).toHaveLength(blockCount)
    expect(pinned.window.blocks.length).toBeLessThanOrEqual(72)
    expect(pointIsMaterialized(pinned.window.blocks, detachedPoint)).toBe(true)
    expect(pinned.window.topSpacerRows + pinned.window.blocks.length + pinned.window.bottomSpacerRows).toBe(blockCount)

    const hidden = appendTranscriptScalingTail(detachedSnapshot, fixture.tailItemId, fixture.tailDelta)
    expect(detached.update(runtimeInput(fixture, hidden, "detached", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
    }))).toBe(pinned)
    const diagnosticsBeforeReveal = { ...runtimeDiagnostics }
    const tailPoint = Object.freeze({ itemId: fixture.targets.tail, graphemeOffset: 0 })
    const revealedTranscript = Object.freeze({
      ...hidden.transcript,
      cursor: tailPoint,
      viewport: Object.freeze({ kind: "point" as const, point: tailPoint, preferredScreenRow: 5 }),
    })
    const revealedSnapshot = Object.freeze({ ...hidden, transcript: revealedTranscript })
    let revealPublications = 0
    detached.subscribe(() => { revealPublications++ })
    const revealed = detached.update(runtimeInput(fixture, revealedSnapshot, "detached", {
      reveal: { id: blockCount, point: tailPoint, reason: "jump" },
      presentationDamage: { kind: "view" },
    }))
    expect(revealed.window.blocks.length).toBeLessThanOrEqual(72)
    expect(pointIsMaterialized(revealed.window.blocks, tailPoint)).toBe(true)
    expect(revealed.blocks).toBe(pinned.blocks)
    expect(revealed.displayedCanonicalRevision).toBe(pinned.displayedCanonicalRevision)
    expect(revealPublications).toBe(1)
    expect(runtimeDiagnostics.completePlanBuilds - diagnosticsBeforeReveal.completePlanBuilds).toBe(0)
    expect(runtimeDiagnostics.completePlanBlockVisits - diagnosticsBeforeReveal.completePlanBlockVisits).toBe(0)
    expect(runtimeDiagnostics.orderIndexBuilds - diagnosticsBeforeReveal.orderIndexBuilds).toBe(0)
    expect(runtimeDiagnostics.orderIndexItemVisits - diagnosticsBeforeReveal.orderIndexItemVisits).toBe(0)
    runtime.dispose()
    detached.dispose()
  }
}, 15_000)

test("accepted height correction is atomic, window-local, immutable, and bounded at every scale", () => {
  for (const blockCount of transcriptScalingBlockCounts) {
    const fixture = buildTranscriptScalingFixture(blockCount)
    const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", {
      canonicalDamage: { kind: "full" },
    }), { windowPolicy: { viewportRows: 24, overscanRows: 24 } })
    const before = runtime.getSnapshot()
    const block = before.window.blocks.at(-1)!
    const key = blockKey(block)
    const base = runtime.measurementBase(before)
    let publications = 0
    runtime.subscribe(() => { publications++ })
    const corrected = runtime.reportMeasurements({ ...base, measurements: [Object.freeze({
      key: Object.freeze({
        blockKey: key,
        contentRevision: block.contentRevision,
        width: 80,
        styleRevision: "correction-scaling",
        folded: block.key.kind === "item" && Boolean(before.transcript.folded[block.key.itemId]),
      }),
      nativeRevision: 1,
      rows: 4,
      pointCount: 1,
      points: point,
      pointOffsetsByRow: offsets,
      lines,
      lineByRow,
    })] })

    expect(publications).toBe(1)
    expect(corrected).not.toBe(before)
    expect(before.geometry.totalRows).toBe(blockCount)
    expect(before.geometry.byBlockKey[key]).toBeUndefined()
    expect(corrected.geometry.totalRows).toBe(blockCount + 3)
    expect(corrected.geometry.blockRows).toHaveLength(corrected.window.blocks.length)
    expect(Object.keys(corrected.geometry.byBlockKey).length).toBeLessThanOrEqual(corrected.window.blocks.length)
    expect(corrected.window.blocks.length).toBeLessThanOrEqual(48)
    expect(corrected.blocks).toBe(before.blocks)
    expect(corrected.transcript).toBe(before.transcript)
    expect(runtime.reportMeasurements({ ...base, measurements: [] })).toBe(corrected)
    expect(runtime.reportMeasurements({ ...base, measurements: [Object.freeze({
      ...corrected.geometry.byBlockKey[key]!,
      nativeRevision: 2,
    })] })).toBe(corrected)
    expect(publications).toBe(1)

    const reset = runtime.resetLayout("width")
    expect(publications).toBe(2)
    expect(reset.geometry.measuredBlockCount).toBe(0)
    expect(reset.geometry.totalRows).toBe(blockCount)
    expect(reset.window.blocks.length).toBe(48)
    runtime.dispose()
  }
})

test("incremental runtime projection updates preserve the warm selection-length index at every scale", () => {
  for (const blockCount of transcriptScalingBlockCounts) {
    const fixture = buildTranscriptScalingFixture(blockCount)
    const diagnostics = {
      completePlanBuilds: 0, completePlanBlockVisits: 0,
      orderIndexBuilds: 0, orderIndexItemVisits: 0, orderIndexCacheHits: 0,
      textLengthIndexBuilds: 0, textLengthItemVisits: 0, textLengthIndexCacheHits: 0,
      textLengthIndexUpdates: 0, textLengthNodeVisits: 0,
      urlIndexBuilds: 0, urlIndexItemVisits: 0, urlIndexCacheHits: 0,
      urlIndexUpdates: 0, urlIndexNodeVisits: 0,
      heightIndexBuilds: 0, heightIndexBlockVisits: 0, heightIndexUpdates: 0, heightIndexNodeVisits: 0, heightIndexNodesCopied: 0,
      completeGeometryBlockVisits: 0, windowGeometryBlockVisits: 0, blockPlanWindowSliceItems: 0,
      projectionRecordUpdates: 0, projectionRecordNodeVisits: 0, projectionRecordNodesCopied: 0,
      blockPlanUpdates: 0, blockPlanNodeVisits: 0, blockPlanNodesCopied: 0, changedItemBuilds: 0,
    }
    const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", { canonicalDamage: { kind: "full" } }), {
      windowPolicy: { viewportRows: 24, overscanRows: 24 },
      diagnostics,
    })
    const before = selectedGraphemeCount(runtime.getSnapshot().transcript)
    const beforeUpdate = { ...diagnostics }
    const followed = runtime.update(runtimeInput(fixture, fixture.afterTailDelta, "follow", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
    }))
    expect(diagnostics.changedItemBuilds - beforeUpdate.changedItemBuilds).toBe(1)
    expect(diagnostics.completePlanBuilds - beforeUpdate.completePlanBuilds).toBe(0)
    expect(diagnostics.completePlanBlockVisits - beforeUpdate.completePlanBlockVisits).toBe(0)
    expect(diagnostics.projectionRecordUpdates - beforeUpdate.projectionRecordUpdates).toBe(1)
    expect(diagnostics.projectionRecordNodeVisits - beforeUpdate.projectionRecordNodeVisits).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(blockCount + 1)) + 1)
    expect(diagnostics.projectionRecordNodesCopied - beforeUpdate.projectionRecordNodesCopied)
      .toBe(diagnostics.projectionRecordNodeVisits - beforeUpdate.projectionRecordNodeVisits)
    expect(diagnostics.blockPlanUpdates - beforeUpdate.blockPlanUpdates).toBe(1)
    expect(diagnostics.blockPlanNodeVisits - beforeUpdate.blockPlanNodeVisits).toBeLessThanOrEqual(2 * (Math.ceil(Math.log2(blockCount)) + 1))
    expect(diagnostics.blockPlanNodesCopied - beforeUpdate.blockPlanNodesCopied).toBeGreaterThan(0)
    expect(diagnostics.blockPlanNodesCopied - beforeUpdate.blockPlanNodesCopied).toBeLessThanOrEqual(Math.ceil(Math.log2(blockCount)) + 1)
    expect(diagnostics.heightIndexBuilds - beforeUpdate.heightIndexBuilds).toBe(0)
    expect(diagnostics.heightIndexBlockVisits - beforeUpdate.heightIndexBlockVisits).toBe(0)
    expect(diagnostics.heightIndexUpdates - beforeUpdate.heightIndexUpdates).toBe(1)
    expect(diagnostics.heightIndexNodeVisits - beforeUpdate.heightIndexNodeVisits).toBeLessThanOrEqual(Math.ceil(Math.log2(blockCount)) + 1)
    expect(diagnostics.completeGeometryBlockVisits - beforeUpdate.completeGeometryBlockVisits).toBe(0)
    expect(diagnostics.windowGeometryBlockVisits - beforeUpdate.windowGeometryBlockVisits).toBeLessThanOrEqual(48)
    expect(diagnostics.blockPlanWindowSliceItems - beforeUpdate.blockPlanWindowSliceItems).toBeLessThanOrEqual(48)
    expect(diagnostics.textLengthIndexBuilds - beforeUpdate.textLengthIndexBuilds).toBe(0)
    expect(diagnostics.textLengthItemVisits - beforeUpdate.textLengthItemVisits).toBe(0)
    expect(diagnostics.textLengthIndexUpdates - beforeUpdate.textLengthIndexUpdates).toBe(1)
    const beforeQuery = { ...diagnostics }
    expect(selectedGraphemeCount(followed.transcript, diagnostics)).toBe(before)
    expect(diagnostics.textLengthIndexBuilds - beforeQuery.textLengthIndexBuilds).toBe(0)
    expect(diagnostics.textLengthItemVisits - beforeQuery.textLengthItemVisits).toBe(0)
    expect(diagnostics.textLengthIndexCacheHits - beforeQuery.textLengthIndexCacheHits).toBe(1)
    expect(diagnostics.textLengthNodeVisits - beforeQuery.textLengthNodeVisits).toBeLessThan(64)
    runtime.dispose()
  }
})

test("hidden same-item output reattaches once with bounded reconciliation at every scale", () => {
  for (const blockCount of transcriptScalingBlockCounts) {
    const fixture = buildTranscriptScalingFixture(blockCount)
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
    const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", { canonicalDamage: { kind: "full" } }), {
      windowPolicy: { viewportRows: 24, overscanRows: 24 }, diagnostics,
    })
    const anchor = Object.freeze({ itemId: fixture.targets.quarter, graphemeOffset: 0 })
    const detachedTranscript = Object.freeze({
      ...fixture.before.transcript,
      cursor: anchor,
      viewport: Object.freeze({ kind: "point" as const, point: anchor, preferredScreenRow: 5 }),
    })
    const detachedSnapshot = Object.freeze({ ...fixture.before, transcript: detachedTranscript })
    runtime.update(runtimeInput(fixture, detachedSnapshot, "detached", { presentationDamage: { kind: "view" } }))
    const pinned = runtime.getSnapshot()
    const staleBase = runtime.measurementBase(pinned)
    const hidden = appendTranscriptScalingTail(detachedSnapshot, fixture.tailItemId, fixture.tailDelta)
    expect(runtime.update(runtimeInput(fixture, hidden, "detached", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
    }))).toBe(pinned)
    const latestTranscript = Object.freeze({
      ...hidden.transcript,
      viewport: Object.freeze({ kind: "tail" as const }),
      unseenEntries: 0,
      unseenItemIds: Object.freeze([]),
    })
    const latest = Object.freeze({ ...hidden, transcript: latestTranscript })
    const before = { ...diagnostics }
    let publications = 0
    const unsubscribe = runtime.subscribe(() => { publications++ })
    const reattached = runtime.update(runtimeInput(fixture, latest, "follow", { presentationDamage: { kind: "view" } }))
    unsubscribe()

    expect(publications).toBe(1)
    expect(reattached.mode).toBe("follow")
    expect(reattached.displayedCanonicalRevision).toBe(latest.canonicalRevision)
    expect(reattached.window.bottomSpacerRows).toBe(0)
    expect(reattached.window.blocks.length).toBeLessThanOrEqual(48)
    expectPassThroughEquivalent(reattached, latest)
    expect(diagnostics.completePlanBuilds - before.completePlanBuilds).toBe(0)
    expect(diagnostics.completePlanBlockVisits - before.completePlanBlockVisits).toBe(0)
    expect(diagnostics.heightIndexBuilds - before.heightIndexBuilds).toBe(0)
    expect(diagnostics.heightIndexBlockVisits - before.heightIndexBlockVisits).toBe(0)
    expect(diagnostics.heightIndexUpdates - before.heightIndexUpdates).toBe(1)
    expect(diagnostics.heightIndexNodeVisits - before.heightIndexNodeVisits).toBeLessThanOrEqual(Math.ceil(Math.log2(blockCount)) + 1)
    expect(diagnostics.blockPlanUpdates - before.blockPlanUpdates).toBe(1)
    expect(diagnostics.blockPlanNodeVisits - before.blockPlanNodeVisits).toBeLessThanOrEqual(2 * (Math.ceil(Math.log2(blockCount)) + 1))
    expect(diagnostics.completeGeometryBlockVisits - before.completeGeometryBlockVisits).toBe(0)
    expect(diagnostics.windowGeometryBlockVisits - before.windowGeometryBlockVisits).toBeLessThanOrEqual(48)
    expect(diagnostics.blockPlanWindowSliceItems - before.blockPlanWindowSliceItems).toBeLessThanOrEqual(48)

    const staleBlock = pinned.window.blocks[0]!
    expect(runtime.reportMeasurements({ ...staleBase, measurements: [{
      key: { blockKey: blockKey(staleBlock), contentRevision: staleBlock.contentRevision, width: 80, styleRevision: "stale-reattach", folded: false },
      nativeRevision: 1, rows: 2, points: point, lines,
    }] })).toBe(reattached)
    runtime.dispose()
  }
}, 15_000)

test("an equal-height native revision publishes once and its acknowledgement is a no-op", () => {
  const fixture = buildTranscriptScalingFixture(100)
  const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", {
    canonicalDamage: { kind: "full" },
  }), { windowPolicy: { viewportRows: 12, overscanRows: 12 } })
  const before = runtime.getSnapshot()
  const block = before.window.blocks.at(-1)!
  const geometry = Object.freeze({
    key: Object.freeze({
      blockKey: blockKey(block),
      contentRevision: block.contentRevision,
      width: 80,
      styleRevision: "equal-height-reflow",
      folded: block.key.kind === "item" && Boolean(before.transcript.folded[block.key.itemId]),
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
  runtime.subscribe(() => { publications++ })

  const accepted = runtime.reportMeasurements({ ...runtime.measurementBase(before), measurements: [geometry] })
  expect(accepted).not.toBe(before)
  expect(accepted.geometry.totalRows).toBe(before.geometry.totalRows)
  expect(accepted.geometry.byBlockKey[geometry.key.blockKey]?.nativeRevision).toBe(1)
  expect(publications).toBe(1)

  expect(runtime.reportMeasurements({ ...runtime.measurementBase(accepted), measurements: [geometry] })).toBe(accepted)
  expect(publications).toBe(1)
  runtime.dispose()
})

test("detached correction replans from the measured row inside the logical anchor block", () => {
  const fixture = buildTranscriptScalingFixture(100)
  const projection = fixture.before.transcript.projectionById[fixture.targets.middle]!
  const anchor = Object.freeze({
    itemId: fixture.targets.middle,
    graphemeOffset: Math.min(5, projection.sourceSpans.length),
  })
  const transcript = Object.freeze({
    ...fixture.before.transcript,
    cursor: anchor,
    viewport: Object.freeze({ kind: "point" as const, point: anchor, preferredScreenRow: 2 }),
  })
  const snapshot = Object.freeze({ ...fixture.before, transcript })
  const runtime = new TranscriptRuntime(runtimeInput(fixture, snapshot, "detached", {
    canonicalDamage: { kind: "full" },
  }), { windowPolicy: { viewportRows: 8, overscanRows: 8 } })
  const before = runtime.getSnapshot()
  const block = before.window.blocks.find(candidate => candidate.key.kind === "item" && candidate.key.itemId === anchor.itemId)!
  const key = blockKey(block)
  const corrected = runtime.reportMeasurements({ ...runtime.measurementBase(before), measurements: [Object.freeze({
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
      [anchor.graphemeOffset]: Object.freeze({ graphemeOffset: anchor.graphemeOffset, x: 0, y: 6, row: 6, column: 0 }),
    }),
    lines: Object.freeze([{ from: anchor.graphemeOffset, to: anchor.graphemeOffset, row: 6 }]),
  })] })

  expect(corrected.transcript.viewport).toEqual(before.transcript.viewport)
  expect(corrected.window.topSpacerRows).toBeGreaterThan(before.window.topSpacerRows)
  expect(pointIsMaterialized(corrected.window.blocks, anchor)).toBe(true)
  expect(corrected.geometry.rowByBlockKey[key]! + 6 - 2 - 8).toBe(corrected.window.topSpacerRows)
  expect(corrected.geometry.byBlockKey[key]?.points[anchor.graphemeOffset]?.row).toBe(6)
  expect(before.window.topSpacerRows).toBeLessThan(corrected.window.topSpacerRows)
  runtime.dispose()
})

test("a mixed invalid windowed batch cannot leak a staged height replacement", () => {
  const fixture = buildTranscriptScalingFixture(100)
  const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", {
    canonicalDamage: { kind: "full" },
  }), { windowPolicy: { viewportRows: 8, overscanRows: 8 } })
  const before = runtime.getSnapshot()
  const [first, second] = before.window.blocks.slice(-2)
  const geometry = (block: typeof first, rows: number, contentRevision = block!.contentRevision): BlockGeometry => ({
    key: {
      blockKey: blockKey(block!),
      contentRevision,
      width: 80,
      styleRevision: "atomic-correction",
      folded: block!.key.kind === "item" && Boolean(before.transcript.folded[block!.key.itemId]),
    },
    nativeRevision: 1,
    rows,
    points: point,
    lines,
  })
  const base = runtime.measurementBase(before)
  expect(runtime.reportMeasurements({ ...base, measurements: [
    geometry(first, 7),
    geometry(second, 3, second!.contentRevision + 1),
  ] })).toBe(before)
  const accepted = runtime.reportMeasurements({ ...base, measurements: [geometry(first, 2)] })
  expect(accepted.geometry.totalRows).toBe(101)
  expect(before.geometry.totalRows).toBe(100)
  runtime.dispose()
})

test("a fold transition discards the incompatible measured height before replanning", () => {
  const fixture = buildTranscriptScalingFixture(100)
  const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", {
    canonicalDamage: { kind: "full" },
  }), { windowPolicy: { viewportRows: 12, overscanRows: 12 } })
  const before = runtime.getSnapshot()
  const block = before.window.blocks.find(candidate => candidate.key.kind === "item"
    && !before.transcript.folded[candidate.key.itemId])!
  expect(block).toBeDefined()
  const key = blockKey(block)
  const measured = runtime.reportMeasurements({ ...runtime.measurementBase(before), measurements: [{
    key: { blockKey: key, contentRevision: block.contentRevision, width: 80, styleRevision: "fold-height", folded: false },
    nativeRevision: 1,
    rows: 8,
    points: point,
    lines,
  }] })
  expect(measured.geometry.totalRows).toBe(107)

  const foldedTranscript = Object.freeze({
    ...fixture.before.transcript,
    folded: Object.freeze({ ...fixture.before.transcript.folded, [block.key.kind === "item" ? block.key.itemId : ""]: true }),
  })
  const foldedSnapshot = Object.freeze({ ...fixture.before, transcript: foldedTranscript })
  const folded = runtime.update(runtimeInput(fixture, foldedSnapshot, "follow", {
    presentationDamage: { kind: "view" },
  }))
  expect(folded.geometry.totalRows).toBe(100)
  expect(folded.geometry.byBlockKey[key]).toBeUndefined()
  runtime.dispose()
})

test("single off-window folds update logarithmic height paths and bounded geometry at every scale", () => {
  for (const blockCount of transcriptScalingBlockCounts) {
    const fixture = buildTranscriptScalingFixture(blockCount)
    const anchor = { itemId: fixture.targets.quarter, graphemeOffset: 0 }
    const target = fixture.targets.threeQuarter
    const targetPoint = { itemId: target, graphemeOffset: 0 }
    const targetTranscript = Object.freeze({
      ...fixture.before.transcript,
      folded: setTranscriptFoldValue(fixture.before.transcript.folded, target, false),
      cursor: targetPoint,
      viewport: Object.freeze({ kind: "point" as const, point: targetPoint, preferredScreenRow: 4 }),
    })
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
    const targetBlock = runtime.getSnapshot().window.blocks.find(block => block.key.kind === "item" && block.key.itemId === target)!
    runtime.reportMeasurements({ ...runtime.measurementBase(), measurements: [{
      key: { blockKey: blockKey(targetBlock), contentRevision: targetBlock.contentRevision, width: 80, styleRevision: "fold-path", folded: false },
      nativeRevision: 1, rows: 8, points: point, lines,
    }] })
    const detachedTranscript = Object.freeze({
      ...targetTranscript,
      cursor: anchor,
      viewport: Object.freeze({ kind: "point" as const, point: anchor, preferredScreenRow: 4 }),
    })
    const detached = Object.freeze({ ...fixture.before, transcript: detachedTranscript })
    runtime.update(runtimeInput(fixture, detached, "detached", { presentationDamage: { kind: "view" } }))
    const before = runtime.getSnapshot(), beforeDiagnostics = { ...diagnostics }
    expect(pointIsMaterialized(before.window.blocks, targetPoint)).toBe(false)
    const foldedTranscript = Object.freeze({
      ...detachedTranscript,
      folded: setTranscriptFoldValue(detachedTranscript.folded, target, true),
      cursor: targetPoint,
      viewport: Object.freeze({ kind: "point" as const, point: targetPoint, preferredScreenRow: 4 }),
    })
    const folded = Object.freeze({ ...detached, transcript: foldedTranscript })
    let publications = 0
    runtime.subscribe(() => { publications++ })
    const after = runtime.update(runtimeInput(fixture, folded, "detached", {
      presentationDamage: { kind: "folds", itemIds: [target] },
      reveal: { id: blockCount, point: targetPoint, reason: "url" },
    }))
    expect(publications).toBe(1)
    expect(after.blocks).toBe(before.blocks)
    expect(after.transcript.folded[target]).toBe(true)
    expect(pointIsMaterialized(after.window.blocks, targetPoint)).toBe(true)
    expect(after.geometry.totalRows).toBe(before.geometry.totalRows - 7)
    expect(after.window.blocks.length).toBeLessThanOrEqual(72)
    expect(after.geometry.blockRows.length).toBeLessThanOrEqual(72)
    expect(diagnostics.heightIndexBuilds - beforeDiagnostics.heightIndexBuilds).toBe(0)
    expect(diagnostics.heightIndexBlockVisits - beforeDiagnostics.heightIndexBlockVisits).toBe(0)
    expect(diagnostics.heightIndexUpdates - beforeDiagnostics.heightIndexUpdates).toBe(1)
    expect(diagnostics.heightIndexNodeVisits - beforeDiagnostics.heightIndexNodeVisits).toBeLessThanOrEqual(Math.ceil(Math.log2(blockCount)) + 1)
    expect(diagnostics.heightIndexNodesCopied - beforeDiagnostics.heightIndexNodesCopied).toBeGreaterThan(0)
    expect(diagnostics.heightIndexNodesCopied - beforeDiagnostics.heightIndexNodesCopied)
      .toBe(diagnostics.heightIndexNodeVisits - beforeDiagnostics.heightIndexNodeVisits)
    expect(diagnostics.completeGeometryBlockVisits - beforeDiagnostics.completeGeometryBlockVisits).toBe(0)
    expect(diagnostics.windowGeometryBlockVisits - beforeDiagnostics.windowGeometryBlockVisits).toBeLessThanOrEqual(144)
    runtime.dispose()
  }
})
