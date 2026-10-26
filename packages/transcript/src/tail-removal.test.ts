import { expect, test } from "bun:test"
import { itemId, turnId } from "@vimex/conversation"
import {
  appendTranscriptOrder,
  initialTranscript,
  persistentTranscriptOrder,
  persistentTranscriptProjections,
  popTranscriptOrder,
  removeTranscriptItem,
  removeTranscriptProjection,
  setTranscriptProjection,
  syncTranscriptItem,
  transcriptOrderIndex,
  transcriptOrderTailRemoval,
  transcriptOrderTailReplacement,
  transcriptTextLengthRange,
  type TextProjection,
} from "./index"

test("tail removal and replacement retain the warm historical text-length index", () => {
  const ids = Array.from({ length: 10_000 }, (_, i) => itemId(`item-${i}`))
  const projection: TextProjection = {
    plain: "x",
    source: "x",
    sourceSpans: [{ from: 0, to: 1 }],
    links: [],
    revision: 1,
  }
  const state = {
    ...initialTranscript(),
    order: persistentTranscriptOrder(ids),
    projectionById: persistentTranscriptProjections(
      Object.fromEntries(ids.map((id) => [id, projection])),
    ),
  }
  expect(transcriptTextLengthRange(state, 0, ids.length)).toBe(ids.length)
  const next = removeTranscriptItem(state, ids.at(-1)!)
  const diagnostics = {
    textLengthIndexBuilds: 0,
    textLengthItemVisits: 0,
    textLengthIndexCacheHits: 0,
    textLengthIndexUpdates: 0,
    textLengthNodeVisits: 0,
  }
  expect(
    transcriptTextLengthRange(next, 0, next.order.length, diagnostics),
  ).toBe(ids.length - 1)
  expect(diagnostics.textLengthIndexBuilds).toBe(0)
  expect(diagnostics.textLengthItemVisits).toBe(0)
  const replaced = syncTranscriptItem(next, {
    id: itemId("echo"),
    turnId: turnId("turn"),
    kind: "user",
    markdown: "xyz",
    status: "complete",
  })
  expect(
    transcriptTextLengthRange(replaced, 0, replaced.order.length, diagnostics),
  ).toBe(ids.length + 2)
  expect(diagnostics.textLengthIndexBuilds).toBe(0)
  expect(transcriptTextLengthRange(state, 0, ids.length)).toBe(ids.length)
})

test("persistent tail removal preserves historical snapshots and exact indexes across tree boundaries", () => {
  const ids = Array.from({ length: 4097 }, (_, i) => itemId(`item-${i}`))
  let order = persistentTranscriptOrder(ids)
  const original = order
  for (let size = ids.length; size > 0; size--) {
    const before = order
    order = popTranscriptOrder(order)
    expect(order.length).toBe(size - 1)
    expect(order.at(-1)).toBe(ids[size - 2])
    expect(transcriptOrderIndex(order).get(ids[size - 1]!)).toBeUndefined()
    if (size > 1)
      expect(transcriptOrderIndex(order).get(ids[size - 2]!)).toBe(size - 2)
    expect(transcriptOrderTailRemoval(before, order)).toBe(ids[size - 1])
    expect(before.at(-1)).toBe(ids[size - 1])
  }
  expect(popTranscriptOrder(order)).toBe(order)
  expect([...original]).toEqual(ids)
  const reappended = appendTranscriptOrder(order, ids[0]!)
  expect(transcriptOrderIndex(reappended).get(ids[0]!)).toBe(0)
  expect(transcriptOrderTailRemoval(original, reappended)).toBeUndefined()
  const replacement = appendTranscriptOrder(
    popTranscriptOrder(original),
    itemId("replacement"),
  )
  expect(transcriptOrderTailReplacement(original, replacement)).toEqual({
    removed: ids.at(-1)!,
    added: itemId("replacement"),
  })
  expect(transcriptOrderTailReplacement(original, reappended)).toBeUndefined()
})

test("projection deletion path-copies balanced records and preserves reflection and old values", () => {
  const projection: TextProjection = {
    plain: "hello",
    source: "hello",
    sourceSpans: [],
    links: [],
    revision: 1,
  }
  const keys = [
    ...Array.from({ length: 257 }, (_, i) => `item-${i}`),
    "__proto__",
    "constructor",
  ]
  let record = persistentTranscriptProjections(
    Object.fromEntries(keys.map((key) => [key, projection])),
  )
  const original = record
  // A deterministic permutation exercises both branches and two-child deletion.
  for (const key of keys
    .filter((_, i) => i % 2 === 0)
    .concat(keys.filter((_, i) => i % 2 !== 0))) {
    const before = record
    record = removeTranscriptProjection(record, itemId(key))
    expect(record[key]).toBeUndefined()
    expect(Object.hasOwn(record, key)).toBe(false)
    expect(before[key]).toBe(projection)
  }
  expect(Object.keys(record)).toEqual([])
  expect(JSON.stringify(record)).toBe("{}")
  expect(Object.keys(original)).toHaveLength(keys.length)
  record = setTranscriptProjection(record, itemId("constructor"), projection)
  expect(record.constructor).toBe(projection as never)
  const empty = {}
  expect(removeTranscriptProjection(empty, itemId("constructor"))).toBe(empty)
  expect(removeTranscriptProjection(empty, itemId("__proto__"))).toBe(empty)
})

test("duplicate orders retain pop indexes and semantic removal still removes every occurrence", () => {
  const a = itemId("a"),
    b = itemId("b")
  const order = popTranscriptOrder(persistentTranscriptOrder([a, b, a]))
  expect([...order]).toEqual([a, b])
  expect(transcriptOrderIndex(order).get(a)).toBe(0)
  expect(transcriptOrderIndex(order).get(b)).toBe(1)
  const projection: TextProjection = {
    plain: "",
    source: "",
    sourceSpans: [],
    links: [],
    revision: 1,
  }
  const state = {
    ...initialTranscript(),
    order: persistentTranscriptOrder([a, b, a]),
    projectionById: persistentTranscriptProjections({
      a: projection,
      b: projection,
    }),
  }
  expect([...removeTranscriptItem(state, a).order]).toEqual([b])
  const empty = { ...initialTranscript(), projectionById: {} }
  expect(removeTranscriptItem(empty, itemId("constructor"))).toBe(empty)
})

test("removing a pending tail preserves history, drops dangling selection, and restores cursor", () => {
  const add = (id: string) => ({
    id: itemId(id),
    turnId: turnId("turn"),
    kind: "user" as const,
    markdown: id,
    status: "complete" as const,
  })
  const history = syncTranscriptItem(initialTranscript(), add("history"))
  const tail = syncTranscriptItem(history, add("pending"))
  const point = { itemId: itemId("pending"), graphemeOffset: 1 }
  const next = removeTranscriptItem(
    {
      ...tail,
      cursor: point,
      selection: { anchor: point, head: point, shape: "character" },
      viewport: { kind: "point", point, preferredScreenRow: 2 },
    },
    itemId("pending"),
  )
  expect([...next.order]).toEqual([itemId("history")])
  expect(next.projectionById.history).toBe(history.projectionById.history)
  expect(next.folded).toBe(tail.folded)
  expect(next.cursor).toEqual({ itemId: itemId("history"), graphemeOffset: 0 })
  expect(next.selection).toBeUndefined()
  expect(next.viewport).toEqual({
    kind: "point",
    point: next.cursor!,
    preferredScreenRow: 2,
  })
  expect(tail.projectionById.pending).toBeDefined()
})
