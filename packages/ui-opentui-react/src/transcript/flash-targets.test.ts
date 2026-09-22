import { expect, test } from "bun:test"
import { itemId } from "@vimex/conversation"
import {
  initialTranscript,
  projectPlainText,
  graphemes,
} from "@vimex/transcript"
import { flashTargets } from "./flash-targets"
import type { TranscriptLayout, MeasuredPoint } from "./layout"

function fixture(text: string) {
  const id = itemId("flash")
  const state = {
    ...initialTranscript(),
    order: [id],
    projectionById: { [id]: { ...projectPlainText(text), revision: 1 } },
  }
  const points = Object.fromEntries(
    graphemes(text).map((_, i) => [
      i,
      {
        itemId: id,
        graphemeOffset: i,
        row: 0,
        column: i,
        screenX: i,
        screenY: 2,
      },
    ]),
  ) as Record<number, MeasuredPoint>
  const layout: TranscriptLayout = {
    width: 200,
    lines: [],
    linesByItem: {},
    points: { [id]: points },
  }
  return {
    state,
    layout,
    points,
    viewport: { screenX: 0, screenY: 1, width: 200, height: 3 },
  }
}

test("Flash labels never consume a valid search continuation; Unicode offsets stay logical", () => {
  const f = fixture("alpha alpha 界é alpha")
  const result = flashTargets(f.state, f.layout, f.viewport, "a")
  expect(result.matches).toHaveLength(6)
  expect(result.labels.some((target) => target.label === "l")).toBe(false)
  expect(
    flashTargets(f.state, f.layout, f.viewport, "界é").matches[0]
      ?.graphemeOffset,
  ).toBe(12)
  expect(
    flashTargets(f.state, f.layout, f.viewport, "Alpha").matches,
  ).toHaveLength(0)
})

test("Flash excludes offscreen and collapsed fallback text and pages labels without duplicates", () => {
  const f = fixture("word ".repeat(40))
  for (let i = 0; i < 4; i++) f.points[i]!.hidden = true
  f.points[5]!.screenY = 20
  const first = flashTargets(f.state, f.layout, f.viewport, "word")
  expect(first.matches).toHaveLength(38)
  expect(first.pages).toBe(2)
  const second = flashTargets(f.state, f.layout, f.viewport, "word", 1)
  expect(
    new Set(
      [...first.labels, ...second.labels].map((point) => point.graphemeOffset),
    ).size,
  ).toBe(38)
  expect(
    flashTargets(
      f.state,
      { ...f.layout, screenOffset: { x: 0, y: 20 } },
      f.viewport,
      "word",
    ).matches,
  ).toHaveLength(0)
})
