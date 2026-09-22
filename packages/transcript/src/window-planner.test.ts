import { expect, test } from "bun:test"
import { itemId, turnId } from "@vimex/conversation"
import { createHeightIndex } from "./height-index"
import {
  appendTranscriptBlock,
  blockKey,
  isTranscriptBlockAppend,
  passThroughWindow,
  persistentTranscriptBlockPlan,
  planTranscriptWindow,
  pointIsMaterialized,
  replaceTranscriptBlock,
  type TranscriptBlock,
  type TranscriptItemBlock,
} from "./window"

function item(
  name: string,
  estimatedRows = 1,
  source = "x",
): TranscriptItemBlock {
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
    turnId: turnId("turn"),
    kind: "assistant" as const,
    markdown: source,
    status: "complete" as const,
  })
  return Object.freeze({
    key: Object.freeze({ kind: "item" as const, itemId: id, blockId: "root" }),
    turnId: turnId("turn"),
    item: value,
    renderItem: value,
    projection,
    sourceSpan: Object.freeze({ from: 0, to: source.length }),
    contentRevision: 1,
    estimatedRows,
    followedByActivity: false,
  })
}

test("persistent complete plans replace one slot logarithmically without mutating old snapshots", () => {
  const source = Object.freeze(
    Array.from({ length: 100_000 }, (_, index) => item(`persistent-${index}`)),
  )
  const before = persistentTranscriptBlockPlan(source)
  const position = 61_731
  const previous = before[position]!
  const next = Object.freeze({
    ...previous,
    contentRevision: previous.contentRevision + 1,
  })
  const diagnostics = {
    blockPlanUpdates: 0,
    blockPlanNodeVisits: 0,
    blockPlanNodesCopied: 0,
  }
  const after = replaceTranscriptBlock(
    before,
    position,
    previous,
    next,
    diagnostics,
  )!

  expect(Array.isArray(after)).toBe(true)
  expect(after).toHaveLength(source.length)
  expect(before[position]).toBe(previous)
  expect(after[position]).toBe(next)
  expect(after[position - 1]).toBe(before[position - 1])
  expect(after.slice(position - 1, position + 2)).toEqual([
    before[position - 1]!,
    next,
    before[position + 1]!,
  ])
  expect(
    JSON.parse(JSON.stringify(after.slice(position, position + 1)))[0]
      .contentRevision,
  ).toBe(next.contentRevision)
  expect(Reflect.set(after, String(position), previous)).toBe(false)
  expect(diagnostics.blockPlanUpdates).toBe(1)
  expect(diagnostics.blockPlanNodeVisits).toBeLessThanOrEqual(
    2 * (Math.ceil(Math.log2(source.length)) + 1),
  )
  expect(diagnostics.blockPlanNodesCopied).toBeGreaterThan(0)
  expect(diagnostics.blockPlanNodesCopied).toBeLessThanOrEqual(
    Math.ceil(Math.log2(source.length)) + 1,
  )
})

test("persistent complete plans preserve array reflection and reject integrity mutation", () => {
  const source = Object.freeze([
    item("array-a"),
    item("array-b"),
    item("array-c"),
  ])
  const plan = persistentTranscriptBlockPlan(source)
  expect(plan.length).toBe(3)
  expect(Object.getOwnPropertyDescriptor(plan, "length")?.value).toBe(3)
  expect(Object.keys(plan)).toEqual(["0", "1", "2"])
  expect(Reflect.ownKeys(plan)).toEqual(["0", "1", "2", "length"])
  expect([...plan]).toEqual([...source])
  expect(plan.map(blockKey)).toEqual(source.map(blockKey))
  expect(plan.slice(1)).toEqual(source.slice(1))
  expect(plan.concat(source[0]!)).toEqual([...source, source[0]!])
  expect([...plan.entries()]).toEqual([...source.entries()])
  expect(JSON.stringify(plan)).toBe(JSON.stringify(source))
  expect(Reflect.setPrototypeOf(plan, { polluted: true })).toBe(false)
  expect(Reflect.preventExtensions(plan)).toBe(false)
  expect(() => Object.freeze(plan)).toThrow()
  expect([...plan]).toEqual([...source])
  expect(Object.keys(plan)).toEqual(["0", "1", "2"])
})

test("100/1k/10k/100k persistent tail appends retain old snapshots with logarithmic tree work", () => {
  for (const count of [100, 1_000, 10_000, 100_000]) {
    const source = Object.freeze(
      Array.from({ length: count }, (_, index) =>
        item(`append-plan-${count}-${index}`),
      ),
    )
    const before = persistentTranscriptBlockPlan(source)
    const next = item(`append-plan-${count}-next`)
    const diagnostics = {
      blockPlanUpdates: 0,
      blockPlanNodeVisits: 0,
      blockPlanNodesCopied: 0,
    }
    const after = appendTranscriptBlock(before, next, diagnostics)
    const depthBound = Math.ceil(Math.log2(count)) + 1

    expect(after).toHaveLength(count + 1)
    expect(after[count]).toBe(next)
    expect(after[0]).toBe(before[0])
    expect(after[count - 1]).toBe(before[count - 1])
    expect(before).toHaveLength(count)
    expect(before[count]).toBeUndefined()
    expect(isTranscriptBlockAppend(before, after, next)).toBe(true)
    expect(isTranscriptBlockAppend(source, after, next)).toBe(false)
    expect(diagnostics.blockPlanUpdates).toBe(1)
    expect(diagnostics.blockPlanNodeVisits).toBeLessThanOrEqual(depthBound)
    expect(diagnostics.blockPlanNodesCopied).toBeLessThanOrEqual(depthBound * 3)

    const replacement = Object.freeze({
      ...next,
      contentRevision: next.contentRevision + 1,
    })
    const replaced = replaceTranscriptBlock(after, count, next, replacement)
    expect(replaced?.[count]).toBe(replacement)
    expect(after[count]).toBe(next)
  }
}, 10_000)

function activity(name: string, estimatedRows = 1): TranscriptBlock {
  const id = turnId(name)
  return Object.freeze({
    key: Object.freeze({ kind: "turn-activity" as const, turnId: id }),
    turn: Object.freeze({
      id,
      status: "complete" as const,
      itemIds: Object.freeze([]),
    }),
    contentRevision: 1,
    estimatedRows,
  })
}

function heightIndex(
  blocks: readonly TranscriptBlock[],
  rows: readonly number[] = blocks.map((block) => block.estimatedRows),
) {
  const heights = createHeightIndex(
    blocks,
    blocks.map((block, index) => ({
      blockKey: blockKey(block),
      contentRevision: block.contentRevision,
      rows: rows[index]!,
    })),
  )
  if (!heights) throw new Error("Expected a valid height index")
  return heights
}

function keys(blocks: readonly TranscriptBlock[]): readonly string[] {
  return blocks.map(blockKey)
}

function point(block: TranscriptItemBlock, graphemeOffset = 0) {
  return Object.freeze({ itemId: block.key.itemId, graphemeOffset })
}

function expectedSlice(
  rows: readonly number[],
  viewportRows: number,
  overscanRows: number,
  attachment: "tail" | Readonly<{ index: number; preferredScreenRow: number }>,
): Readonly<{ first: number; end: number; top: number; bottom: number }> {
  const prefix = [0]
  for (const row of rows) prefix.push(prefix.at(-1)! + row)
  const total = prefix.at(-1)!
  const maximumStart = Math.max(0, total - viewportRows)
  const visibleStart =
    attachment === "tail"
      ? maximumStart
      : Math.max(
          0,
          Math.min(
            prefix[attachment.index]! -
              Math.min(attachment.preferredScreenRow, viewportRows - 1),
            maximumStart,
          ),
        )
  const visibleEnd = Math.min(total, visibleStart + viewportRows)
  const from = Math.max(0, visibleStart - overscanRows)
  const to =
    attachment === "tail" ? total : Math.min(total, visibleEnd + overscanRows)
  let first = 0
  while (first < rows.length && prefix[first + 1]! <= from) first++
  let end = first
  while (end < rows.length && prefix[end]! < to) end++
  return Object.freeze({
    first,
    end,
    top: prefix[first]!,
    bottom: total - prefix[end]!,
  })
}

test("empty plans are inert and invalid planning facts take the exact pass-through fallback", () => {
  const empty: readonly TranscriptBlock[] = Object.freeze([])
  const emptyHeights = heightIndex(empty)
  const emptyWindow = planTranscriptWindow({
    blocks: empty,
    heights: emptyHeights,
    viewportRows: 0,
    overscanRows: 0,
    attachment: { kind: "tail" },
  })
  expect(emptyWindow).toEqual(passThroughWindow(empty))
  expect(Object.isFrozen(emptyWindow)).toBe(true)
  expect(Object.isFrozen(emptyWindow.blocks)).toBe(true)

  const blocks = Object.freeze([item("a"), item("b")])
  const heights = heightIndex(blocks)
  for (const invalid of [
    { viewportRows: 0, overscanRows: 0 },
    { viewportRows: -1, overscanRows: 0 },
    { viewportRows: 1.5, overscanRows: 0 },
    { viewportRows: 1, overscanRows: -1 },
    { viewportRows: 1, overscanRows: Number.NaN },
  ]) {
    const window = planTranscriptWindow({
      blocks,
      heights,
      ...invalid,
      attachment: { kind: "tail" },
    })
    expect(window).toEqual(passThroughWindow(blocks))
    expect(window.blocks).toBe(blocks)
  }
  const reversed = Object.freeze([...blocks].reverse())
  expect(
    planTranscriptWindow({
      blocks: reversed,
      heights,
      viewportRows: 1,
      overscanRows: 0,
      attachment: { kind: "tail" },
    }).blocks,
  ).toBe(reversed)
  const duplicate = Object.freeze([blocks[0]!, blocks[0]!])
  expect(
    planTranscriptWindow({
      blocks: duplicate,
      heights,
      viewportRows: 1,
      overscanRows: 0,
      attachment: { kind: "tail" },
    }).blocks,
  ).toBe(duplicate)
})

test("half-open row boundaries include only intersecting blocks", () => {
  const blocks = Object.freeze([item("a"), item("b"), item("c"), item("d")])
  const heights = heightIndex(blocks, [2, 3, 4, 1])
  const cases = [
    { target: 0, viewport: 2, preferred: 0, expected: [0] },
    { target: 1, viewport: 3, preferred: 0, expected: [1] },
    { target: 1, viewport: 2, preferred: 1, expected: [0, 1] },
    { target: 2, viewport: 2, preferred: 1, expected: [1, 2] },
    { target: 3, viewport: 1, preferred: 0, expected: [3] },
  ] as const
  for (const entry of cases) {
    const target = blocks[entry.target] as TranscriptItemBlock
    const window = planTranscriptWindow({
      blocks,
      heights,
      viewportRows: entry.viewport,
      overscanRows: 0,
      attachment: {
        kind: "point",
        point: point(target),
        preferredScreenRow: entry.preferred,
      },
    })
    expect(keys(window.blocks)).toEqual(
      entry.expected.map((index) => blockKey(blocks[index]!)),
    )
    expect(
      window.topSpacerRows +
        heights.rowRange(entry.expected[0]!, entry.expected.at(-1)! + 1)!.rows +
        window.bottomSpacerRows,
    ).toBe(heights.totalRows)
  }
})

test("a measured block-local anchor row plans around the exact logical point", () => {
  const before = Array.from({ length: 10 }, (_, index) =>
    item(`before-${index}`),
  )
  const target = item("tall-anchor", 20, "abcdefghijklmnopqrst")
  const after = Array.from({ length: 10 }, (_, index) => item(`after-${index}`))
  const blocks = Object.freeze([...before, target, ...after])
  const heights = heightIndex(blocks)
  const window = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 5,
    overscanRows: 2,
    attachment: {
      kind: "point",
      point: point(target, 15),
      preferredScreenRow: 2,
      blockLocalRow: 15,
    },
  })

  expect(window.blocks[0]).toBe(target)
  expect(window.topSpacerRows).toBe(10)
  expect(pointIsMaterialized(window.blocks, point(target, 15))).toBe(true)
  expect(
    planTranscriptWindow({
      blocks,
      heights,
      viewportRows: 5,
      overscanRows: 2,
      attachment: {
        kind: "point",
        point: point(target),
        preferredScreenRow: 2,
        blockLocalRow: -1,
      },
    }).blocks,
  ).toBe(blocks)
})

test("negative semantic screen rows clamp the physical hint without abandoning bounded planning", () => {
  const blocks = Object.freeze(
    Array.from({ length: 40 }, (_, index) => item(`negative-row-${index}`)),
  )
  const heights = heightIndex(blocks)
  const target = blocks[20] as TranscriptItemBlock
  const window = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 5,
    overscanRows: 2,
    attachment: { kind: "point", point: point(target), preferredScreenRow: -3 },
  })

  expect(window.blocks).not.toBe(blocks)
  expect(window.blocks).toHaveLength(9)
  expect(window.topSpacerRows).toBe(18)
  expect(window.blocks[2]).toBe(target)
  expect(pointIsMaterialized(window.blocks, point(target))).toBe(true)
})

test("follow planning is trailing, overscan is monotonic, and tall final blocks remain mounted", () => {
  const blocks = Object.freeze([
    item("a"),
    item("b"),
    item("c"),
    activity("tail"),
  ])
  const heights = heightIndex(blocks, [2, 3, 8, 1])
  const narrow = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 4,
    overscanRows: 0,
    attachment: { kind: "tail" },
  })
  const wide = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 4,
    overscanRows: 6,
    attachment: { kind: "tail" },
  })
  expect(keys(narrow.blocks)).toEqual(keys(blocks.slice(2)))
  expect(keys(wide.blocks)).toEqual(keys(blocks.slice(1)))
  expect(wide.topSpacerRows).toBeLessThanOrEqual(narrow.topSpacerRows)
  expect(wide.bottomSpacerRows).toBe(0)
  expect(wide.blocks.at(-1)).toBe(blocks.at(-1))

  const tallTail = Object.freeze([item("history"), item("tall-tail")])
  const tallWindow = planTranscriptWindow({
    blocks: tallTail,
    heights: heightIndex(tallTail, [2, 20]),
    viewportRows: 5,
    overscanRows: 0,
    attachment: { kind: "tail" },
  })
  expect(tallWindow.blocks).toEqual([tallTail[1]!])
})

test("a far explicit reveal recenters a bounded window instead of mounting the bridge", () => {
  const blocks = Object.freeze(
    Array.from({ length: 40 }, (_, index) => item(`item-${index}`)),
  )
  const heights = heightIndex(blocks)
  const nearTail = blocks[35] as TranscriptItemBlock
  const far = blocks[2] as TranscriptItemBlock
  const ordinary = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 5,
    overscanRows: 2,
    attachment: {
      kind: "point",
      point: point(nearTail),
      preferredScreenRow: 2,
    },
  })
  const revealed = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 5,
    overscanRows: 2,
    attachment: {
      kind: "point",
      point: point(nearTail),
      preferredScreenRow: 2,
    },
    reveal: point(far),
  })
  expect(pointIsMaterialized(ordinary.blocks, point(nearTail))).toBe(true)
  expect(pointIsMaterialized(revealed.blocks, point(far))).toBe(true)
  expect(revealed.blocks.length).toBeLessThanOrEqual(9)
  expect(revealed.blocks).not.toContain(nearTail)
  expect(
    revealed.topSpacerRows + revealed.blocks.length + revealed.bottomSpacerRows,
  ).toBe(heights.totalRows)

  const before = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 5,
    overscanRows: 2,
    attachment: { kind: "point", point: point(far), preferredScreenRow: 2 },
  })
  const nearby = blocks[3] as TranscriptItemBlock
  const alreadyVisible = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 5,
    overscanRows: 2,
    attachment: { kind: "point", point: point(far), preferredScreenRow: 2 },
    reveal: point(nearby),
  })
  expect(alreadyVisible).toEqual(before)
})

test("mixed valid measurements and estimates determine exact conserved spacers", () => {
  const blocks = Object.freeze([
    item("a", 1),
    item("b", 2),
    item("c", 3),
    item("d", 1),
  ])
  const heights = createHeightIndex(blocks, [
    {
      blockKey: blockKey(blocks[0]!),
      contentRevision: blocks[0]!.contentRevision,
      rows: 5,
    },
    {
      blockKey: blockKey(blocks[2]!),
      contentRevision: blocks[2]!.contentRevision,
      rows: 4,
    },
    { blockKey: blockKey(blocks[3]!), contentRevision: 999, rows: 20 },
  ])
  if (!heights) throw new Error("Expected height index")
  expect(heights.totalRows).toBe(12)
  const window = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 3,
    overscanRows: 0,
    attachment: {
      kind: "point",
      point: point(blocks[2] as TranscriptItemBlock),
      preferredScreenRow: 0,
    },
  })
  expect(window.blocks).toEqual([blocks[2]!])
  expect(window.topSpacerRows).toBe(7)
  expect(window.bottomSpacerRows).toBe(1)
  expect(
    window.topSpacerRows +
      heights.rowRange(2, 3)!.rows +
      window.bottomSpacerRows,
  ).toBe(heights.totalRows)

  const unchanged = heights.replaceHeight({
    blockKey: blockKey(blocks[1]!),
    contentRevision: 999,
    rows: 8,
  })
  expect(unchanged).toBe(heights)
  const replaced = heights.replaceHeight({
    blockKey: blockKey(blocks[1]!),
    contentRevision: blocks[1]!.contentRevision,
    rows: 6,
  })
  expect(replaced.totalRows).toBe(16)
  expect(heights.totalRows).toBe(12)
})

test("source-less activity never owns targets while empty items and sub-block boundaries do", () => {
  const root = item("split", 1, "ab")
  const prefix: TranscriptItemBlock = Object.freeze({
    ...root,
    key: Object.freeze({ ...root.key, blockId: "part:0" }),
    sourceSpan: Object.freeze({ from: 0, to: 1 }),
  })
  const suffix: TranscriptItemBlock = Object.freeze({
    ...root,
    key: Object.freeze({ ...root.key, blockId: "part:1" }),
    sourceSpan: Object.freeze({ from: 1, to: 2 }),
  })
  const empty = item("empty", 1, "")
  const decoration = activity("decoration", 2)
  const blocks = Object.freeze([prefix, decoration, empty, suffix])
  const heights = heightIndex(blocks)

  const boundary = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 1,
    overscanRows: 0,
    attachment: { kind: "point", point: point(root, 1), preferredScreenRow: 0 },
  })
  expect(boundary.blocks).toEqual([suffix])
  const itemEnd = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 1,
    overscanRows: 0,
    attachment: { kind: "point", point: point(root, 2), preferredScreenRow: 0 },
  })
  expect(itemEnd.blocks).toEqual([suffix])
  const emptyWindow = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 1,
    overscanRows: 0,
    attachment: {
      kind: "point",
      point: point(empty, 0),
      preferredScreenRow: 0,
    },
  })
  expect(emptyWindow.blocks).toEqual([empty])
  const invalid = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 1,
    overscanRows: 0,
    attachment: {
      kind: "point",
      point: { itemId: itemId("decoration"), graphemeOffset: 0 },
      preferredScreenRow: 0,
    },
  })
  expect(invalid.blocks).toBe(blocks)
  expect(invalid).toEqual(passThroughWindow(blocks))

  const invalidReveal = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 1,
    overscanRows: 0,
    attachment: {
      kind: "point",
      point: point(empty, 0),
      preferredScreenRow: 0,
    },
    reveal: point(root, 3),
  })
  expect(invalidReveal.blocks).toBe(blocks)

  const overlap = Object.freeze([
    prefix,
    Object.freeze({ ...suffix, sourceSpan: Object.freeze({ from: 0, to: 2 }) }),
  ])
  const overlapWindow = planTranscriptWindow({
    blocks: overlap,
    heights: heightIndex(overlap),
    viewportRows: 1,
    overscanRows: 0,
    attachment: { kind: "point", point: point(root, 0), preferredScreenRow: 0 },
  })
  expect(overlapWindow.blocks).toBe(overlap)
})

test("a logical target among 100k same-item sub-blocks resolves logarithmically", () => {
  const count = 100_000
  const source = "x".repeat(count)
  const id = itemId("oversized-split-item")
  const projection = Object.freeze({
    plain: source,
    source,
    sourceSpans: Object.freeze(
      Array.from({ length: count }, (_, index) =>
        Object.freeze({ from: index, to: index + 1 }),
      ),
    ),
    links: Object.freeze([]),
    revision: 1,
  })
  const value = Object.freeze({
    id,
    turnId: turnId("split-turn"),
    kind: "assistant" as const,
    markdown: source,
    status: "complete" as const,
  })
  const blocks: readonly TranscriptBlock[] = Object.freeze(
    Array.from({ length: count }, (_, index): TranscriptItemBlock =>
      Object.freeze({
        key: Object.freeze({
          kind: "item" as const,
          itemId: id,
          blockId: `part:${index}`,
        }),
        turnId: value.turnId,
        item: value,
        renderItem: value,
        projection,
        sourceSpan: Object.freeze({ from: index, to: index + 1 }),
        contentRevision: 1,
        estimatedRows: 1,
        followedByActivity: false,
      }),
    ),
  )
  const heights = heightIndex(blocks)
  const target = 50_000
  const diagnostics = { targetLookupVisits: 0 }
  const window = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 30,
    overscanRows: 30,
    attachment: {
      kind: "point",
      point: { itemId: id, graphemeOffset: target },
      preferredScreenRow: 0,
    },
    diagnostics,
  })

  expect(window.blocks).toHaveLength(90)
  expect(window.topSpacerRows).toBe(target - 30)
  expect(window.blocks[30]).toBe(blocks[target])
  expect(
    window.blocks.every(
      (block, index) => block === blocks[target - 30 + index],
    ),
  ).toBe(true)
  expect(diagnostics.targetLookupVisits).toBeGreaterThan(0)
  expect(diagnostics.targetLookupVisits).toBeLessThanOrEqual(
    Math.ceil(Math.log2(count)) + 3,
  )
})

test("small exhaustive plans equal an independent linear oracle and conserve all rows", () => {
  const vectors = [[1], [1, 1, 1], [1, 3, 1, 3], [2, 3, 1, 4, 2, 1]] as const
  for (const rows of vectors) {
    const blocks = Object.freeze(
      rows.map((_, index) => item(`grid-${rows.length}-${index}`)),
    )
    const heights = heightIndex(blocks, rows)
    for (
      let viewportRows = 1;
      viewportRows <= heights.totalRows + 2;
      viewportRows++
    ) {
      for (let overscanRows = 0; overscanRows <= 3; overscanRows++) {
        const followExpected = expectedSlice(
          rows,
          viewportRows,
          overscanRows,
          "tail",
        )
        const follow = planTranscriptWindow({
          blocks,
          heights,
          viewportRows,
          overscanRows,
          attachment: { kind: "tail" },
        })
        expect(keys(follow.blocks)).toEqual(
          keys(blocks.slice(followExpected.first, followExpected.end)),
        )
        expect([follow.topSpacerRows, follow.bottomSpacerRows]).toEqual([
          followExpected.top,
          followExpected.bottom,
        ])

        for (let target = 0; target < blocks.length; target++) {
          const preferredScreenRow = target % viewportRows
          const expected = expectedSlice(rows, viewportRows, overscanRows, {
            index: target,
            preferredScreenRow,
          })
          const window = planTranscriptWindow({
            blocks,
            heights,
            viewportRows,
            overscanRows,
            attachment: {
              kind: "point",
              point: point(blocks[target] as TranscriptItemBlock),
              preferredScreenRow,
            },
          })
          expect(keys(window.blocks)).toEqual(
            keys(blocks.slice(expected.first, expected.end)),
          )
          expect([window.topSpacerRows, window.bottomSpacerRows]).toEqual([
            expected.top,
            expected.bottom,
          ])
          expect(
            window.blocks.every(
              (block, index) => block === blocks[expected.first + index],
            ),
          ).toBe(true)
          const mountedRows =
            heights.totalRows - window.topSpacerRows - window.bottomSpacerRows
          expect(
            window.topSpacerRows + mountedRows + window.bottomSpacerRows,
          ).toBe(heights.totalRows)
          expect(
            pointIsMaterialized(
              window.blocks,
              point(blocks[target] as TranscriptItemBlock),
            ),
          ).toBe(true)
          expect(Object.isFrozen(window)).toBe(true)
          expect(Object.isFrozen(window.blocks)).toBe(true)
        }
      }
    }
  }
})

test("a 100k follow plan remains bounded and preserves original block identities", () => {
  const blocks = Object.freeze(
    Array.from({ length: 100_000 }, (_, index) => activity(`large-${index}`)),
  )
  const heights = heightIndex(blocks)
  const window = planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 30,
    overscanRows: 30,
    attachment: { kind: "tail" },
  })
  expect(window.blocks).toHaveLength(60)
  expect(window.topSpacerRows).toBe(99_940)
  expect(window.bottomSpacerRows).toBe(0)
  expect(window.blocks[0]).toBe(blocks[99_940])
  expect(window.blocks.at(-1)).toBe(blocks.at(-1))
})
