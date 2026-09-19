import { describe, expect, test } from "bun:test"
import { itemId } from "@vimex/conversation"
import { composeTranscriptGeometry, graphemeCount, initialTranscript, projectMarkdown, transcriptOrderIndex, type BlockGeometry, type TranscriptState } from "@vimex/transcript"
import { blockRefForPoint, buildTranscriptLayout, graphemeCellWidth, movePoint, pointInLayout, selectedRangeForItem } from "./layout"

const first = itemId("first")
const second = itemId("second")

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

  test("reuses a 100k logical-order index for bounded mounted selection checks", () => {
    const ids = Object.freeze(Array.from({ length: 100_000 }, (_, index) => itemId(`indexed-${index}`)))
    const order = new Proxy(ids, { get(target, property, receiver) {
      if (property === "indexOf") return () => { throw new Error("selection lookup scanned logical order") }
      return Reflect.get(target, property, receiver)
    } })
    const start = order[50_000]!, end = order[50_047]!
    const projection = { ...projectMarkdown("x"), revision: 1 }
    const state: TranscriptState = {
      ...initialTranscript(), order,
      projectionById: Object.fromEntries(order.slice(50_000, 50_048).map(id => [id, projection])),
      selection: { anchor: { itemId: start, graphemeOffset: 0 }, head: { itemId: end, graphemeOffset: 0 }, shape: "character" },
    }
    const index = transcriptOrderIndex(order)
    expect(index.size).toBe(100_000)
    expect(order.slice(50_000, 50_048).filter(id => selectedRangeForItem(state, id))).toHaveLength(48)
    expect(transcriptOrderIndex(order)).toBe(index)
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
