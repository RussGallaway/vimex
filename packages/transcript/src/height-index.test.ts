import { expect, test } from "bun:test"
import { itemId, turnId, type TurnId } from "@vimex/conversation"
import {
  createHeightIndex,
  type BlockHeightOverride,
  type HeightIndexDiagnostics,
} from "./height-index"
import {
  appendTranscriptBlock,
  blockKey,
  persistentTranscriptBlockPlan,
  replaceTranscriptBlock,
  spliceTranscriptItemBlocks,
  transcriptPointBlockIndex,
  type TranscriptBlock,
  type TranscriptItemBlock,
  type TranscriptTurnActivityBlock,
} from "./window"

function block(
  index: number,
  rows: number,
  id: TurnId = turnId(`height-${index}`),
): TranscriptTurnActivityBlock {
  return Object.freeze({
    key: Object.freeze({ kind: "turn-activity" as const, turnId: id }),
    turn: Object.freeze({
      id,
      status: "complete" as const,
      itemIds: Object.freeze([]),
    }),
    contentRevision: index + 1,
    estimatedRows: rows,
  })
}

function itemFragments(
  root: TranscriptItemBlock,
): readonly TranscriptItemBlock[] {
  return Object.freeze(
    [0, 1, 2].map((part) =>
      Object.freeze({
        ...root,
        key: Object.freeze({ ...root.key, blockId: `part:${part}` }),
        sourceSpan: Object.freeze({ from: part * 2, to: part * 2 + 2 }),
        estimatedRows: part + 1,
      }),
    ),
  )
}

function blocks(count: number): readonly TranscriptBlock[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) => block(index, (index % 5) + 1)),
  )
}

function diagnostics(): HeightIndexDiagnostics {
  return { nodeVisits: 0, nodesCopied: 0 }
}

function item(name: string, source = "abcd"): TranscriptItemBlock {
  const id = itemId(name)
  const projection = Object.freeze({
    plain: source,
    source,
    sourceSpans: Object.freeze(
      [...source].map((_, index) =>
        Object.freeze({ from: index, to: index + 1 }),
      ),
    ),
    links: Object.freeze([]),
    revision: 1,
  })
  const value = Object.freeze({
    id,
    turnId: turnId("height-items"),
    kind: "assistant" as const,
    markdown: source,
    status: "complete" as const,
  })
  return Object.freeze({
    key: Object.freeze({ kind: "item" as const, itemId: id, blockId: "root" }),
    turnId: value.turnId,
    item: value,
    renderItem: value,
    projection,
    sourceSpan: Object.freeze({ from: 0, to: source.length }),
    contentRevision: 1,
    estimatedRows: 1,
    followedByActivity: false,
  })
}

test("height index validates overrides and answers half-open prefix, row, and range queries", () => {
  const plan = Object.freeze([
    block(0, 2),
    block(1, 1),
    block(2, 4),
    block(3, 3),
  ])
  const secondKey = blockKey(plan[1]!)
  const overrides: readonly BlockHeightOverride[] = Object.freeze([
    Object.freeze({
      blockKey: secondKey,
      contentRevision: plan[1]!.contentRevision - 1,
      rows: 99,
    }),
    Object.freeze({ blockKey: "missing", contentRevision: 1, rows: 99 }),
    Object.freeze({
      blockKey: secondKey,
      contentRevision: plan[1]!.contentRevision,
      rows: 0,
    }),
    Object.freeze({
      blockKey: secondKey,
      contentRevision: plan[1]!.contentRevision,
      rows: 5,
    }),
  ])
  const index = createHeightIndex(plan, overrides)!

  expect(index.blockCount).toBe(4)
  expect(index.totalRows).toBe(14)
  expect([0, 1, 2, 3, 4].map((value) => index.prefixRows(value))).toEqual([
    0, 2, 7, 11, 14,
  ])
  expect(Number.isNaN(index.prefixRows(-1))).toBe(true)
  expect(Number.isNaN(index.prefixRows(1.5))).toBe(true)
  expect(Number.isNaN(index.prefixRows(5))).toBe(true)
  expect(
    [0, 1, 2, 6, 7, 10, 11, 13].map((row) => index.blockAtRow(row)),
  ).toEqual([0, 0, 1, 1, 2, 2, 3, 3])
  expect(index.blockAtRow(-1)).toBeUndefined()
  expect(index.blockAtRow(1.5)).toBeUndefined()
  expect(index.blockAtRow(14)).toBeUndefined()
  expect(index.rowRange(1, 3)).toEqual({ start: 2, end: 11, rows: 9 })
  expect(index.rowRange(2, 2)).toEqual({ start: 7, end: 7, rows: 0 })
  expect(index.rowRange(-1, 2)).toBeUndefined()
  expect(index.rowRange(3, 2)).toBeUndefined()
  expect(index.rowRange(0, 5)).toBeUndefined()
  expect(index.blockIndex(blockKey(plan[0]!))).toBe(0)
  expect(index.blockIndex(secondKey)).toBe(1)
  expect(index.blockIndex("missing")).toBeUndefined()
  expect(index.supports(plan)).toBe(true)
  expect(index.supports(Object.freeze([...plan]))).toBe(false)
  expect(
    index.supports(
      Object.freeze(
        plan.map((entry, position) =>
          position === 1
            ? Object.freeze({
                ...entry,
                contentRevision: entry.contentRevision + 1,
              })
            : entry,
        ),
      ),
    ),
  ).toBe(false)
  expect(index.supports(Object.freeze([...plan].reverse()))).toBe(false)
})

test("height replacement path-copies logarithmically while old snapshots and no-op identity remain stable", () => {
  const plan = blocks(100)
  const original = createHeightIndex(plan)!
  const target = plan[51]!
  const key = blockKey(target)
  const beforeTarget = original.prefixRows(51)!
  const oldRows = original.prefixRows(52)! - beforeTarget
  const updateDiagnostics = diagnostics()
  const updated = original.replaceHeight(
    {
      blockKey: key,
      contentRevision: target.contentRevision,
      rows: oldRows + 7,
    },
    updateDiagnostics,
  )

  expect(updated).not.toBe(original)
  expect(original.totalRows).toBe(300)
  expect(updated.totalRows).toBe(original.totalRows + 7)
  expect(original.prefixRows(51)).toBe(beforeTarget)
  expect(updated.prefixRows(51)).toBe(beforeTarget)
  expect(updated.prefixRows(52)).toBe(original.prefixRows(52)! + 7)
  expect(updateDiagnostics.nodeVisits).toBe(updateDiagnostics.nodesCopied)
  expect(updateDiagnostics.nodesCopied).toBeLessThanOrEqual(
    Math.ceil(Math.log2(plan.length)) + 1,
  )

  const noOpDiagnostics = diagnostics()
  expect(
    updated.replaceHeight(
      {
        blockKey: key,
        contentRevision: target.contentRevision,
        rows: oldRows + 7,
      },
      noOpDiagnostics,
    ),
  ).toBe(updated)
  expect(noOpDiagnostics.nodesCopied).toBe(0)
  expect(noOpDiagnostics.nodeVisits).toBeLessThanOrEqual(
    Math.ceil(Math.log2(plan.length)) + 1,
  )
  expect(
    updated.replaceHeight({
      blockKey: key,
      contentRevision: target.contentRevision + 1,
      rows: 20,
    }),
  ).toBe(updated)
  expect(
    updated.replaceHeight({
      blockKey: key,
      contentRevision: target.contentRevision,
      rows: -1,
    }),
  ).toBe(updated)
  expect(
    updated.replaceHeight({
      blockKey: "missing",
      contentRevision: target.contentRevision,
      rows: 20,
    }),
  ).toBe(updated)
})

test("block replacement requires exact one-root persistent-plan lineage", () => {
  const dense = Object.freeze([
    item("lineage-a"),
    item("lineage-b"),
    item("lineage-c"),
  ])
  const before = persistentTranscriptBlockPlan(dense)
  const index = createHeightIndex(before)!
  const previous = before[1]!
  const next = Object.freeze({
    ...previous,
    contentRevision: previous.contentRevision + 1,
  })
  const after = replaceTranscriptBlock(before, 1, previous, next)!
  const rebound = index.replaceBlock(after, previous, next, next.estimatedRows)
  expect(rebound?.supports(after)).toBe(true)

  const unrelated = persistentTranscriptBlockPlan(
    Object.freeze([before[0]!, next, before[2]!]),
  )
  expect(
    index.replaceBlock(unrelated, previous, next, next.estimatedRows),
  ).toBeUndefined()
  const reordered = persistentTranscriptBlockPlan(
    Object.freeze([before[2]!, next, before[0]!]),
  )
  expect(
    index.replaceBlock(reordered, previous, next, next.estimatedRows),
  ).toBeUndefined()
  const wrongPrior = before[0]!
  expect(
    index.replaceBlock(after, wrongPrior, next, next.estimatedRows),
  ).toBeUndefined()

  const split = item("lineage-split", "ab")
  const first = Object.freeze({
    ...split,
    key: Object.freeze({ ...split.key, blockId: "part:0" }),
    sourceSpan: Object.freeze({ from: 0, to: 1 }),
  })
  const second = Object.freeze({
    ...split,
    key: Object.freeze({ ...split.key, blockId: "part:1" }),
    sourceSpan: Object.freeze({ from: 1, to: 2 }),
  })
  const splitBefore = persistentTranscriptBlockPlan(
    Object.freeze([first, second]),
  )
  const splitNext = Object.freeze({
    ...first,
    contentRevision: first.contentRevision + 1,
  })
  const splitAfter = replaceTranscriptBlock(splitBefore, 0, first, splitNext)!
  expect(
    createHeightIndex(splitBefore)?.replaceBlock(
      splitAfter,
      first,
      splitNext,
      1,
    ),
  ).toBeUndefined()
})

test("zero-height activity overrides retain ordinals and skip hidden rows", () => {
  const plan = Object.freeze([
    block(0, 2),
    block(1, 1),
    block(2, 1),
    block(3, 3),
  ])
  const index = createHeightIndex(
    plan,
    plan.slice(1, 3).map((value) => ({
      blockKey: blockKey(value),
      contentRevision: value.contentRevision,
      rows: 0,
    })),
  )!
  expect(index.totalRows).toBe(5)
  expect(index.blockAtRow(1)).toBe(0)
  expect(index.blockAtRow(2)).toBe(3)
  expect(index.rowRange(1, 3)).toEqual({ start: 2, end: 2, rows: 0 })
  const restored = index.replaceHeight({
    blockKey: blockKey(plan[1]!),
    contentRevision: plan[1]!.contentRevision,
    rows: 1,
  })
  expect(restored.blockAtRow(2)).toBe(1)
  expect(restored.blockAtRow(3)).toBe(3)
  expect(index.totalRows).toBe(5)
})

test("duplicate block keys reject indexed planning and invalid estimates remain safe", () => {
  const duplicateId = turnId("duplicate")
  expect(
    createHeightIndex(
      Object.freeze([block(0, 1, duplicateId), block(1, 2, duplicateId)]),
    ),
  ).toBeUndefined()
  expect(
    createHeightIndex(
      Object.freeze([block(0, Number.MAX_SAFE_INTEGER), block(1, 1)]),
    ),
  ).toBeUndefined()

  const invalid = Object.freeze([
    block(0, 0),
    block(1, Number.NaN),
    block(2, Number.POSITIVE_INFINITY),
    block(3, 2.5),
  ])
  const index = createHeightIndex(
    invalid,
    Object.freeze([
      Object.freeze({
        blockKey: blockKey(invalid[0]!),
        contentRevision: invalid[0]!.contentRevision,
        rows: -1,
      }),
    ]),
  )!
  expect(index.totalRows).toBe(4)
  expect(index.rowRange(0, 4)).toEqual({ start: 0, end: 4, rows: 4 })

  const empty = createHeightIndex(Object.freeze([]))!
  expect(empty.blockCount).toBe(0)
  expect(empty.totalRows).toBe(0)
  expect(empty.prefixRows(0)).toBe(0)
  expect(empty.blockAtRow(0)).toBeUndefined()
  expect(empty.rowRange(0, 0)).toEqual({ start: 0, end: 0, rows: 0 })
})

test("item lookup indexes roots and ordered sub-blocks while rejecting ambiguous span plans", () => {
  const root = item("root")
  const rootPlan = Object.freeze([root, block(1, 1)])
  const rootIndex = createHeightIndex(rootPlan)!
  expect(rootIndex.itemBlockIndexes(root.key.itemId)).toEqual([0])
  expect(Object.isFrozen(rootIndex.itemBlockIndexes(root.key.itemId))).toBe(
    true,
  )
  expect(rootIndex.itemBlockIndexes(itemId("missing"))).toBeUndefined()

  const split = item("split")
  const prefix = Object.freeze({
    ...split,
    key: Object.freeze({ ...split.key, blockId: "part:0" }),
    sourceSpan: Object.freeze({ from: 0, to: 2 }),
  })
  const suffix = Object.freeze({
    ...split,
    key: Object.freeze({ ...split.key, blockId: "part:1" }),
    sourceSpan: Object.freeze({ from: 2, to: 4 }),
  })
  const splitPlan = Object.freeze([prefix, block(2, 1), suffix])
  const splitIndex = createHeightIndex(splitPlan)!
  expect(splitIndex.itemBlockIndexes(split.key.itemId)).toEqual([0, 2])

  const overlapping = Object.freeze([
    prefix,
    Object.freeze({ ...suffix, sourceSpan: Object.freeze({ from: 1, to: 4 }) }),
  ])
  const nonmonotonic = Object.freeze([suffix, prefix])
  expect(
    createHeightIndex(overlapping)?.itemBlockIndexes(split.key.itemId),
  ).toBeUndefined()
  expect(
    createHeightIndex(nonmonotonic)?.itemBlockIndexes(split.key.itemId),
  ).toBeUndefined()

  const distinctProjection = Object.freeze({
    ...suffix.projection,
    sourceSpans: Object.freeze([...suffix.projection.sourceSpans]),
  })
  const inconsistentProjection = Object.freeze([
    prefix,
    Object.freeze({ ...suffix, projection: distinctProjection }),
  ])
  expect(
    createHeightIndex(inconsistentProjection)?.itemBlockIndexes(
      split.key.itemId,
    ),
  ).toBeUndefined()

  const empty = item("empty", "")
  expect(
    createHeightIndex(Object.freeze([empty]))?.itemBlockIndexes(
      empty.key.itemId,
    ),
  ).toEqual([0])
  const emptySpanInContent = Object.freeze({
    ...split,
    key: Object.freeze({ ...split.key, blockId: "empty-span" }),
    sourceSpan: Object.freeze({ from: 2, to: 2 }),
  })
  expect(
    createHeightIndex(Object.freeze([emptySpanInContent]))?.itemBlockIndexes(
      split.key.itemId,
    ),
  ).toBeUndefined()
  const duplicateEmpty = Object.freeze([
    empty,
    Object.freeze({
      ...empty,
      key: Object.freeze({ ...empty.key, blockId: "empty:1" }),
    }),
  ])
  expect(
    createHeightIndex(duplicateEmpty)?.itemBlockIndexes(empty.key.itemId),
  ).toBeUndefined()
})

test("100k item lookup is direct and replacement preserves the frozen lookup identity", () => {
  const plan = Object.freeze(
    Array.from({ length: 100_000 }, (_, index) => item(`lookup-${index}`, "x")),
  )
  const index = createHeightIndex(plan)!
  const target = plan[54_321]!
  const indexes = index.itemBlockIndexes(target.key.itemId)
  expect(indexes).toEqual([54_321])
  expect(Object.isFrozen(indexes)).toBe(true)
  expect(index.itemBlockIndexes(target.key.itemId)).toBe(indexes)

  const updated = index.replaceHeight({
    blockKey: blockKey(target),
    contentRevision: target.contentRevision,
    rows: 3,
  })
  expect(updated).not.toBe(index)
  expect(updated.itemBlockIndexes(target.key.itemId)).toBe(indexes)
  expect(index.itemBlockIndexes(plan[99_999]!.key.itemId)).toEqual([99_999])
}, 10_000)

test("100/1k/10k/100k height operations retain deterministic logarithmic visit and copy bounds", () => {
  for (const count of [100, 1_000, 10_000, 100_000]) {
    const plan = blocks(count)
    const index = createHeightIndex(plan)!
    const depthBound = Math.ceil(Math.log2(count)) + 1
    const middle = Math.floor(count / 2)
    const expectedTotal = Array.from(
      { length: count },
      (_, value) => (value % 5) + 1,
    ).reduce((sum, value) => sum + value, 0)
    expect(index.blockCount).toBe(count)
    expect(index.totalRows).toBe(expectedTotal)
    expect(index.supports(plan)).toBe(true)

    const prefixDiagnostics = diagnostics()
    const middleRow = index.prefixRows(middle, prefixDiagnostics)!
    expect(prefixDiagnostics.nodeVisits).toBeLessThanOrEqual(depthBound)
    expect(prefixDiagnostics.nodesCopied).toBe(0)

    const lookupDiagnostics = diagnostics()
    expect(index.blockAtRow(middleRow, lookupDiagnostics)).toBe(middle)
    expect(lookupDiagnostics.nodeVisits).toBeLessThanOrEqual(depthBound)
    expect(lookupDiagnostics.nodesCopied).toBe(0)

    const rangeDiagnostics = diagnostics()
    expect(
      index.rowRange(middle, Math.min(count, middle + 8), rangeDiagnostics)
        ?.rows,
    ).toBeGreaterThan(0)
    expect(rangeDiagnostics.nodeVisits).toBeLessThanOrEqual(depthBound * 2)
    expect(rangeDiagnostics.nodesCopied).toBe(0)

    const target = plan[middle]!
    const priorRows = index.prefixRows(middle + 1)! - middleRow
    const updateDiagnostics = diagnostics()
    const updated = index.replaceHeight(
      {
        blockKey: blockKey(target),
        contentRevision: target.contentRevision,
        rows: priorRows + 1,
      },
      updateDiagnostics,
    )
    expect(updated.totalRows).toBe(index.totalRows + 1)
    expect(updateDiagnostics.nodeVisits).toBeLessThanOrEqual(depthBound)
    expect(updateDiagnostics.nodesCopied).toBe(updateDiagnostics.nodeVisits)
    expect(updated.supports(plan)).toBe(true)
    expect(index.totalRows).toBe(expectedTotal)
  }
}, 10_000)

test("100/1k/10k/100k exact tail appends preserve old indexes with logarithmic height work", () => {
  for (const count of [100, 1_000, 10_000, 100_000]) {
    const before = persistentTranscriptBlockPlan(blocks(count))
    const index = createHeightIndex(before)!
    const next = block(count, 7)
    const after = appendTranscriptBlock(before, next)
    const appendDiagnostics = diagnostics()
    const appended = index.appendBlock?.(after, next, 7, appendDiagnostics)
    const depthBound = Math.ceil(Math.log2(count)) + 1

    expect(appended).toBeDefined()
    expect(appended?.supports(after)).toBe(true)
    expect(appended?.blockCount).toBe(count + 1)
    expect(appended?.totalRows).toBe(index.totalRows + 7)
    expect(appended?.blockIndex(blockKey(next))).toBe(count)
    expect(appended?.prefixRows(count)).toBe(index.totalRows)
    expect(appended?.blockAtRow(index.totalRows)).toBe(count)
    expect(index.supports(before)).toBe(true)
    expect(index.supports(after)).toBe(false)
    expect(index.blockIndex(blockKey(next))).toBeUndefined()
    expect(index.blockCount).toBe(count)
    expect(appendDiagnostics.nodeVisits).toBeLessThanOrEqual(depthBound)
    expect(appendDiagnostics.nodesCopied).toBeLessThanOrEqual(depthBound * 3)
  }
}, 10_000)

test("height append enforces exact lineage and preserves lookup and replacement contracts", () => {
  const historical = item("append-historical")
  const before = persistentTranscriptBlockPlan(
    Object.freeze([historical, block(1, 2), block(2, 3)]),
  )
  const index = createHeightIndex(before)!
  const historicalIndexes = index.itemBlockIndexes(historical.key.itemId)
  const next = item("append-next")
  const after = appendTranscriptBlock(before, next)
  const appended = index.appendBlock?.(after, next, 4)
  expect(appended).toBeDefined()
  expect(appended?.itemBlockIndexes(historical.key.itemId)).toBe(
    historicalIndexes,
  )
  expect(appended?.itemBlockIndexes(next.key.itemId)).toEqual([3])

  const lookalike = persistentTranscriptBlockPlan(
    Object.freeze([...before, next]),
  )
  expect(index.appendBlock?.(lookalike, next, 4)).toBeUndefined()
  expect(
    index.appendBlock?.(after, Object.freeze({ ...next }), 4),
  ).toBeUndefined()
  expect(index.appendBlock?.(after, next, -1)).toBeUndefined()
  const duplicate = before[0]!
  const duplicatePlan = appendTranscriptBlock(before, duplicate)
  expect(index.appendBlock?.(duplicatePlan, duplicate, 1)).toBeUndefined()

  const replacement = Object.freeze({
    ...next,
    contentRevision: next.contentRevision + 1,
  })
  const replacedPlan = replaceTranscriptBlock(after, 3, next, replacement)!
  const replaced = appended?.replaceBlock(replacedPlan, next, replacement, 5)
  expect(replaced?.supports(replacedPlan)).toBe(true)
  expect(replaced?.totalRows).toBe(appended!.totalRows + 1)
  expect(appended?.supports(after)).toBe(true)

  const growingRoot = item("append-after-replace", "abcd")
  const growingBefore = persistentTranscriptBlockPlan(
    Object.freeze([growingRoot]),
  )
  const growingIndex = createHeightIndex(growingBefore)!
  const prefix = Object.freeze({
    ...growingRoot,
    sourceSpan: Object.freeze({ from: 0, to: 2 }),
    contentRevision: 2,
  })
  const prefixPlan = replaceTranscriptBlock(
    growingBefore,
    0,
    growingRoot,
    prefix,
  )!
  const prefixIndex = growingIndex.replaceBlock(
    prefixPlan,
    growingRoot,
    prefix,
    2,
  )!
  const suffix = Object.freeze({
    ...prefix,
    key: Object.freeze({ ...prefix.key, blockId: "part:1" }),
    sourceSpan: Object.freeze({ from: 2, to: 4 }),
  })
  const grownPlan = appendTranscriptBlock(prefixPlan, suffix)
  const grownIndex = prefixIndex.appendBlock?.(grownPlan, suffix, 2)
  expect(grownIndex?.itemBlockIndexes(growingRoot.key.itemId)).toEqual([0, 1])
})

test("height append extends valid sub-block targets and invalidates ambiguous item lookup only in the new snapshot", () => {
  const root = item("append-split", "abcd")
  const prefix = Object.freeze({
    ...root,
    key: Object.freeze({ ...root.key, blockId: "part:0" }),
    sourceSpan: Object.freeze({ from: 0, to: 2 }),
  })
  const suffix = Object.freeze({
    ...root,
    key: Object.freeze({ ...root.key, blockId: "part:1" }),
    sourceSpan: Object.freeze({ from: 2, to: 4 }),
  })
  const before = persistentTranscriptBlockPlan(Object.freeze([prefix]))
  const index = createHeightIndex(before)!
  const originalIndexes = index.itemBlockIndexes(root.key.itemId)
  const after = appendTranscriptBlock(before, suffix)
  const appended = index.appendBlock?.(after, suffix, 2)
  expect(appended?.itemBlockIndexes(root.key.itemId)).toEqual([0, 1])
  expect(index.itemBlockIndexes(root.key.itemId)).toBe(originalIndexes)
  expect(index.itemBlockIndexes(root.key.itemId)).toEqual([0])

  const overlap = Object.freeze({
    ...suffix,
    key: Object.freeze({ ...suffix.key, blockId: "part:overlap" }),
    sourceSpan: Object.freeze({ from: 1, to: 4 }),
  })
  const overlapPlan = appendTranscriptBlock(before, overlap)
  const ambiguous = index.appendBlock?.(overlapPlan, overlap, 2)
  expect(ambiguous).toBeDefined()
  expect(ambiguous?.itemBlockIndexes(root.key.itemId)).toBeUndefined()
  const recoveryPlan = appendTranscriptBlock(overlapPlan, suffix)
  const stillAmbiguous = ambiguous?.appendBlock?.(recoveryPlan, suffix, 2)
  expect(stillAmbiguous?.itemBlockIndexes(root.key.itemId)).toBeUndefined()
  expect(index.itemBlockIndexes(root.key.itemId)).toEqual([0])
})

test.each([0, 1, 1000])(
  "item span splice at ordinal %i preserves exact lookup, rows, and immutable snapshots",
  (at) => {
    const root = item(`splice-${at}`, "abcdef")
    const fragments = itemFragments(root)
    const prefix = Array.from({ length: at }, (_, index) => block(index, 2))
    const suffix = [block(at + 1, 0), block(at + 2, 4)]
    const initialPlan = persistentTranscriptBlockPlan(
      Object.freeze([...prefix, root, ...suffix]),
    )
    const initial = createHeightIndex(initialPlan, [
      {
        blockKey: blockKey(suffix[0]!),
        contentRevision: suffix[0]!.contentRevision,
        rows: 0,
      },
    ])!
    const counters = {
      blockPlanUpdates: 0,
      blockPlanNodeVisits: 0,
      blockPlanNodesCopied: 0,
    }
    const previous = Object.freeze([root])
    const expandedPlan = spliceTranscriptItemBlocks(
      initialPlan,
      at,
      previous,
      fragments,
      counters,
    )!
    const expanded = initial.spliceItemBlocks?.(
      expandedPlan,
      at,
      previous,
      fragments,
      [2, 0, 4],
    )!
    // A different prior-array identity has no lineage proof.
    expect(
      initial.spliceItemBlocks?.(
        expandedPlan,
        at,
        [root],
        fragments,
        [2, 0, 4],
      ),
    ).toBeUndefined()
    expect(expandedPlan.length).toBe(initialPlan.length + 2)
    expect(expandedPlan.slice(at, at + 3)).toEqual([...fragments])
    expect(Object.keys(expandedPlan)).toHaveLength(expandedPlan.length)
    expect([...expandedPlan]).toEqual([...prefix, ...fragments, ...suffix])
    expect(expanded.itemBlockIndexes(root.key.itemId)).toEqual([
      at,
      at + 1,
      at + 2,
    ])
    expect(expanded.blockIndex(blockKey(suffix[0]!))).toBe(at + 3)
    expect(expanded.blockIndex(blockKey(suffix[1]!))).toBe(at + 4)
    expect(expanded.blockIndex(blockKey(root))).toBeUndefined()
    expect(initial.blockIndex(blockKey(root))).toBe(at)
    expect(initialPlan[at]).toBe(root)
    const reference = createHeightIndex(expandedPlan, [
      { blockKey: blockKey(fragments[0]!), contentRevision: 1, rows: 2 },
      { blockKey: blockKey(fragments[1]!), contentRevision: 1, rows: 0 },
      { blockKey: blockKey(fragments[2]!), contentRevision: 1, rows: 4 },
      {
        blockKey: blockKey(suffix[0]!),
        contentRevision: suffix[0]!.contentRevision,
        rows: 0,
      },
    ])!
    expect(expanded.totalRows).toBe(reference.totalRows)
    for (let ordinal = 0; ordinal <= expanded.blockCount; ordinal++)
      expect(expanded.prefixRows(ordinal)).toBe(reference.prefixRows(ordinal))
    for (let row = 0; row < expanded.totalRows; row++)
      expect(expanded.blockAtRow(row)).toBe(reference.blockAtRow(row))
    for (const offset of [0, 1, 2, 3, 4, 5, 6])
      expect(
        transcriptPointBlockIndex(
          expandedPlan,
          expanded,
          {
            itemId: root.key.itemId,
            graphemeOffset: offset,
          },
          undefined,
        ),
      ).toBe(
        transcriptPointBlockIndex(
          expandedPlan,
          reference,
          {
            itemId: root.key.itemId,
            graphemeOffset: offset,
          },
          undefined,
        ),
      )
    expect(counters.blockPlanNodeVisits).toBeLessThan(200)
    expect(counters.blockPlanNodesCopied).toBeLessThan(200)
    const adjusted = expanded.replaceHeight({
      blockKey: blockKey(suffix[1]!),
      contentRevision: suffix[1]!.contentRevision,
      rows: 7,
    })
    expect(adjusted.totalRows).toBe(expanded.totalRows + 3)
    expect(expanded.totalRows).toBe(reference.totalRows)
    const changedFragment = adjusted.replaceHeight({
      blockKey: blockKey(fragments[1]!),
      contentRevision: fragments[1]!.contentRevision,
      rows: 5,
    })
    expect(changedFragment.totalRows).toBe(adjusted.totalRows + 5)
    expect(adjusted.totalRows).toBe(expanded.totalRows + 3)
  },
)

test("repeated span growth and shrink collapses inverse overlays without rebuilding", () => {
  const root = item("toggle-span", "abcdef")
  const fragments = itemFragments(root)
  const head = block(0, 0),
    tail = block(1, 3)
  let plan = persistentTranscriptBlockPlan(Object.freeze([head, root, tail]))
  let index = createHeightIndex(plan, [
    {
      blockKey: blockKey(head),
      contentRevision: head.contentRevision,
      rows: 0,
    },
  ])!
  for (let cycle = 0; cycle < 300; cycle++) {
    const previous = Object.freeze(
      index.itemBlockIndexes(root.key.itemId)!.map((ordinal) => plan[ordinal]!),
    )
    const next = previous.length === 1 ? fragments : Object.freeze([root])
    const rows = previous.length === 1 ? [2, 0, 4] : [1]
    const spliced = spliceTranscriptItemBlocks(plan, 1, previous, next)!
    const updated = index.spliceItemBlocks?.(spliced, 1, previous, next, rows)
    expect(updated).toBeDefined()
    index = updated!
    plan = spliced
    expect(index.blockIndex(blockKey(tail))).toBe(plan.length - 1)
    expect(index.totalRows).toBe(3 + rows.reduce((sum, row) => sum + row, 0))
    expect(plan[0]).toBe(head)
    expect(plan.at(-1)).toBe(tail)
    expect(index.blockAtRow(0)).toBe(1)
    expect(index.blockAtRow(index.totalRows - 1)).toBe(plan.length - 1)
  }
})

test("post-fold tail admission, streaming revision, and measured rows keep indexed lineage", () => {
  const root = item("folded-history", "abcdef")
  const fragments = itemFragments(root)
  const existing = item("existing-tail")
  const initialPlan = persistentTranscriptBlockPlan(
    Object.freeze([root, existing]),
  )
  const initial = createHeightIndex(initialPlan)!
  const previous = Object.freeze([root])
  const expandedPlan = spliceTranscriptItemBlocks(
    initialPlan,
    0,
    previous,
    fragments,
  )!
  const expanded = initial.spliceItemBlocks?.(
    expandedPlan,
    0,
    previous,
    fragments,
    [2, 3, 4],
  )!
  const changedExisting = Object.freeze({
    ...existing,
    contentRevision: existing.contentRevision + 1,
    estimatedRows: 6,
  })
  const revisedPlan = replaceTranscriptBlock(
    expandedPlan,
    3,
    existing,
    changedExisting,
  )!
  const revised = expanded.replaceBlock(
    revisedPlan,
    existing,
    changedExisting,
    6,
  )!
  expect(revised.blockIndex(blockKey(existing))).toBe(3)
  expect(revised.rowRange(3, 4)?.rows).toBe(6)
  expect(expanded.rowRange(3, 4)?.rows).toBe(1)
  let plan = revisedPlan,
    index = revised
  for (let step = 0; step < 100; step++) {
    const next = item(`admitted-${step}`)
    const appended = appendTranscriptBlock(plan, next)
    const updated = index.appendBlock?.(appended, next, step % 7)
    expect(updated).toBeDefined()
    plan = appended
    index = updated!
    expect(index.blockIndex(blockKey(next))).toBe(plan.length - 1)
    expect(index.itemBlockIndexes(next.key.itemId)).toEqual([plan.length - 1])
  }
  const last = plan.at(-1)! as TranscriptItemBlock
  const streamed = Object.freeze({
    ...last,
    contentRevision: last.contentRevision + 1,
    estimatedRows: 11,
  })
  const streamedPlan = replaceTranscriptBlock(
    plan,
    plan.length - 1,
    last,
    streamed,
  )!
  const streamedIndex = index.replaceBlock(streamedPlan, last, streamed, 11)!
  expect(streamedIndex.rowRange(plan.length - 1, plan.length)?.rows).toBe(11)
  expect(streamedIndex.blockAtRow(streamedIndex.totalRows - 1)).toBe(
    plan.length - 1,
  )
  expect(initial.blockCount).toBe(2)
  expect(expanded.blockCount).toBe(4)
  expect(revised.blockCount).toBe(4)
  expect(index.blockCount).toBe(104)
  expect(streamedIndex.supports(streamedPlan)).toBe(true)
})

test("fold overlay depth stays bounded after a tail append wraps the index", () => {
  const roots = Array.from({ length: 130 }, (_, ordinal) =>
    item(`bounded-span-${ordinal}`, "abcdef"),
  )
  let plan = persistentTranscriptBlockPlan(Object.freeze([...roots]))
  let index = createHeightIndex(plan)!
  const first = Object.freeze([roots[0]!])
  const firstFragments = itemFragments(roots[0]!)
  const expanded = spliceTranscriptItemBlocks(plan, 0, first, firstFragments)!
  index = index.spliceItemBlocks?.(
    expanded,
    0,
    first,
    firstFragments,
    firstFragments.map((fragment) => fragment.estimatedRows),
  )!
  plan = expanded

  const admitted = block(999, 2)
  const appended = appendTranscriptBlock(plan, admitted)
  index = index.appendBlock?.(appended, admitted, 2)!
  plan = appended
  expect(index.supports(plan)).toBe(true)

  for (let ordinal = 1; ordinal < 128; ordinal++) {
    const root = roots[ordinal]!
    const prior = Object.freeze([root])
    const fragments = itemFragments(root)
    const at = index.itemBlockIndexes(root.key.itemId)![0]!
    const nextPlan = spliceTranscriptItemBlocks(plan, at, prior, fragments)!
    const nextIndex = index.spliceItemBlocks?.(
      nextPlan,
      at,
      prior,
      fragments,
      fragments.map((fragment) => fragment.estimatedRows),
    )
    expect(nextIndex).toBeDefined()
    plan = nextPlan
    index = nextIndex!
  }
  const last = roots[128]!
  const lastPrior = Object.freeze([last])
  const lastFragments = itemFragments(last)
  const at = index.itemBlockIndexes(last.key.itemId)![0]!
  const nextPlan = spliceTranscriptItemBlocks(
    plan,
    at,
    lastPrior,
    lastFragments,
  )!
  expect(
    index.spliceItemBlocks?.(
      nextPlan,
      at,
      lastPrior,
      lastFragments,
      lastFragments.map((fragment) => fragment.estimatedRows),
    ),
  ).toBeUndefined()
  expect(index.supports(plan)).toBe(true)
  expect(index.blockIndex(blockKey(admitted))).toBe(plan.length - 1)
  expect(index.itemBlockIndexes(last.key.itemId)).toEqual([at])
})

test("persistent block splices stay balanced across alternating start, middle, and end edits", () => {
  const roots = Array.from({ length: 12 }, (_, index) =>
    item(`span-${index}`, "abcdef"),
  )
  const reference: TranscriptBlock[] = []
  for (let index = 0; index < roots.length; index++) {
    reference.push(roots[index]!)
    for (let gap = 0; gap < 80; gap++)
      reference.push(block(index * 80 + gap, 1))
  }
  let plan = persistentTranscriptBlockPlan(Object.freeze([...reference]))
  for (let step = 0; step < 120; step++) {
    const root = roots[step % roots.length]!
    const from = reference.findIndex(
      (candidate) =>
        candidate.key.kind === "item" &&
        candidate.key.itemId === root.key.itemId,
    )
    const prior = Object.freeze(
      reference.slice(from, from + (reference[from] === root ? 1 : 3)),
    )
    const next =
      prior.length === 1 ? itemFragments(root) : Object.freeze([root])
    const counters = {
      blockPlanUpdates: 0,
      blockPlanNodeVisits: 0,
      blockPlanNodesCopied: 0,
    }
    const previousPlan = plan
    plan = spliceTranscriptItemBlocks(plan, from, prior, next, counters)!
    reference.splice(from, prior.length, ...next)
    expect([...plan]).toEqual(reference)
    expect(plan.length).toBe(reference.length)
    expect(previousPlan[from]).toBe(prior[0])
    expect(counters.blockPlanUpdates).toBe(1)
    expect(counters.blockPlanNodeVisits).toBeLessThan(200)
    expect(counters.blockPlanNodesCopied).toBeLessThan(200)
  }
})

test("seeded multi-item fold splices retain exact row and point lookup beyond 32 changes", () => {
  const roots = Array.from({ length: 48 }, (_, index) =>
    item(`random-span-${index}`, "abcdef"),
  )
  const reference: TranscriptBlock[] = []
  for (let index = 0; index < roots.length; index++) {
    reference.push(roots[index]!)
    for (let gap = 0; gap < 9; gap++)
      reference.push(block(index * 9 + gap, (gap % 4) + 1))
  }
  let plan = persistentTranscriptBlockPlan(Object.freeze([...reference]))
  let index = createHeightIndex(plan)!
  let seed = 0x5eed
  for (let step = 0; step < 75; step++) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
    const root = roots[seed % roots.length]!
    const at = reference.findIndex(
      (candidate) =>
        candidate.key.kind === "item" &&
        candidate.key.itemId === root.key.itemId,
    )
    const prior = Object.freeze(
      reference.slice(at, at + (reference[at] === root ? 1 : 3)),
    )
    const next =
      prior.length === 1 ? itemFragments(root) : Object.freeze([root])
    const rows = next.map((candidate) => candidate.estimatedRows)
    const priorIndex = index,
      priorTotalRows = index.totalRows
    const spliced = spliceTranscriptItemBlocks(plan, at, prior, next)!
    const updated = index.spliceItemBlocks?.(spliced, at, prior, next, rows)
    expect(updated).toBeDefined()
    plan = spliced
    index = updated!
    reference.splice(at, prior.length, ...next)
    const oracle = createHeightIndex(Object.freeze([...reference]))!
    expect([...plan]).toEqual(reference)
    expect(index.blockCount).toBe(reference.length)
    expect(index.totalRows).toBe(oracle.totalRows)
    expect(priorIndex.totalRows).toBe(priorTotalRows)
    for (const ordinal of [0, at, at + next.length, reference.length])
      expect(index.prefixRows(ordinal)).toBe(oracle.prefixRows(ordinal))
    for (const row of [0, index.totalRows >>> 1, index.totalRows - 1])
      expect(index.blockAtRow(row)).toBe(oracle.blockAtRow(row))
    for (const offset of [0, 1, 2, 3, 4, 5, 6])
      expect(
        transcriptPointBlockIndex(
          plan,
          index,
          { itemId: root.key.itemId, graphemeOffset: offset },
          undefined,
        ),
      ).toBe(
        transcriptPointBlockIndex(
          plan,
          oracle,
          { itemId: root.key.itemId, graphemeOffset: offset },
          undefined,
        ),
      )
  }
})
