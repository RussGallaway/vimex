import { expect, test } from "bun:test"
import { discardPendingRepeats } from "./repeat-control"

test("release drops only unstarted repeats and preserves the active remainder", () => {
  const active = { sequence: 1, repeatKey: "u" as const, rows: -2 }
  const deliberate = { sequence: 2, rows: -7 }
  const pending = { sequence: 3, repeatKey: "u" as const, rows: -7 }
  const opposite = { sequence: 4, repeatKey: "d" as const, rows: 7 }
  expect(
    discardPendingRepeats([active, deliberate, pending, opposite], 1, "u"),
  ).toEqual([active, deliberate, opposite])
  expect(
    discardPendingRepeats([active, deliberate, pending, opposite], 1),
  ).toEqual([active, deliberate])
})

test("an absent active sequence does not protect unstarted repeat work", () => {
  const deliberate = { rows: -3, sequence: undefined }
  const repeat = { repeatKey: "u" as const, rows: -7 }
  expect(discardPendingRepeats([deliberate, repeat], undefined)).toEqual([
    deliberate,
  ])
})
