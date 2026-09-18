import { describe, expect, test } from "bun:test"
import { itemId, turnId, type ConversationItem } from "@vimex/conversation"
import { attachTail, beginSelection, initialTranscript, moveCursor, projectItem, selectedText, setFold, syncTranscriptItem, urlAt } from "./index"

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

  test("folds preserve semantic cursor and URL lookup is keyboard-addressable", () => {
    let state = syncTranscriptItem(initialTranscript(), message("a", "Visit [site](https://example.test)"))
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 7 }, 4)
    const cursor = state.cursor, viewport = state.viewport
    state = setFold(state, itemId("a"), true)
    expect(state.cursor).toEqual(cursor)
    expect(state.viewport).toEqual(viewport)
    expect(urlAt(state)).toBe("https://example.test")
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
