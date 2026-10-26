import { expect, test } from "bun:test"
import { itemId } from "@vimex/conversation"
import { assistantMessage as message } from "@vimex/testkit"
import {
  adjacentSearchMatch,
  findSearchMatches,
  initialTranscript,
  moveCursor,
  syncTranscriptItem,
} from "./index"

test("repeated search navigation reuses discovery without reading transcript items", () => {
  let state = syncTranscriptItem(initialTranscript(), message("a", "aaa"))
  state = syncTranscriptItem(state, message("b", "aa"))
  let reads = 0
  state = {
    ...state,
    projectionById: new Proxy(state.projectionById, {
      get(target, key, receiver) {
        reads++
        return Reflect.get(target, key, receiver)
      },
    }),
  }
  const matches = findSearchMatches(state, "aa")
  expect(reads).toBeGreaterThan(0)
  state = moveCursor(state, matches[0]!.from)
  reads = 0
  const repeated = findSearchMatches(state, "aa", { caseSensitive: false })
  expect(repeated).toBe(matches)
  expect(reads).toBe(0)
  expect(adjacentSearchMatch(state, repeated, "forward")?.from).toEqual({
    itemId: itemId("a"),
    graphemeOffset: 1,
  })
  expect(
    adjacentSearchMatch(state, repeated, "backward", matches[0]!.from)?.from,
  ).toEqual({ itemId: itemId("b"), graphemeOffset: 0 })
})

test("streaming revisions and changed order invalidate cached discovery", () => {
  let state = syncTranscriptItem(initialTranscript(), message("a", "old"))
  const missing = findSearchMatches(state, "needle")
  expect(missing).toEqual([])
  state = syncTranscriptItem(state, message("a", "old needle"))
  const streamed = findSearchMatches(state, "needle")
  expect(streamed).not.toBe(missing)
  expect(streamed.map((match) => match.from)).toEqual([
    { itemId: itemId("a"), graphemeOffset: 4 },
  ])
  state = syncTranscriptItem(state, message("b", "needle"))
  expect(
    findSearchMatches(state, "needle").map((match) => match.itemId),
  ).toEqual([itemId("a"), itemId("b")])
  const reordered = { ...state, order: [...state.order].reverse() }
  expect(
    findSearchMatches(reordered, "needle").map((match) => match.itemId),
  ).toEqual([itemId("b"), itemId("a")])
  expect(
    findSearchMatches({ ...state, order: [itemId("b")] }, "needle").map(
      (match) => match.itemId,
    ),
  ).toEqual([itemId("b")])
})

test("cached queries preserve case, overlapping matches, and grapheme boundaries", () => {
  const state = syncTranscriptItem(
    initialTranscript(),
    message("a", "AaA 👨‍👩‍👧‍👦 e\u0301e\u0301"),
  )
  const insensitive = findSearchMatches(state, "aa")
  const sensitive = findSearchMatches(state, "aa", { caseSensitive: true })
  expect(insensitive.map((match) => match.from.graphemeOffset)).toEqual([0, 1])
  expect(sensitive).toEqual([])
  const family = findSearchMatches(state, "👨‍👩‍👧‍👦")
  expect(family[0]?.from.graphemeOffset).toBe(4)
  expect(family[0]?.to.graphemeOffset).toBe(5)
  const combining = findSearchMatches(state, "e\u0301")
  expect(combining.map((match) => match.from.graphemeOffset)).toEqual([6, 7])
  expect(findSearchMatches(state, "aa")).toBe(insensitive)
  expect(findSearchMatches(state, "aa", { caseSensitive: true })).toBe(
    sensitive,
  )
  expect(findSearchMatches(state, "👨‍👩‍👧‍👦")).toBe(family)
  expect(findSearchMatches(state, "e\u0301")).toBe(combining)
})

test("query retention is bounded and shared results cannot be mutated", () => {
  const state = syncTranscriptItem(initialTranscript(), message("a", "needle"))
  const original = findSearchMatches(state, "needle")
  expect(Object.isFrozen(original)).toBe(true)
  expect(Object.isFrozen(original[0])).toBe(true)
  expect(Object.isFrozen(original[0]!.from)).toBe(true)
  expect(Object.isFrozen(original[0]!.to)).toBe(true)
  for (let index = 0; index < 20; index++)
    findSearchMatches(state, `missing-${index}`)
  const rediscovered = findSearchMatches(state, "needle")
  expect(rediscovered).toEqual(original)
  expect(rediscovered).not.toBe(original)
})

test("oversized match sets and matched text remain complete but uncached", () => {
  for (const [source, query, count] of [
    ["a".repeat(10_001), "a", 10_001],
    ["a".repeat(2_000), "a".repeat(1_000), 1_001],
  ] as const) {
    const state = syncTranscriptItem(
      initialTranscript(),
      message("large", source),
    )
    const first = findSearchMatches(state, query)
    const second = findSearchMatches(state, query)
    expect(first).toHaveLength(count)
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
  }
})
