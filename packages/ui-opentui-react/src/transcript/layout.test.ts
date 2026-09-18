import { describe, expect, test } from "bun:test"
import { itemId } from "@vimex/conversation"
import { initialTranscript, projectMarkdown, type TranscriptState } from "@vimex/transcript"
import { buildTranscriptLayout, graphemeCellWidth, movePoint, selectedRangeForItem } from "./layout"

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
      { itemId: first, from: 0, to: 4, row: 0 },
      { itemId: first, from: 4, to: 8, row: 1 },
    ])
    expect(movePoint(layout, { itemId: first, graphemeOffset: 2 }, "down")).toEqual({
      point: { itemId: first, graphemeOffset: 6 }, preferredScreenRow: 1,
    })
    expect(movePoint(layout, { itemId: first, graphemeOffset: 6 }, "up")).toEqual({
      point: { itemId: first, graphemeOffset: 2 }, preferredScreenRow: 0,
    })
  })

  test("counts emoji as one logical point while respecting its terminal width", () => {
    const layout = buildTranscriptLayout(stateFor("a🙂bc"), 3)
    expect(layout.lines).toEqual([
      { itemId: first, from: 0, to: 2, row: 0 },
      { itemId: first, from: 2, to: 4, row: 1 },
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
    { itemId: first, from: 0, to: 2, row: 0 },
    { itemId: first, from: 2, to: 4, row: 1 },
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
