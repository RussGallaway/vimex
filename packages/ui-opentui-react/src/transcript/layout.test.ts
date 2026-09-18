import { describe, expect, test } from "bun:test"
import { itemId } from "@vimex/conversation"
import { initialTranscript, projectMarkdown, type TranscriptState } from "@vimex/transcript"
import { buildTranscriptLayout, movePoint, selectedRangeForItem } from "./layout"

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
