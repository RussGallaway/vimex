import { describe, expect, test } from "bun:test"
import { itemId } from "@vimex/conversation"
import { composeTranscriptGeometry, graphemeCount, initialTranscript, projectMarkdown, type BlockGeometry, type TranscriptGeometry, type TranscriptState } from "@vimex/transcript"
import { blockRefForPoint, buildTranscriptLayout, graphemeCellWidth, movePoint, pointInLayout, selectedRangeForItem, type TranscriptLayout } from "./layout"
import { rebaseTranscriptLayout, visibleMeasuredPoints } from "./rendered-layout"

const first = itemId("first")
const second = itemId("second")
const third = itemId("third")

function stateFor(firstText: string, secondText = ""): TranscriptState {
  return {
    ...initialTranscript(),
    order: secondText ? [first, second] : [first],
    projectionById: {
      [first]: { ...projectMarkdown(firstText), revision: 1 },
      ...(secondText ? { [second]: { ...projectMarkdown(secondText), revision: 1 } } : {}),
    },
  }
}

describe("transcript visual layout", () => {
  test("maps vertical motions to exact grapheme offsets across wrapped rows", () => {
    const layout = buildTranscriptLayout(stateFor("abcdEFGH"), 4)
    expect(layout.lines).toEqual([
      { itemId: first, from: 0, to: 3, row: 0 },
      { itemId: first, from: 4, to: 8, row: 1 },
    ])
    expect(movePoint(layout, { itemId: first, graphemeOffset: 2 }, "down")).toEqual({
      point: { itemId: first, graphemeOffset: 6 }, preferredScreenRow: 1,
    })
    expect(movePoint(layout, { itemId: first, graphemeOffset: 6 }, "up")).toEqual({
      point: { itemId: first, graphemeOffset: 2 }, preferredScreenRow: 0,
    })
    expect(movePoint(layout, { itemId: first, graphemeOffset: 2 }, "line-end")?.point.graphemeOffset).toBe(3)
    expect(movePoint(layout, { itemId: first, graphemeOffset: 3 }, "right")?.point.graphemeOffset).toBe(4)
  })

  test("counts emoji as one logical point while respecting its terminal width", () => {
    const layout = buildTranscriptLayout(stateFor("a🙂bc"), 3)
    expect(layout.lines).toEqual([
      { itemId: first, from: 0, to: 1, row: 0 },
      { itemId: first, from: 2, to: 4, row: 1 },
    ])
    expect(movePoint(layout, { itemId: first, graphemeOffset: 1 }, "right")?.point.graphemeOffset).toBe(2)
  })

  test("assigns newline cursor positions to the following logical row", () => {
    const layout = buildTranscriptLayout(stateFor("ab\ncd"), 20)
    expect(layout.lines).toEqual([
      { itemId: first, from: 0, to: 1, row: 0 },
      { itemId: first, from: 2, to: 5, row: 1 },
    ])
    expect(movePoint(layout, { itemId: first, graphemeOffset: 1 }, "right")?.point.graphemeOffset).toBe(2)
  })

  test("projects character and whole-line selections across items", () => {
    const base = stateFor("one\ntwo", "three")
    const character: TranscriptState = {
      ...base,
      selection: { anchor: { itemId: first, graphemeOffset: 5 }, head: { itemId: second, graphemeOffset: 1 }, shape: "character" },
    }
    expect(selectedRangeForItem(character, first)).toEqual({ from: 5, to: 7 })
    expect(selectedRangeForItem(character, second)).toEqual({ from: 0, to: 2 })
    const line: TranscriptState = {
      ...base,
      selection: { anchor: { itemId: first, graphemeOffset: 5 }, head: { itemId: first, graphemeOffset: 5 }, shape: "line" },
    }
    expect(selectedRangeForItem(line, first)).toEqual({ from: 4, to: 7 })
  })
})


test("combining marks do not erase the terminal width of their base grapheme", () => {
  expect(graphemeCellWidth("é")).toBe(1)
  expect(graphemeCellWidth("界́")).toBe(2)
  expect(graphemeCellWidth("́")).toBe(0)
  expect(buildTranscriptLayout(stateFor("éabc"), 2).lines).toEqual([
    { itemId: first, from: 0, to: 1, row: 0 },
    { itemId: first, from: 2, to: 4, row: 1 },
  ])
})

test("uses terminal cell widths for flags, keycaps, and supplementary CJK", () => {
  expect(graphemeCellWidth("🇺🇸")).toBe(2)
  expect(graphemeCellWidth("1️⃣")).toBe(2)
  expect(graphemeCellWidth("𠀀")).toBe(2)
})

test("estimated geometry keeps folded content on one visual row", () => {
  const state = stateFor("one two three four")
  const folded = { ...state, folded: { [first]: true } }
  expect(buildTranscriptLayout(folded, 4).lines).toEqual([
    { itemId: first, from: 0, to: graphemeCount("one two three four"), row: 0 },
  ])
})

test("measured row navigation stays column-aware and builds a fresh index after reflow", () => {
  const make = (column: number) => ({ ...buildTranscriptLayout(stateFor("abcd"), 2), points: {
    [first]: {
      0: { itemId: first, graphemeOffset: 0, row: 0, column: 0, screenX: 0, screenY: 0 },
      1: { itemId: first, graphemeOffset: 1, row: 0, column: 1, screenX: 1, screenY: 0 },
      2: { itemId: first, graphemeOffset: 2, row: 1, column, screenX: column, screenY: 1 },
      3: { itemId: first, graphemeOffset: 3, row: 1, column: 1, screenX: 1, screenY: 1 },
    },
  } })
  const firstLayout = make(0)
  expect(movePoint(firstLayout, { itemId: first, graphemeOffset: 0 }, "down")?.point.graphemeOffset).toBe(2)
  expect(movePoint(firstLayout, { itemId: first, graphemeOffset: 1 }, "down")?.point.graphemeOffset).toBe(3)
  expect(movePoint(make(4), { itemId: first, graphemeOffset: 0 }, "down")?.point.graphemeOffset).toBe(3)
})


test("measured inclusive row endpoints retain their own row for horizontal motions", () => {
  const layout = { ...buildTranscriptLayout(stateFor("abcd"), 2), lines: [
    { itemId: first, from: 0, to: 1, row: 0 },
    { itemId: first, from: 2, to: 3, row: 1 },
  ], points: { [first]: {
    1: { itemId: first, graphemeOffset: 1, row: 0, column: 1, screenX: 1, screenY: 0 },
  } } }
  layout.linesByItem = { [first]: layout.lines }
  const point = { itemId: first, graphemeOffset: 1 }
  expect(movePoint(layout, point, "left")?.point.graphemeOffset).toBe(0)
  expect(movePoint(layout, point, "line-start")?.point.graphemeOffset).toBe(0)
  expect(movePoint(layout, point, "line-end")?.point.graphemeOffset).toBe(1)
})

test("zero-row activity children cannot disturb visible-point ordering", () => {
  const geometryFor = (blockKey: string, rows: number): BlockGeometry => ({
    key: { blockKey, contentRevision: 1, width: 80, styleRevision: "test", folded: true,
      ...(rows === 0 ? { presentation: "activity-hidden" as const } : {}) },
    nativeRevision: 1,
    rows,
    points: rows ? { 0: { graphemeOffset: 0, x: 0, y: 0, row: 0, column: 0 } } : {},
    lines: rows ? [{ from: 0, to: 0, row: 0 }] : [],
  })
  const keys = ["item:first:root", "item:second:root", "item:third:root"]
  const geometries = [geometryFor(keys[0]!, 1), geometryFor(keys[1]!, 0), geometryFor(keys[2]!, 1)]
  const geometry: TranscriptGeometry = {
    generation: 0, revision: 1, width: 80, styleRevision: "test",
    byBlockKey: Object.fromEntries(geometries.map(value => [value.key.blockKey, value])),
    rowByBlockKey: { [keys[0]!]: 0, [keys[1]!]: 1, [keys[2]!]: 1 },
    blockRows: [
      { blockKey: keys[0]!, itemId: first, start: 0, rows: 1 },
      { blockKey: keys[1]!, itemId: second, start: 1, rows: 0 },
      { blockKey: keys[2]!, itemId: third, start: 1, rows: 1 },
    ],
    totalRows: 2, measuredBlockCount: 3, totalPoints: 2,
  }
  const base: TranscriptLayout = {
    width: 80, lines: [], linesByItem: {},
    placementByBlockKey: {
      [keys[0]!]: { screenX: 0, screenY: 10 },
      // A layout-disabled native child may report an unrelated origin.
      [keys[1]!]: { screenX: 0, screenY: 0 },
      [keys[2]!]: { screenX: 0, screenY: 11 },
    },
    blockKeysByItem: {
      [first]: [{ blockKey: keys[0]!, from: 0, to: 0 }],
      [second]: [{ blockKey: keys[1]!, from: 0, to: 0 }],
      [third]: [{ blockKey: keys[2]!, from: 0, to: 0 }],
    },
  }
  const rebased = rebaseTranscriptLayout(base, geometry)
  expect(rebased.screenBlockRows?.map(row => row.itemId)).toEqual([first, third])
  expect(visibleMeasuredPoints(rebased, { screenY: 10, height: 2 }).map(point => point.itemId)).toEqual([first, third])
})

test("block-local geometry composes navigation without cloning historical points", () => {
  const make = (id: typeof first, text: string, rows: readonly (readonly number[])[]): BlockGeometry => {
    const points = Object.fromEntries(rows.flatMap((offsets, row) => offsets.map((offset, column) => [offset, {
      graphemeOffset: offset, x: column, y: row, row, column,
    }])))
    return Object.freeze({
      key: Object.freeze({ blockKey: `item:${id}:root`, contentRevision: 1, width: 10, styleRevision: "test", folded: false }),
      nativeRevision: 1,
      rows: rows.length,
      points: Object.freeze(points),
      lines: Object.freeze(rows.map((offsets, row) => Object.freeze({ from: offsets[0]!, to: offsets.at(-1)!, row }))),
    })
  }
  const state = stateFor("abcd", "ef")
  const firstGeometry = make(first, "abcd", [[0, 1], [2, 3]])
  const secondGeometry = make(second, "ef", [[0, 1]])
  const blocks = [
    { key: { kind: "item" as const, itemId: first, blockId: "root" }, contentRevision: 1, estimatedRows: 1 },
    { key: { kind: "item" as const, itemId: second, blockId: "root" }, contentRevision: 1, estimatedRows: 1 },
  ] as never
  const geometry = composeTranscriptGeometry(blocks, state.folded, {
    [`item:${first}:root`]: firstGeometry,
    [`item:${second}:root`]: secondGeometry,
  }, 0, 1, 10, "test")
  const layout = {
    width: 10, lines: [], linesByItem: {}, geometry,
    blockKeyByItem: { [first]: `item:${first}:root`, [second]: `item:${second}:root` },
    placementByBlockKey: {
      [`item:${first}:root`]: { screenX: 4, screenY: 8 },
      [`item:${second}:root`]: { screenX: 4, screenY: 10 },
    },
  }
  expect(movePoint(layout, { itemId: first, graphemeOffset: 1 }, "down")?.point).toEqual({ itemId: first, graphemeOffset: 3 })
  expect(movePoint(layout, { itemId: first, graphemeOffset: 3 }, "down")?.point).toEqual({ itemId: second, graphemeOffset: 1 })
  expect(movePoint(layout, { itemId: second, graphemeOffset: 0 }, "first")?.point).toEqual({ itemId: first, graphemeOffset: 0 })
  expect(geometry.byBlockKey[`item:${first}:root`]!.points).toBe(firstGeometry.points)
})

test("one semantic item navigates across multiple render blocks", () => {
  const make = (blockId: string, offsets: readonly number[]): BlockGeometry => Object.freeze({
    key: Object.freeze({ blockKey: `item:${first}:${blockId}`, contentRevision: 1, width: 10, styleRevision: "test", folded: false }),
    nativeRevision: 1,
    rows: 1,
    pointCount: offsets.length,
    points: Object.freeze(Object.fromEntries(offsets.map((offset, column) => [offset, Object.freeze({
      graphemeOffset: offset, x: column, y: 0, row: 0, column,
    })]))),
    pointOffsetsByRow: Object.freeze({ 0: Object.freeze([...offsets]) }),
    lines: Object.freeze([Object.freeze({ from: offsets[0]!, to: offsets.at(-1)!, row: 0 })]),
    lineByRow: Object.freeze({ 0: Object.freeze({ from: offsets[0]!, to: offsets.at(-1)!, row: 0 }) }),
  })
  const state = stateFor("abcdef")
  const firstBlock = { key: { kind: "item" as const, itemId: first, blockId: "a" }, contentRevision: 1, estimatedRows: 1 }
  const secondBlock = { key: { kind: "item" as const, itemId: first, blockId: "b" }, contentRevision: 1, estimatedRows: 1 }
  const a = make("a", [0, 1, 2])
  const b = make("b", [3, 4, 5])
  const geometry = composeTranscriptGeometry([firstBlock, secondBlock] as never, state.folded, {
    [`item:${first}:a`]: a,
    [`item:${first}:b`]: b,
  }, 0, 1, 10, "test")
  const layout = {
    width: 10,
    lines: [],
    linesByItem: {},
    geometry,
    blockKeysByItem: { [first]: [
      { blockKey: `item:${first}:a`, blockId: "a", from: 0, to: 3 },
      { blockKey: `item:${first}:b`, blockId: "b", from: 3, to: 6 },
    ] },
    placementByBlockKey: {
      [`item:${first}:a`]: { screenX: 0, screenY: 0 },
      [`item:${first}:b`]: { screenX: 0, screenY: 1 },
    },
  }
  expect(movePoint(layout, { itemId: first, graphemeOffset: 1 }, "down")?.point).toEqual({ itemId: first, graphemeOffset: 4 })
  expect(movePoint(layout, { itemId: first, graphemeOffset: 2 }, "right")?.point).toEqual({ itemId: first, graphemeOffset: 3 })
  expect(movePoint(layout, { itemId: first, graphemeOffset: 3 }, "left")?.point).toEqual({ itemId: first, graphemeOffset: 2 })
  expect(blockRefForPoint(layout, { itemId: first, graphemeOffset: 3 })?.blockId).toBe("b")
  expect(pointInLayout(layout, { itemId: first, graphemeOffset: 4 })?.screenY).toBe(1)
})
