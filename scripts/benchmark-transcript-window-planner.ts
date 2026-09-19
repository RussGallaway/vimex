// Diagnostic Stage 5.1 pure-planner benchmark. Fixture and block-plan setup is
// excluded so each timing names one renderer-neutral index or planning boundary.
import assert from "node:assert/strict"
import { itemId, turnId, type ItemId } from "@vimex/conversation"
import { buildTranscriptScalingFixture, transcriptScalingBlockCounts } from "@vimex/testkit"
import {
  blockKey,
  buildTranscriptBlocks,
  createHeightIndex,
  passThroughWindow,
  planTranscriptWindow,
  pointIsMaterialized,
  type BlockHeightOverride,
  type HeightIndexDiagnostics,
  type PlanTranscriptWindowInput,
  type TranscriptBlock,
  type TranscriptHeightIndex,
  type TranscriptItemBlock,
  type TranscriptWindow,
  type TranscriptWindowDiagnostics,
} from "@vimex/transcript"

const fixtureVersion = "transcript-scaling-v1"
const viewportRows = 24
const overscanRows = viewportRows

interface Timed<Value> {
  readonly value: Value
  readonly milliseconds: number
}

function timed<Value>(operation: () => Value): Timed<Value> {
  const started = performance.now()
  const value = operation()
  return Object.freeze({ value, milliseconds: Number((performance.now() - started).toFixed(6)) })
}

function diagnostics(): HeightIndexDiagnostics {
  return { nodeVisits: 0, nodesCopied: 0 }
}

function windowDiagnostics(): TranscriptWindowDiagnostics {
  return { targetLookupVisits: 0 }
}

function stableSubBlockFixture(blockCount: number) {
  const id = itemId(`planner-sub-block-item-${blockCount}`)
  const itemTurn = turnId(`planner-sub-block-turn-${blockCount}`)
  const source = "x".repeat(blockCount)
  const projection = Object.freeze({
    plain: source,
    source,
    sourceSpans: Object.freeze(Array.from({ length: blockCount }, (_, index) => Object.freeze({ from: index, to: index + 1 }))),
    links: Object.freeze([]),
    revision: 1,
  })
  const item = Object.freeze({ id, turnId: itemTurn, kind: "assistant" as const, markdown: source, status: "complete" as const })
  const blocks: readonly TranscriptBlock[] = Object.freeze(Array.from({ length: blockCount }, (_, index): TranscriptItemBlock => Object.freeze({
    key: Object.freeze({ kind: "item" as const, itemId: id, blockId: `segment:${index}` }),
    turnId: itemTurn,
    item,
    renderItem: item,
    projection,
    sourceSpan: Object.freeze({ from: index, to: index + 1 }),
    contentRevision: 1,
    estimatedRows: 1,
    followedByActivity: false,
  })))
  return Object.freeze({
    blocks,
    itemId: id,
    target: Object.freeze({ itemId: id, graphemeOffset: Math.floor((blockCount - 1) * 0.75) }),
  })
}

/** Collect index-tree work performed by a planner call without changing policy. */
function observingIndex(index: TranscriptHeightIndex, counters: HeightIndexDiagnostics): TranscriptHeightIndex {
  return Object.freeze({
    blockCount: index.blockCount,
    totalRows: index.totalRows,
    prefixRows: (blockIndex: number, explicit?: HeightIndexDiagnostics) => index.prefixRows(blockIndex, explicit ?? counters),
    blockAtRow: (row: number, explicit?: HeightIndexDiagnostics) => index.blockAtRow(row, explicit ?? counters),
    rowRange: (from: number, to: number, explicit?: HeightIndexDiagnostics) => index.rowRange(from, to, explicit ?? counters),
    blockIndex: (key: string) => index.blockIndex(key),
    itemBlockIndexes: (id: ItemId) => index.itemBlockIndexes(id),
    replaceHeight: (override: BlockHeightOverride, explicit?: HeightIndexDiagnostics) => index.replaceHeight(override, explicit ?? counters),
    replaceBlock: (blocks: readonly TranscriptBlock[], previous: TranscriptBlock, next: TranscriptBlock, rows: number,
      explicit?: HeightIndexDiagnostics) => index.replaceBlock(blocks, previous, next, rows, explicit ?? counters),
    supports: (blocks: readonly TranscriptBlock[]) => index.supports(blocks),
  })
}

function plan(
  blocks: readonly TranscriptBlock[],
  heights: TranscriptHeightIndex,
  counters: HeightIndexDiagnostics,
  input: Omit<PlanTranscriptWindowInput, "blocks" | "heights" | "viewportRows" | "overscanRows">,
): TranscriptWindow {
  return planTranscriptWindow({
    blocks,
    heights: observingIndex(heights, counters),
    viewportRows,
    overscanRows,
    ...input,
  })
}

function windowFacts(
  blocks: readonly TranscriptBlock[],
  heights: TranscriptHeightIndex,
  window: TranscriptWindow,
  counters: HeightIndexDiagnostics,
  targetCounters: TranscriptWindowDiagnostics = { targetLookupVisits: 0 },
) {
  assert(window.blocks.length > 0, "a nonempty scaling fixture must produce a nonempty planned window")
  const firstIndex = heights.blockIndex(blockKey(window.blocks[0]!))
  assert(firstIndex !== undefined, "planned first block is absent from the height index")
  const range = heights.rowRange(firstIndex, firstIndex + window.blocks.length)
  assert(range, "planned block range is absent from the height index")
  let retainedBlockIdentities = 0
  for (let offset = 0; offset < window.blocks.length; offset++) {
    if (window.blocks[offset] === blocks[firstIndex + offset]) retainedBlockIdentities++
  }
  assert.equal(retainedBlockIdentities, window.blocks.length)
  assert.equal(window.topSpacerRows, range.start)
  assert.equal(window.bottomSpacerRows, heights.totalRows - range.end)
  assert.equal(window.topSpacerRows + range.rows + window.bottomSpacerRows, heights.totalRows)
  return Object.freeze({
    mountedBlocks: window.blocks.length,
    measuredBlocks: 0,
    changedBlocks: 0,
    publications: 0,
    mountedRows: range.rows,
    topSpacerRows: window.topSpacerRows,
    bottomSpacerRows: window.bottomSpacerRows,
    retainedBlockIdentities,
    nodeVisits: counters.nodeVisits,
    nodesCopied: counters.nodesCopied,
    targetLookupVisits: targetCounters.targetLookupVisits,
    passThroughFallback: window.blocks === blocks,
  })
}

for (const blockCount of transcriptScalingBlockCounts) {
  const fixture = buildTranscriptScalingFixture(blockCount)
  const blocks = buildTranscriptBlocks(fixture.before)
  assert.equal(blocks.length, blockCount)
  Bun.gc(true)

  const built = timed(() => createHeightIndex(blocks))
  const heights = built.value
  assert(heights, "deterministic fixture unexpectedly produced duplicate stable block keys")
  assert.equal(heights.blockCount, blockCount)
  assert.equal(heights.totalRows, blockCount)
  assert(heights.supports(blocks))
  const treeDepthBound = Math.ceil(Math.log2(blockCount)) + 1

  const followDiagnostics = diagnostics()
  const followed = timed(() => plan(blocks, heights, followDiagnostics, { attachment: { kind: "tail" } }))
  const followFacts = windowFacts(blocks, heights, followed.value, followDiagnostics)
  assert.equal(followFacts.passThroughFallback, false)
  assert(followFacts.mountedBlocks <= viewportRows + overscanRows)
  assert(followFacts.nodeVisits <= treeDepthBound * 3)
  assert.equal(followFacts.nodesCopied, 0)
  assert(pointIsMaterialized(followed.value.blocks, { itemId: fixture.targets.tail, graphemeOffset: 0 }))

  const detachedDiagnostics = diagnostics()
  const detachedTargetDiagnostics = windowDiagnostics()
  const detached = timed(() => plan(blocks, heights, detachedDiagnostics, {
    attachment: { kind: "point", point: { itemId: fixture.targets.middle, graphemeOffset: 0 }, preferredScreenRow: 7 },
    diagnostics: detachedTargetDiagnostics,
  }))
  const detachedFacts = windowFacts(blocks, heights, detached.value, detachedDiagnostics, detachedTargetDiagnostics)
  assert.equal(detachedFacts.passThroughFallback, false)
  assert(detachedFacts.mountedBlocks <= viewportRows + overscanRows * 2)
  assert(detachedFacts.nodeVisits <= treeDepthBound * 7)
  assert.equal(detachedFacts.nodesCopied, 0)
  assert(pointIsMaterialized(detached.value.blocks, { itemId: fixture.targets.middle, graphemeOffset: 0 }))

  const revealPoint = Object.freeze({ itemId: fixture.targets.tail, graphemeOffset: 0 })
  const revealDiagnostics = diagnostics()
  const revealTargetDiagnostics = windowDiagnostics()
  const revealed = timed(() => plan(blocks, heights, revealDiagnostics, {
    attachment: { kind: "point", point: { itemId: fixture.targets.quarter, graphemeOffset: 0 }, preferredScreenRow: 7 },
    reveal: revealPoint,
    diagnostics: revealTargetDiagnostics,
  }))
  const revealFacts = windowFacts(blocks, heights, revealed.value, revealDiagnostics, revealTargetDiagnostics)
  assert.equal(revealFacts.passThroughFallback, false)
  assert(revealFacts.mountedBlocks <= viewportRows + overscanRows * 2)
  assert(revealFacts.nodeVisits <= treeDepthBound * 5)
  assert.equal(revealFacts.nodesCopied, 0)
  assert(pointIsMaterialized(revealed.value.blocks, revealPoint))

  const replacementIndex = heights.blockIndex(blockKey(blocks[Math.floor(blocks.length / 2)]!))
  assert(replacementIndex !== undefined)
  const replacementBlock = blocks[replacementIndex]!
  const existingRange = heights.rowRange(replacementIndex, replacementIndex + 1)
  assert(existingRange)

  const noOpDiagnostics = diagnostics()
  const noOp = timed(() => heights.replaceHeight({
    blockKey: blockKey(replacementBlock),
    contentRevision: replacementBlock.contentRevision,
    rows: existingRange.rows,
  }, noOpDiagnostics))
  assert.equal(noOp.value, heights)
  assert.equal(noOpDiagnostics.nodesCopied, 0)
  assert(noOpDiagnostics.nodeVisits <= treeDepthBound)

  const replacementDiagnostics = diagnostics()
  const replacementTargetDiagnostics = windowDiagnostics()
  const replacement = timed(() => {
    const updated = heights.replaceHeight({
      blockKey: blockKey(replacementBlock),
      contentRevision: replacementBlock.contentRevision,
      rows: existingRange.rows + 3,
    }, replacementDiagnostics)
    assert.notEqual(updated, heights)
    assert(updated.supports(blocks))
    assert.equal(updated.totalRows, heights.totalRows + 3)
    const window = plan(blocks, updated, replacementDiagnostics, {
      attachment: { kind: "point", point: { itemId: fixture.targets.middle, graphemeOffset: 0 }, preferredScreenRow: 7 },
      diagnostics: replacementTargetDiagnostics,
    })
    return Object.freeze({ updated, window })
  })
  const replacementFacts = windowFacts(blocks, replacement.value.updated, replacement.value.window, replacementDiagnostics, replacementTargetDiagnostics)
  assert.equal(replacementFacts.passThroughFallback, false)
  assert(replacementDiagnostics.nodeVisits <= treeDepthBound * 8)
  assert(replacementDiagnostics.nodesCopied <= treeDepthBound)
  assert(pointIsMaterialized(replacement.value.window.blocks, { itemId: fixture.targets.middle, graphemeOffset: 0 }))
  assert.equal(heights.totalRows, blockCount, "persistent height replacement mutated the prior index")

  const subBlocks = stableSubBlockFixture(blockCount)
  Bun.gc(true)
  const subBlockBuilt = timed(() => createHeightIndex(subBlocks.blocks))
  const subBlockHeights = subBlockBuilt.value
  assert(subBlockHeights, "stable same-item sub-blocks unexpectedly failed height indexing")
  assert.equal(subBlockHeights.itemBlockIndexes(subBlocks.itemId)?.length, blockCount)
  const subBlockHeightDiagnostics = diagnostics()
  const subBlockTargetDiagnostics = windowDiagnostics()
  const subBlockPlan = timed(() => plan(subBlocks.blocks, subBlockHeights, subBlockHeightDiagnostics, {
    attachment: { kind: "point", point: subBlocks.target, preferredScreenRow: 7 },
    diagnostics: subBlockTargetDiagnostics,
  }))
  const subBlockFacts = windowFacts(
    subBlocks.blocks,
    subBlockHeights,
    subBlockPlan.value,
    subBlockHeightDiagnostics,
    subBlockTargetDiagnostics,
  )
  assert.equal(subBlockFacts.passThroughFallback, false)
  assert(subBlockFacts.mountedBlocks <= viewportRows + overscanRows * 2)
  assert(pointIsMaterialized(subBlockPlan.value.blocks, subBlocks.target))
  assert(subBlockTargetDiagnostics.targetLookupVisits <= treeDepthBound + 3)

  const unrelatedBlocks = Object.freeze(blocks.slice(0, -1))
  const fallback = planTranscriptWindow({
    blocks: unrelatedBlocks,
    heights,
    viewportRows,
    overscanRows,
    attachment: { kind: "tail" },
  })
  const oracle = passThroughWindow(unrelatedBlocks)
  assert.equal(fallback.blocks, unrelatedBlocks)
  assert.deepEqual(fallback, oracle)

  console.log(JSON.stringify({
    benchmark: "transcript-window-planner",
    fixtureVersion,
    scenario: "pure-height-index-and-window-planner",
    blockCount,
    policy: { viewportRows, overscanRows },
    timingsMs: {
      fullIndexBuild: built.milliseconds,
      followPlan: followed.milliseconds,
      detachedPlan: detached.milliseconds,
      farRevealPlan: revealed.milliseconds,
      noOpHeightUpdate: noOp.milliseconds,
      oneHeightReplacementAndReplan: replacement.milliseconds,
      sameItemSubBlockIndexBuild: subBlockBuilt.milliseconds,
      sameItemSubBlockTargetPlan: subBlockPlan.milliseconds,
    },
    operationCounts: {
      indexBuild: { inputBlocks: blocks.length, indexedBlocks: heights.blockCount, totalRows: heights.totalRows },
      follow: followFacts,
      detached: detachedFacts,
      farReveal: revealFacts,
      noOpHeightUpdate: {
        mountedBlocks: 0, measuredBlocks: 0, changedBlocks: 0, publications: 0,
        nodeVisits: noOpDiagnostics.nodeVisits, nodesCopied: noOpDiagnostics.nodesCopied, retainedIndexIdentity: noOp.value === heights,
      },
      oneHeightReplacementAndReplan: {
        ...replacementFacts,
        changedHeights: 1,
        priorTotalRows: heights.totalRows,
        nextTotalRows: replacement.value.updated.totalRows,
        priorIndexUnchanged: heights.totalRows === blockCount,
      },
      sameItemSubBlockTarget: {
        ...subBlockFacts,
        indexedItemBlocks: subBlockHeights.itemBlockIndexes(subBlocks.itemId)?.length,
        logarithmicTargetVisitBound: treeDepthBound + 3,
      },
    },
    fallback: {
      unsupportedRelationshipUsesPassThrough: fallback.blocks === unrelatedBlocks,
      preservesInputBlockArrayIdentity: fallback.blocks === oracle.blocks,
      mountedBlocks: fallback.blocks.length,
      topSpacerRows: fallback.topSpacerRows,
      bottomSpacerRows: fallback.bottomSpacerRows,
      overscanRows: fallback.overscanRows,
    },
    samples: { warmup: 0, measured: 1 },
  }))
}
