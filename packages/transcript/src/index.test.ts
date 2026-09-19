import { describe, expect, test } from "bun:test"
import { itemId, threadId, turnId, type ConversationItem } from "@vimex/conversation"
import { appendTranscriptOrder, attachTail, beginSelection, findSearchMatches, graphemeCount, initialTranscript, moveCursor, persistentTranscriptFolds, persistentTranscriptOrder, persistentTranscriptProjections, projectItem, reduceTranscript, selectedGraphemeCount, selectedText, setFold, setTranscriptFoldValue, setTranscriptProjection, syncTranscriptItem, transcriptOrderAppend, transcriptOrderIndex, transcriptTextLengthRange, urlAt } from "./index"

import { assistantMessage as message } from "@vimex/testkit"

describe("transcript", () => {
  test("keeps tail attached and counts each unseen entry once while pinned", () => {
    let state = syncTranscriptItem(initialTranscript(), message("one", "one"))
    expect(state.viewport.kind).toBe("tail")
    state = moveCursor(state, { itemId: itemId("one"), graphemeOffset: 1 }, 7)
    const anchor = state.viewport
    state = syncTranscriptItem(state, message("two", "a", "running"))
    state = syncTranscriptItem(state, message("two", "abc", "running"))
    expect(state.unseenEntries).toBe(1)
    expect(state.viewport).toEqual(anchor)
    expect(attachTail(state)).toMatchObject({ viewport: { kind: "tail" }, unseenEntries: 0 })
  })

  test("counts changed output from an existing streaming item once while detached", () => {
    let state = syncTranscriptItem(initialTranscript(), message("stream", "first", "running"))
    state = moveCursor(state, { itemId: itemId("stream"), graphemeOffset: 0 })
    state = syncTranscriptItem(state, message("stream", "first\nsecond", "running"))
    expect(state.unseenEntries).toBe(1)
    state = syncTranscriptItem(state, message("stream", "first\nsecond\nthird", "running"))
    expect(state.unseenEntries).toBe(1)
    state = attachTail(state)
    expect(state.unseenItemIds).toEqual([])
  })

  test("projects Markdown with exact source mapping and URL ranges", () => {
    const projection = projectItem(message("m", "# Hello **brave** [world](https://example.test) 👨‍👩‍👧‍👦"))
    expect(projection.plain).toBe("Hello brave world 👨‍👩‍👧‍👦")
    const world = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(projection.plain)].findIndex((part) => part.segment === "w")
    expect(projection.links[0]).toMatchObject({ from: world, url: "https://example.test" })
    expect(projection.source.slice(projection.sourceSpans[world]!.from, projection.sourceSpans[world + 4]!.to)).toBe("world")
  })

  test("copies reverse visual selections without splitting an emoji", () => {
    let state = syncTranscriptItem(initialTranscript(), message("a", "A 👨‍👩‍👧‍👦 Z"))
    state = syncTranscriptItem(state, message("b", "second"))
    state = moveCursor(state, { itemId: itemId("b"), graphemeOffset: 2 })
    state = beginSelection(state, "character")
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 2 })
    expect(selectedText(state, "plain")).toBe("👨‍👩‍👧‍👦 Z\nsec")
  })

  test("source yanks use the selected span rather than the whole message", () => {
    let state = syncTranscriptItem(initialTranscript(), message("a", "before **bold** after"))
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 7 })
    state = beginSelection(state, "character")
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 10 })
    expect(selectedText(state, "source")).toBe("**bold**")
  })

  test("linewise selection expands to rendered logical lines", () => {
    let state = syncTranscriptItem(initialTranscript(), message("a", "first\nsecond\nthird"))
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 7 })
    state = beginSelection(state, "line")
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 8 })
    expect(selectedText(state, "plain")).toBe("second\n")
  })

  test("selection swap atomically moves the cursor and viewport to the new head", () => {
    let state = syncTranscriptItem(initialTranscript(), message("a", "first"))
    state = syncTranscriptItem(state, message("b", "second"))
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 1 }, 7)
    state = beginSelection(state, "character")
    state = moveCursor(state, { itemId: itemId("b"), graphemeOffset: 3 }, 7)
    state = reduceTranscript(state, { type: "selection.swap" })
    expect(state.selection).toEqual({
      anchor: { itemId: itemId("b"), graphemeOffset: 3 },
      head: { itemId: itemId("a"), graphemeOffset: 1 },
      shape: "character",
    })
    expect(state.cursor).toEqual(state.selection?.head)
    expect(state.viewport).toEqual({ kind: "point", point: state.selection!.head, preferredScreenRow: 7 })
  })

  test("compound search and jump reductions equal their sequential semantic references", () => {
    let state = syncTranscriptItem(initialTranscript(), message("a", "origin"))
    state = syncTranscriptItem(state, { id: itemId("b"), turnId: turnId("tb"), kind: "reasoning", markdown: "needle target", status: "complete" })
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 1 }, 4)
    state = beginSelection(state, "character")
    state = setFold(state, itemId("b"), true)
    const target = { point: { itemId: itemId("b"), graphemeOffset: 0 }, preferredScreenRow: 2 }
    const sequentialSearch = reduceTranscript(
      reduceTranscript(state, { type: "search.set", query: "needle", direction: "forward" }),
      { type: "jump.to", target },
    )
    expect(reduceTranscript(state, {
      type: "search.jump", search: { query: "needle", direction: "forward" }, target,
    })).toEqual(sequentialSearch)

    const sequentialClearJump = reduceTranscript(
      reduceTranscript(state, { type: "selection.clear" }),
      { type: "jump.to", target },
    )
    expect(reduceTranscript(state, { type: "jump.to", target, clearSelection: true })).toEqual(sequentialClearJump)

    const sequentialReveal = moveCursor(setFold(state, itemId("b"), false), target.point, target.preferredScreenRow)
    expect(reduceTranscript(state, { type: "cursor.reveal", point: target.point,
      preferredScreenRow: target.preferredScreenRow })).toEqual(sequentialReveal)

    expect(moveCursor(state, { itemId: itemId("missing"), graphemeOffset: 0 })).toBe(state)
    expect(moveCursor(state, { itemId: itemId("a"), graphemeOffset: 0.5 })).toBe(state)
    expect(moveCursor(state, { itemId: itemId("a"), graphemeOffset: 999 }).cursor).toEqual({
      itemId: itemId("a"), graphemeOffset: graphemeCount("origin"),
    })
    let atEnd = syncTranscriptItem(initialTranscript(), message("end", "abc"))
    atEnd = moveCursor(atEnd, { itemId: itemId("end"), graphemeOffset: 3 }, 2)
    expect(reduceTranscript(atEnd, {
      type: "jump.to", target: { point: { itemId: itemId("end"), graphemeOffset: 999 }, preferredScreenRow: 2 },
    })).toBe(atEnd)
  })

  test("selection count uses a warm logarithmic length index instead of materializing selected history", () => {
    const ids = Object.freeze(Array.from({ length: 100_000 }, (_, index) => itemId(`count-${index}`)))
    const projection = projectItem(message("count-projection", "x"))
    const state = {
      ...initialTranscript(),
      order: ids,
      projectionById: Object.freeze(Object.fromEntries(ids.map(id => [id, projection]))),
      selection: {
        anchor: { itemId: ids[10]!, graphemeOffset: 0 },
        head: { itemId: ids[99_990]!, graphemeOffset: 0 },
        shape: "character" as const,
      },
    }
    expect(selectedGraphemeCount(state)).toBe(199_961)
    const diagnostics = {
      textLengthIndexBuilds: 0, textLengthItemVisits: 0, textLengthIndexCacheHits: 0,
      textLengthIndexUpdates: 0, textLengthNodeVisits: 0,
    }
    expect(selectedGraphemeCount(state, diagnostics)).toBe(graphemeCount(selectedText(state, "plain")!))
    expect(diagnostics.textLengthIndexBuilds).toBe(0)
    expect(diagnostics.textLengthItemVisits).toBe(0)
    expect(diagnostics.textLengthIndexCacheHits).toBe(1)
    expect(diagnostics.textLengthNodeVisits).toBeLessThan(64)

    let incremental = syncTranscriptItem(initialTranscript(), message("count-a", "alpha"))
    incremental = syncTranscriptItem(incremental, message("count-b", "beta"))
    incremental = moveCursor(incremental, { itemId: itemId("count-a"), graphemeOffset: 1 })
    incremental = beginSelection(incremental, "line")
    incremental = moveCursor(incremental, { itemId: itemId("count-b"), graphemeOffset: 2 })
    expect(selectedGraphemeCount(incremental)).toBe(graphemeCount(selectedText(incremental, "plain")!))

    const sharedProjectionById = { short: projectItem(message("short", "x")), long: projectItem(message("long", "12345")) }
    const shortFirst = { ...initialTranscript(), order: [itemId("short"), itemId("long")], projectionById: sharedProjectionById }
    const longFirst = { ...shortFirst, order: [itemId("long"), itemId("short")] }
    expect(transcriptTextLengthRange(shortFirst, 0, 1)).toBe(1)
    expect(transcriptTextLengthRange(longFirst, 0, 1)).toBe(5)
  })

  test("folds preserve semantic cursor and URL lookup is keyboard-addressable", () => {
    let state = syncTranscriptItem(initialTranscript(), { id: itemId("a"), turnId: turnId("ta"), kind: "reasoning", markdown: "Visit [site](https://example.test)", status: "complete" })
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 7 }, 4)
    const cursor = state.cursor, viewport = state.viewport
    state = setFold(state, itemId("a"), true)
    expect(state.cursor).toEqual(cursor)
    expect(state.viewport).toEqual(viewport)
    expect(urlAt(state)).toBe("https://example.test")
  })

  test("retains explicit unfolded state for default-fold restoration", () => {
    let state = syncTranscriptItem(initialTranscript(), { id: itemId("a"), turnId: turnId("ta"), kind: "reasoning", markdown: "tool output", status: "complete" })
    state = setFold(state, itemId("a"), false)
    expect(Object.hasOwn(state.folded, itemId("a"))).toBe(true)
    expect(state.folded[itemId("a")]).toBe(false)
  })

  test("persistent fold lookup and enumeration use one opaque-id ordering", () => {
    const folded = persistentTranscriptFolds({ a: true, B: false, z: true, "Á": false, aa: true, A: false })
    expect(Object.fromEntries(Object.entries(folded))).toEqual({ A: false, B: false, a: true, aa: true, z: true, "Á": false })
    for (const [id, value] of Object.entries({ a: true, B: false, z: true, "Á": false, aa: true, A: false })) {
      expect(folded[id]).toBe(value)
      expect(Object.hasOwn(folded, id)).toBe(true)
    }
    const updated = setTranscriptFoldValue(folded, itemId("B"), true)
    expect(JSON.parse(JSON.stringify(updated))).toEqual({ A: false, B: true, a: true, aa: true, z: true, "Á": false })
  })

  test("persistent projections path-copy one opaque id while retaining record compatibility", () => {
    const values = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => {
      const id = itemId(`projection-${index}`)
      return [id, projectItem(message(id, `value ${index}`))]
    }))
    const before = persistentTranscriptProjections(values)
    const target = itemId("projection-617")
    const replacement = projectItem(message(target, "replacement"))
    const diagnostics = { projectionRecordUpdates: 0, projectionRecordNodeVisits: 0, projectionRecordNodesCopied: 0 }
    const after = setTranscriptProjection(before, target, replacement, diagnostics)

    expect(before[target]).toBe(values[target])
    expect(after[target]).toBe(replacement)
    expect(after[itemId("projection-616")]).toBe(before[itemId("projection-616")])
    expect(Object.keys(after)).toHaveLength(1_000)
    expect(JSON.parse(JSON.stringify(after))[target].source).toBe("replacement")
    expect(diagnostics.projectionRecordUpdates).toBe(1)
    expect(diagnostics.projectionRecordNodeVisits).toBeLessThanOrEqual(Math.ceil(Math.log2(1_000)) + 1)
    expect(diagnostics.projectionRecordNodesCopied).toBe(diagnostics.projectionRecordNodeVisits)
    expect(setTranscriptProjection(after, target, replacement)).toBe(after)
    expect(Reflect.setPrototypeOf(after, { polluted: true })).toBe(false)
    expect(Reflect.preventExtensions(after)).toBe(false)
    expect(after[target]).toBe(replacement)

    const special = Object.create(null) as Record<string, typeof replacement>
    special["10"] = replacement
    special["2"] = replacement
    special.a = replacement
    special["__proto__"] = replacement
    special["constructor"] = replacement
    const normalized = persistentTranscriptProjections(special)
    expect(Object.keys(normalized)).toEqual(["2", "10", "__proto__", "a", "constructor"])
    expect(Object.hasOwn(normalized, "__proto__")).toBe(true)
    expect(Object.prototype.propertyIsEnumerable.call(normalized, "constructor")).toBe(true)
    expect(({ ...normalized } as Record<string, typeof replacement>)["__proto__"]).toBe(replacement)
  })

  test("persistent logical order preserves readonly array behavior and exact append lineage", () => {
    const original = Object.freeze([itemId("first"), itemId("second"), itemId("third")])
    const order = persistentTranscriptOrder(original)
    const appended = appendTranscriptOrder(order, itemId("fourth"))

    expect(Array.isArray(order)).toBe(true)
    expect(order).toEqual(original)
    expect(order.length).toBe(3)
    expect(order[1]).toBe(itemId("second"))
    expect(order.at(-1)).toBe(itemId("third"))
    expect([...order]).toEqual(Array.from(original))
    expect(order.slice(1)).toEqual(original.slice(1))
    expect(order.map(id => id.toUpperCase())).toEqual(original.map(id => id.toUpperCase()))
    expect(order.filter((_, index) => index % 2 === 0)).toEqual([itemId("first"), itemId("third")])
    expect(order.flatMap(id => [id, id])).toEqual(original.flatMap(id => [id, id]))
    expect(Object.keys(order)).toEqual(["0", "1", "2"])
    expect(JSON.stringify(order)).toBe(JSON.stringify(original))
    expect(Reflect.set(order, "0", itemId("replacement"))).toBe(false)

    expect([...appended]).toEqual([...original, itemId("fourth")])
    expect([...order]).toEqual(Array.from(original))
    expect(transcriptOrderAppend(order, appended)).toEqual({ previous: order, itemId: itemId("fourth"), position: 3 })
    expect(transcriptOrderAppend(original, appended)).toBeUndefined()
    const next = appendTranscriptOrder(appended, itemId("fifth"))
    expect(transcriptOrderAppend(appended, next)?.position).toBe(4)
    expect([...transcriptOrderIndex(next)]).toEqual([...new Map(next.map((id, position) => [id, position] as const))])
    expect(persistentTranscriptOrder(order)).toBe(order)
    expect(persistentTranscriptOrder(original)).toBe(order)
  })

  test("inherits the disposable order index through a 100k append without rebuilding or visiting history", () => {
    const ids = Object.freeze(Array.from({ length: 100_000 }, (_, index) => itemId(`order-${index}`)))
    const order = persistentTranscriptOrder(ids)
    const before = transcriptOrderIndex(order)
    const appendedId = itemId("order-appended")
    const appended = appendTranscriptOrder(order, appendedId)
    const diagnostics = { orderIndexBuilds: 0, orderIndexItemVisits: 0, orderIndexCacheHits: 0 }
    const after = transcriptOrderIndex(appended, diagnostics)

    expect(after.get(ids[0]!)).toBe(0)
    expect(after.get(ids[50_000]!)).toBe(50_000)
    expect(after.get(ids.at(-1)!)).toBe(99_999)
    expect(after.get(appendedId)).toBe(100_000)
    expect(before.has(appendedId)).toBe(false)
    expect(diagnostics).toEqual({ orderIndexBuilds: 0, orderIndexItemVisits: 0, orderIndexCacheHits: 1 })
  })

  test("sync appends persistent logical order with array-reference semantic equivalence", () => {
    const first = message("persistent-order-first", "first")
    const second = message("persistent-order-second", "second")
    const initial = initialTranscript()
    const diagnostics = {
      projectionRecordUpdates: 0, projectionRecordNodeVisits: 0, projectionRecordNodesCopied: 0,
      textLengthIndexBuilds: 0, textLengthItemVisits: 0, textLengthIndexCacheHits: 0,
      textLengthIndexUpdates: 0, textLengthNodeVisits: 0,
      orderIndexBuilds: 0, orderIndexItemVisits: 0, orderIndexCacheHits: 0,
      urlIndexBuilds: 0, urlIndexItemVisits: 0, urlIndexCacheHits: 0, urlIndexUpdates: 0, urlIndexNodeVisits: 0,
    }
    const afterFirst = syncTranscriptItem(initial, first, diagnostics)
    const afterSecond = syncTranscriptItem(afterFirst, second, diagnostics)

    expect([...afterFirst.order]).toEqual([first.id])
    expect([...afterSecond.order]).toEqual([first.id, second.id])
    expect(transcriptOrderAppend(initial.order, afterFirst.order)).toEqual({ previous: initial.order, itemId: first.id, position: 0 })
    expect(transcriptOrderAppend(afterFirst.order, afterSecond.order)).toEqual({ previous: afterFirst.order, itemId: second.id, position: 1 })
    expect(transcriptOrderIndex(afterSecond.order, diagnostics).get(second.id)).toBe(1)
    expect({ builds: diagnostics.orderIndexBuilds, visits: diagnostics.orderIndexItemVisits,
      hits: diagnostics.orderIndexCacheHits }).toEqual({ builds: 0, visits: 0, hits: 1 })
  })

  test("records bounded branching jumps, skips stale entries, and reprojects marks", () => {
    let state = syncTranscriptItem(initialTranscript(), message("a", "prefix **bold", "running"))
    state = syncTranscriptItem(state, { id: itemId("b"), turnId: turnId("tb"), kind: "reasoning", markdown: "destination", status: "complete" })
    const origin = { point: { itemId: itemId("a"), graphemeOffset: 9 }, preferredScreenRow: 4 }
    const destination = { point: { itemId: itemId("b"), graphemeOffset: 2 }, preferredScreenRow: 2 }
    state = reduceTranscript(state, { type: "cursor.move", point: origin.point, preferredScreenRow: origin.preferredScreenRow })
    state = reduceTranscript(state, { type: "mark.set", name: "a", target: origin })
    state = reduceTranscript(state, { type: "jump.to", target: destination })
    expect(state.jumps.back).toEqual([origin])
    state = reduceTranscript(state, { type: "jump.back" })
    expect(state.cursor).toEqual(origin.point)
    state = reduceTranscript(state, { type: "jump.forward" })
    expect(state.cursor).toEqual(destination.point)
    state = reduceTranscript(state, { type: "jump.to", target: origin })
    expect(state.jumps.forward).toEqual([])
    for (let index = 0; index < 105; index++) state = reduceTranscript(state, { type: "jump.to", target: { point: { itemId: itemId("b"), graphemeOffset: index % 2 }, preferredScreenRow: 2 } })
    expect(state.jumps.back).toHaveLength(100)
    state = { ...state, jumps: { back: [origin, { point: { itemId: itemId("missing"), graphemeOffset: 0 }, preferredScreenRow: 0 }], forward: [] } }
    state = reduceTranscript(state, { type: "jump.back" })
    expect(state.cursor).toEqual(origin.point)
    const displayed = { cursor: state.cursor, viewport: state.viewport }
    state = { ...state, jumps: { back: [{ point: { itemId: itemId("missing"), graphemeOffset: 0 }, preferredScreenRow: 0 }], forward: [] } }
    state = reduceTranscript(state, { type: "jump.back" })
    expect(state).toMatchObject({ ...displayed, jumps: { back: [], forward: [] } })
    state = setFold(state, itemId("b"), true)
    state = reduceTranscript(state, { type: "mark.set", name: "b", target: destination })
    state = reduceTranscript(state, { type: "mark.jump", name: "b" })
    expect(state.folded[itemId("b")]).toBe(false)
    expect(state.cursor).toEqual(destination.point)
    state = syncTranscriptItem(state, message("a", "prefix **bold** and more", "running"))
    expect(state.marks.a?.point.graphemeOffset).toBe(7)
    state = reduceTranscript(state, { type: "mark.jump", name: "a" })
    expect(state.cursor).toEqual(state.marks.a?.point)
  })

  test("anchors the viewport without moving the cursor or changing a visual selection", () => {
    let state = syncTranscriptItem(initialTranscript(), message("a", "first line\nsecond line"))
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 2 })
    state = beginSelection(state, "character")
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 5 })
    const cursor = state.cursor
    const selection = state.selection
    state = reduceTranscript(state, { type: "viewport.anchor", point: { itemId: itemId("a"), graphemeOffset: 999 }, preferredScreenRow: 3 })
    expect(state.cursor).toEqual(cursor)
    expect(state.selection).toEqual(selection)
    expect(state.viewport).toEqual({ kind: "point", point: { itemId: itemId("a"), graphemeOffset: graphemeCount("first line\nsecond line") }, preferredScreenRow: 3 })
    expect(reduceTranscript(state, { type: "viewport.anchor", point: state.viewport.kind === "point" ? state.viewport.point : cursor!, preferredScreenRow: 3 })).toBe(state)
  })
})

 test("Markdown yanks retain link targets and complete fenced source", () => {
   for (const markdown of ["# Heading", "[label](https://example.test)", "```ts\nconst n = 1\n```", "- **bold**"]) {
     let state = syncTranscriptItem(initialTranscript(), message("source", markdown))
     state = moveCursor(state, { itemId: itemId("source"), graphemeOffset: 0 })
     state = beginSelection(state, "character")
     state = moveCursor(state, { itemId: itemId("source"), graphemeOffset: 9999 })
     expect(selectedText(state, "source")).toBe(markdown)
   }
 })
 test("partial Markdown yanks preserve only fully selected syntax regions", () => {
   let state = syncTranscriptItem(initialTranscript(), message("link", "See [site](https://example.test) now"))
   state = moveCursor(state, { itemId: itemId("link"), graphemeOffset: 4 })
   state = beginSelection(state, "character")
   state = moveCursor(state, { itemId: itemId("link"), graphemeOffset: 7 })
   expect(selectedText(state, "source")).toBe("[site](https://example.test)")
   state = moveCursor(state, { itemId: itemId("link"), graphemeOffset: 5 })
   expect(selectedText(state, "source")).toBe("si")
 })

test("streamed Markdown closure keeps a visual selection on the same source content", () => {
  let state = syncTranscriptItem(initialTranscript(), message("stream", "prefix **bold", "running"))
  state = moveCursor(state, { itemId: itemId("stream"), graphemeOffset: 9 }, 4)
  state = beginSelection(state, "character")
  state = moveCursor(state, { itemId: itemId("stream"), graphemeOffset: 12 }, 4)
  expect(selectedText(state, "plain")).toBe("bold")
  state = syncTranscriptItem(state, message("stream", "prefix **bold** and more", "running"))
  expect(selectedText(state, "plain")).toBe("bold")
  expect(selectedText(state, "source")).toBe("**bold**")
  expect(state.cursor?.graphemeOffset).toBe(10)
  expect(state.viewport).toEqual({ kind: "point", point: { itemId: itemId("stream"), graphemeOffset: 10 }, preferredScreenRow: 4 })
})

test("tool output preserves literal Markdown and retains bare URL navigation", () => {
  const detail = "# build\nfile_name_here **literal** [label](https://example.test)"
  const projection = projectItem({ id: itemId("command"), turnId: turnId("turn"), kind: "command", title: "run", detail, status: "complete" })
  expect(projection.plain).toBe(`run\n${detail}`)
  expect(projection.source).toBe(projection.plain)
  expect(projection.links[0]?.url).toBe("https://example.test")
  expect(projection.sourceRegions).toEqual([])
})


test("command projection keeps readable action, exact execution, and literal output independently copyable", () => {
  const executionCommand = "/bin/zsh -lc 'find packages -maxdepth 2 -type d | head -12'"
  const output = "packages\npackages/composer\n"
  const projection = projectItem({ id: itemId("command-detail"), turnId: turnId("turn"), kind: "command", title: "List files · packages", executionCommand, detail: output, status: "complete" })
  expect(projection.source).toBe(`List files · packages\n${executionCommand}\n${output}`)
  expect(projection.plain).toBe(projection.source)
})

test("agent presentation labels and opaque identity stay outside canonical search and copy", () => {
  const id = itemId("agent")
  let state = syncTranscriptItem(initialTranscript(), {
    id, turnId: turnId("turn"), kind: "agent", action: "spawn", detail: "Review transcript semantics",
    agentThreadIds: [threadId("opaque-child")],
    agentStates: [{ threadId: threadId("opaque-child"), status: "running", message: "Inspecting" }], status: "complete",
  })
  expect(state.projectionById[id]?.source).toBe("Review transcript semantics")
  expect(findSearchMatches(state, "Start agent")).toEqual([])
  expect(findSearchMatches(state, "opaque-child")).toEqual([])
  state = beginSelection(moveCursor(state, { itemId: id, graphemeOffset: 0 }), "character")
  state = moveCursor(state, { itemId: id, graphemeOffset: 999 })
  expect(selectedText(state, "plain")).toBe("Review transcript semantics")
  expect(selectedText(state, "source")).toBe("Review transcript semantics")
})

test("empty agent telemetry is retained outside the semantic transcript", () => {
  let state = initialTranscript()
  for (const item of [
    { id: itemId("activity"), action: "activity" as const, activity: "interacted" as const, agentPath: "/root/reviewer" },
    { id: itemId("wait"), action: "wait" as const },
    { id: itemId("list"), action: "list" as const },
  ]) {
    state = syncTranscriptItem(state, {
      ...item, turnId: turnId("turn"), kind: "agent", detail: "", agentThreadIds: [threadId("child")], status: "complete",
    })
  }
  expect(state.order).toEqual([])
})

test("diagnostic unknown items stay out of canonical projection", () => {
  const state = syncTranscriptItem(initialTranscript(), {
    id: itemId("diagnostic"), turnId: turnId("turn"), kind: "unknown", title: "Invalid agent activity",
    detail: '{"senderThreadId":"opaque-parent","receiverThreadIds":["opaque-child"]}', status: "complete", transcript: "diagnostic",
  })
  expect(state.order).toEqual([])
  expect(findSearchMatches(state, "opaque-child")).toEqual([])
})


test("viewport anchors reject stale items and invalid coordinates, and normalize fractional offsets", () => {
  const state = syncTranscriptItem(initialTranscript(), message("a", "🙂étext"))
  const anchor = (id: string, offset: number, row = 0) => reduceTranscript(state, { type: "viewport.anchor", point: { itemId: itemId(id), graphemeOffset: offset }, preferredScreenRow: row })
  expect(anchor("missing", 0)).toBe(state)
  for (const value of [NaN, Infinity, -Infinity]) {
    expect(anchor("a", value)).toBe(state)
    expect(anchor("a", 0, value)).toBe(state)
  }
  const normalized = anchor("a", 1.9, -1.8)
  expect(normalized.viewport).toEqual({ kind: "point", point: { itemId: itemId("a"), graphemeOffset: 1 }, preferredScreenRow: -1 })
  expect(reduceTranscript(normalized, { type: "viewport.anchor", point: { itemId: itemId("a"), graphemeOffset: 1.9 }, preferredScreenRow: -1.8 })).toBe(normalized)
})


test("status-only item updates preserve projection identity but changed text and node kind invalidate it", () => {
  const item = message("a", "**é🙂**", "running")
  if (!("markdown" in item)) throw new Error("Expected a message fixture")
  let state = syncTranscriptItem(initialTranscript(), item)
  state = beginSelection(moveCursor(state, { itemId: item.id, graphemeOffset: 0 }), "character")
  const completed = syncTranscriptItem(state, { ...item, status: "complete" })
  expect(completed).toBe(state)
  expect(projectItem({ ...item, status: "complete" }, state.projectionById[item.id])).toBe(state.projectionById[item.id]!)
  const changed = syncTranscriptItem(state, { ...item, markdown: "**é🙂!**" })
  expect(changed.projectionById[item.id]).not.toBe(state.projectionById[item.id])
  expect(changed.projectionById[item.id]!.revision).toBe(2)
  expect(selectedText(changed, "plain")).toBe("é")
  const reasoning = syncTranscriptItem(state, { ...item, kind: "reasoning" })
  expect(reasoning.projectionById[item.id]!.nodeKind).toBe("reasoning")
  expect(reasoning.projectionById[item.id]!.revision).toBe(2)
})


test("all folds affect foldable blocks only and repeated commands preserve identity", () => {
  const messageId = itemId("regular-message"), toolId = itemId("foldable-tool")
  let state = syncTranscriptItem(initialTranscript(), message(messageId, "Visible Markdown"))
  state = syncTranscriptItem(state, { id: toolId, turnId: turnId("turn"), kind: "command", title: "Read file", detail: "output", status: "complete" })
  const folded = reduceTranscript(state, { type: "fold.all", folded: true })
  expect(folded.folded).toEqual({ [toolId]: true })
  expect(reduceTranscript(setFold(folded, messageId, true), { type: "fold.all", folded: true }).folded).toEqual({ [toolId]: true })
  expect(reduceTranscript(folded, { type: "fold.all", folded: true })).toBe(folded)
  expect(setFold(folded, toolId, true)).toBe(folded)
  const open = reduceTranscript(folded, { type: "fold.all", folded: false })
  expect(open.folded).toEqual({ [toolId]: false })
  expect(open.projectionById).toBe(state.projectionById)
  expect(open.viewport).toBe(state.viewport)
})

test("default folds initialize complete semantic kinds without overriding an explicit choice", () => {
  const reasoning = itemId("default-reasoning"), tool = itemId("default-tool"), edit = itemId("default-edit")
  let state = syncTranscriptItem(initialTranscript(), { id: reasoning, turnId: turnId("turn"), kind: "reasoning", markdown: "why", status: "complete" })
  state = syncTranscriptItem(state, { id: tool, turnId: turnId("turn"), kind: "tool", title: "Read", detail: "output", status: "complete" })
  state = syncTranscriptItem(state, { id: edit, turnId: turnId("turn"), kind: "edit", title: "file", patch: "@@", status: "complete" })
  state = setFold(state, reasoning, false)
  const defaults = reduceTranscript(state, { type: "fold.defaults", reasoning: true, tools: true })
  expect(defaults.folded).toEqual({ [reasoning]: false, [tool]: true })
  expect(reduceTranscript(defaults, { type: "fold.defaults", reasoning: true, tools: true })).toBe(defaults)
  const laterReasoning = itemId("later-default-reasoning"), laterTool = itemId("later-default-tool")
  let appended = syncTranscriptItem(defaults, { id: laterReasoning, turnId: turnId("later-turn"), kind: "reasoning", markdown: "later", status: "complete" })
  appended = syncTranscriptItem(appended, { id: laterTool, turnId: turnId("later-turn"), kind: "tool", title: "Later", detail: "output", status: "complete" })
  expect(appended.folded).toEqual({ [reasoning]: false, [tool]: true, [laterReasoning]: true, [laterTool]: true })
  expect(appended.foldDefaults).toEqual({ reasoning: true, tools: true })
})
