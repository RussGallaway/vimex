import { expect, test } from "bun:test"
import { itemId, turnId, type TurnId } from "@vimex/conversation"
import { createHeightIndex, type BlockHeightOverride, type HeightIndexDiagnostics } from "./height-index"
import { blockKey, type TranscriptBlock, type TranscriptItemBlock, type TranscriptTurnActivityBlock } from "./window"

function block(index: number, rows: number, id: TurnId = turnId(`height-${index}`)): TranscriptTurnActivityBlock {
  return Object.freeze({
    key: Object.freeze({ kind: "turn-activity" as const, turnId: id }),
    turn: Object.freeze({ id, status: "complete" as const, itemIds: Object.freeze([]) }),
    contentRevision: index + 1,
    estimatedRows: rows,
  })
}

function blocks(count: number): readonly TranscriptBlock[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => block(index, index % 5 + 1)))
}

function diagnostics(): HeightIndexDiagnostics {
  return { nodeVisits: 0, nodesCopied: 0 }
}

function item(name: string, source = "abcd"): TranscriptItemBlock {
  const id = itemId(name)
  const projection = Object.freeze({
    plain: source,
    source,
    sourceSpans: Object.freeze([...source].map((_, index) => Object.freeze({ from: index, to: index + 1 }))),
    links: Object.freeze([]),
    revision: 1,
  })
  const value = Object.freeze({ id, turnId: turnId("height-items"), kind: "assistant" as const, markdown: source, status: "complete" as const })
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
  const plan = Object.freeze([block(0, 2), block(1, 1), block(2, 4), block(3, 3)])
  const secondKey = blockKey(plan[1]!)
  const overrides: readonly BlockHeightOverride[] = Object.freeze([
    Object.freeze({ blockKey: secondKey, contentRevision: plan[1]!.contentRevision - 1, rows: 99 }),
    Object.freeze({ blockKey: "missing", contentRevision: 1, rows: 99 }),
    Object.freeze({ blockKey: secondKey, contentRevision: plan[1]!.contentRevision, rows: 0 }),
    Object.freeze({ blockKey: secondKey, contentRevision: plan[1]!.contentRevision, rows: 5 }),
  ])
  const index = createHeightIndex(plan, overrides)!

  expect(index.blockCount).toBe(4)
  expect(index.totalRows).toBe(14)
  expect([0, 1, 2, 3, 4].map(value => index.prefixRows(value))).toEqual([0, 2, 7, 11, 14])
  expect(Number.isNaN(index.prefixRows(-1))).toBe(true)
  expect(Number.isNaN(index.prefixRows(1.5))).toBe(true)
  expect(Number.isNaN(index.prefixRows(5))).toBe(true)
  expect([0, 1, 2, 6, 7, 10, 11, 13].map(row => index.blockAtRow(row))).toEqual([0, 0, 1, 1, 2, 2, 3, 3])
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
  expect(index.supports(Object.freeze(plan.map((entry, position) => position === 1
    ? Object.freeze({ ...entry, contentRevision: entry.contentRevision + 1 }) : entry)))).toBe(false)
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
  const updated = original.replaceHeight({ blockKey: key, contentRevision: target.contentRevision, rows: oldRows + 7 }, updateDiagnostics)

  expect(updated).not.toBe(original)
  expect(original.totalRows).toBe(300)
  expect(updated.totalRows).toBe(original.totalRows + 7)
  expect(original.prefixRows(51)).toBe(beforeTarget)
  expect(updated.prefixRows(51)).toBe(beforeTarget)
  expect(updated.prefixRows(52)).toBe(original.prefixRows(52)! + 7)
  expect(updateDiagnostics.nodeVisits).toBe(updateDiagnostics.nodesCopied)
  expect(updateDiagnostics.nodesCopied).toBeLessThanOrEqual(Math.ceil(Math.log2(plan.length)) + 1)

  const noOpDiagnostics = diagnostics()
  expect(updated.replaceHeight({ blockKey: key, contentRevision: target.contentRevision, rows: oldRows + 7 }, noOpDiagnostics)).toBe(updated)
  expect(noOpDiagnostics.nodesCopied).toBe(0)
  expect(noOpDiagnostics.nodeVisits).toBeLessThanOrEqual(Math.ceil(Math.log2(plan.length)) + 1)
  expect(updated.replaceHeight({ blockKey: key, contentRevision: target.contentRevision + 1, rows: 20 })).toBe(updated)
  expect(updated.replaceHeight({ blockKey: key, contentRevision: target.contentRevision, rows: 0 })).toBe(updated)
  expect(updated.replaceHeight({ blockKey: "missing", contentRevision: target.contentRevision, rows: 20 })).toBe(updated)
})

test("duplicate block keys reject indexed planning and invalid estimates remain safe", () => {
  const duplicateId = turnId("duplicate")
  expect(createHeightIndex(Object.freeze([block(0, 1, duplicateId), block(1, 2, duplicateId)]))).toBeUndefined()
  expect(createHeightIndex(Object.freeze([block(0, Number.MAX_SAFE_INTEGER), block(1, 1)]))).toBeUndefined()

  const invalid = Object.freeze([
    block(0, 0),
    block(1, Number.NaN),
    block(2, Number.POSITIVE_INFINITY),
    block(3, 2.5),
  ])
  const index = createHeightIndex(invalid, Object.freeze([
    Object.freeze({ blockKey: blockKey(invalid[0]!), contentRevision: invalid[0]!.contentRevision, rows: -1 }),
  ]))!
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
  expect(Object.isFrozen(rootIndex.itemBlockIndexes(root.key.itemId))).toBe(true)
  expect(rootIndex.itemBlockIndexes(itemId("missing"))).toBeUndefined()

  const split = item("split")
  const prefix = Object.freeze({ ...split,
    key: Object.freeze({ ...split.key, blockId: "part:0" }), sourceSpan: Object.freeze({ from: 0, to: 2 }) })
  const suffix = Object.freeze({ ...split,
    key: Object.freeze({ ...split.key, blockId: "part:1" }), sourceSpan: Object.freeze({ from: 2, to: 4 }) })
  const splitPlan = Object.freeze([prefix, block(2, 1), suffix])
  const splitIndex = createHeightIndex(splitPlan)!
  expect(splitIndex.itemBlockIndexes(split.key.itemId)).toEqual([0, 2])

  const overlapping = Object.freeze([prefix, Object.freeze({ ...suffix, sourceSpan: Object.freeze({ from: 1, to: 4 }) })])
  const nonmonotonic = Object.freeze([suffix, prefix])
  expect(createHeightIndex(overlapping)?.itemBlockIndexes(split.key.itemId)).toBeUndefined()
  expect(createHeightIndex(nonmonotonic)?.itemBlockIndexes(split.key.itemId)).toBeUndefined()

  const distinctProjection = Object.freeze({
    ...suffix.projection,
    sourceSpans: Object.freeze([...suffix.projection.sourceSpans]),
  })
  const inconsistentProjection = Object.freeze([prefix, Object.freeze({ ...suffix, projection: distinctProjection })])
  expect(createHeightIndex(inconsistentProjection)?.itemBlockIndexes(split.key.itemId)).toBeUndefined()

  const empty = item("empty", "")
  expect(createHeightIndex(Object.freeze([empty]))?.itemBlockIndexes(empty.key.itemId)).toEqual([0])
  const emptySpanInContent = Object.freeze({ ...split,
    key: Object.freeze({ ...split.key, blockId: "empty-span" }), sourceSpan: Object.freeze({ from: 2, to: 2 }) })
  expect(createHeightIndex(Object.freeze([emptySpanInContent]))?.itemBlockIndexes(split.key.itemId)).toBeUndefined()
  const duplicateEmpty = Object.freeze([empty, Object.freeze({ ...empty, key: Object.freeze({ ...empty.key, blockId: "empty:1" }) })])
  expect(createHeightIndex(duplicateEmpty)?.itemBlockIndexes(empty.key.itemId)).toBeUndefined()
})

test("100k item lookup is direct and replacement preserves the frozen lookup identity", () => {
  const plan = Object.freeze(Array.from({ length: 100_000 }, (_, index) => item(`lookup-${index}`, "x")))
  const index = createHeightIndex(plan)!
  const target = plan[54_321]!
  const indexes = index.itemBlockIndexes(target.key.itemId)
  expect(indexes).toEqual([54_321])
  expect(Object.isFrozen(indexes)).toBe(true)
  expect(index.itemBlockIndexes(target.key.itemId)).toBe(indexes)

  const updated = index.replaceHeight({ blockKey: blockKey(target), contentRevision: target.contentRevision, rows: 3 })
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
    const expectedTotal = Array.from({ length: count }, (_, value) => value % 5 + 1).reduce((sum, value) => sum + value, 0)
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
    expect(index.rowRange(middle, Math.min(count, middle + 8), rangeDiagnostics)?.rows).toBeGreaterThan(0)
    expect(rangeDiagnostics.nodeVisits).toBeLessThanOrEqual(depthBound * 2)
    expect(rangeDiagnostics.nodesCopied).toBe(0)

    const target = plan[middle]!
    const priorRows = index.prefixRows(middle + 1)! - middleRow
    const updateDiagnostics = diagnostics()
    const updated = index.replaceHeight({ blockKey: blockKey(target), contentRevision: target.contentRevision, rows: priorRows + 1 }, updateDiagnostics)
    expect(updated.totalRows).toBe(index.totalRows + 1)
    expect(updateDiagnostics.nodeVisits).toBeLessThanOrEqual(depthBound)
    expect(updateDiagnostics.nodesCopied).toBe(updateDiagnostics.nodeVisits)
    expect(updated.supports(plan)).toBe(true)
    expect(index.totalRows).toBe(expectedTotal)
  }
}, 10_000)
