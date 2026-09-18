import { describe, expect, test } from "bun:test"
import { itemId, turnId } from "@vimex/conversation"
import { assistantMessage as message } from "@vimex/testkit"
import {
  adjacentSearchMatch,
  beginSelection,
  findSearchMatches,
  firstContentPoint,
  graphemeCount,
  initialTranscript,
  moveByMessage,
  moveByWord,
  selectedText,
  moveBySemanticBlock,
  moveByUrl,
  moveCursor,
  referenceText,
  semanticBlocks,
  swapSelection,
  syncTranscriptItem,
  urlCandidates,
} from "./index"

describe("logical transcript navigation", () => {
  test("moves by semantic blocks and messages and finds first line content", () => {
    let state = syncTranscriptItem(initialTranscript(), message("a", "  intro\ncontinued\n\n  second"))
    state = syncTranscriptItem(state, message("b", "next"))
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 4 })

    const blocks = semanticBlocks(state)
    const secondOffset = graphemeCount("  intro\ncontinued\n\n")
    expect(blocks.map((block) => [block.itemId, block.from.graphemeOffset, block.to.graphemeOffset])).toEqual([
      [itemId("a"), 0, graphemeCount("  intro\ncontinued")],
      [itemId("a"), secondOffset, graphemeCount("  intro\ncontinued\n\n  second")],
      [itemId("b"), 0, 4],
    ])
    expect(firstContentPoint(state)).toEqual({ itemId: itemId("a"), graphemeOffset: 2 })
    expect(moveBySemanticBlock(state, "forward")).toEqual({ itemId: itemId("a"), graphemeOffset: secondOffset })
    expect(moveBySemanticBlock(state, "forward", state.cursor, 2)).toEqual({ itemId: itemId("b"), graphemeOffset: 0 })
    expect(moveBySemanticBlock(state, "backward")).toEqual({ itemId: itemId("a"), graphemeOffset: 0 })
    expect(moveByMessage(state, "forward")).toEqual({ itemId: itemId("b"), graphemeOffset: 0 })
    expect(moveByMessage(state, "backward")).toBeUndefined()
  })

  test("message motions skip reasoning and tool nodes", () => {
    let state = syncTranscriptItem(initialTranscript(), message("first", "first"))
    state = syncTranscriptItem(state, { id: itemId("reasoning"), turnId: turnId("turn"), kind: "reasoning", markdown: "thinking", status: "complete" })
    state = syncTranscriptItem(state, { id: itemId("tool"), turnId: turnId("turn"), kind: "command", title: "Run", detail: "output", status: "complete" })
    state = syncTranscriptItem(state, message("second", "second"))
    expect(moveByMessage(state, "forward", { itemId: itemId("first"), graphemeOffset: 0 })).toEqual({ itemId: itemId("second"), graphemeOffset: 0 })
    expect(moveByMessage(state, "backward", { itemId: itemId("tool"), graphemeOffset: 0 })).toEqual({ itemId: itemId("first"), graphemeOffset: 0 })
    expect(moveByMessage(state, "forward", { itemId: itemId("tool"), graphemeOffset: 0 })).toEqual({ itemId: itemId("second"), graphemeOffset: 0 })
  })

  test("references a selection first and otherwise the current semantic block", () => {
    let state = syncTranscriptItem(initialTranscript(), message("a", "first block\nline two\n\nsecond block"))
    const second = graphemeCount("first block\nline two\n\n")
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: second + 2 })
    expect(referenceText(state)).toBe("second block")

    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 0 })
    state = beginSelection(state, "character")
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 4 })
    expect(referenceText(state)).toBe("first")
    const swapped = swapSelection(state)
    expect(swapped.selection).toEqual({
      anchor: { itemId: itemId("a"), graphemeOffset: 4 },
      head: { itemId: itemId("a"), graphemeOffset: 0 },
      shape: "character",
    })
    expect(swapped.cursor).toEqual(swapped.selection?.head)
  })

  test("indexes URL candidates by scope and moves in either direction", () => {
    let state = syncTranscriptItem(initialTranscript(), message("a", "[one](https://one.test) then https://two.test/a_(b)."))
    state = syncTranscriptItem(state, message("b", "<file://folder/name>"))
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 0 })

    expect(urlCandidates(state).map(({ text, url }) => [text, url])).toEqual([
      ["one", "https://one.test"],
      ["https://two.test/a_(b)", "https://two.test/a_(b)"],
      ["file://folder/name", "file://folder/name"],
    ])
    expect(urlCandidates(state, "current-item")).toHaveLength(2)
    expect(moveByUrl(state, "forward")).toEqual(urlCandidates(state)[1]!.from)
    expect(moveByUrl(state, "backward", state.cursor, { wrap: true })).toEqual(urlCandidates(state)[2]!.from)

    state = beginSelection(state, "character")
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 2 })
    expect(urlCandidates(state, "selection").map(({ url }) => url)).toEqual(["https://one.test"])
  })
})

describe("transcript search", () => {
  test("finds overlapping grapheme matches and navigates with wrapping", () => {
    let state = syncTranscriptItem(initialTranscript(), message("a", "AaA 👨‍👩‍👧‍👦 aaa"))
    state = syncTranscriptItem(state, message("b", "AAA"))
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 0 })

    const matches = findSearchMatches(state, "aa")
    expect(matches.map((match) => [match.itemId, match.from.graphemeOffset])).toEqual([
      [itemId("a"), 0], [itemId("a"), 1], [itemId("a"), 6], [itemId("a"), 7],
      [itemId("b"), 0], [itemId("b"), 1],
    ])
    expect(findSearchMatches(state, "aa", { caseSensitive: true })).toHaveLength(2)
    expect(adjacentSearchMatch(state, matches, "forward")?.from).toEqual(matches[1]!.from)
    expect(adjacentSearchMatch(state, matches, "backward")?.from).toEqual(matches.at(-1)!.from)
    expect(adjacentSearchMatch(state, matches, "forward", matches.at(-1)!.from)?.from).toEqual(matches[0]!.from)
    expect(findSearchMatches(state, "👨‍👩‍👧‍👦")[0]?.to.graphemeOffset).toBe(5)
  })

  test("finds the adjacent match without scanning every match against the full item order", () => {
    let state = initialTranscript()
    for (let index = 0; index < 300; index++) state = syncTranscriptItem(state, message(`search-${index}`, "a ".repeat(40)))
    const matches = findSearchMatches(state, "a")
    const point = { itemId: itemId("search-150"), graphemeOffset: 20 }
    const start = performance.now()
    for (let index = 0; index < 100; index++) adjacentSearchMatch(state, matches, "forward", point)
    expect(performance.now() - start).toBeLessThan(100)
  })
})


describe("Vim transcript word motions", () => {
  test("distinguishes words from WORDs with counted punctuation and boundaries", () => {
    let state = syncTranscriptItem(initialTranscript(), message("a", "one.two  three"))
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 0 })
    expect(moveByWord(state, "next")?.graphemeOffset).toBe(3)
    expect(moveByWord(state, "next", state.cursor, 2)?.graphemeOffset).toBe(4)
    expect(moveByWord(state, "next", state.cursor, 1, true)?.graphemeOffset).toBe(9)
    expect(moveByWord(state, "end")?.graphemeOffset).toBe(2)
    expect(moveByWord(state, "end", state.cursor, 1, true)?.graphemeOffset).toBe(6)
    expect(moveByWord(state, "next", state.cursor, 100)?.graphemeOffset).toBe(13)
    expect(moveByWord(state, "previous")?.graphemeOffset).toBe(0)
    expect(moveByWord(state, "previous", { itemId: itemId("a"), graphemeOffset: 6 })?.graphemeOffset).toBe(4)
  })

  test("short motions do not segment unrelated large transcript items", () => {
    let state = initialTranscript()
    for (let index = 0; index < 100; index++) state = syncTranscriptItem(state, message(`word-${index}`, "alpha beta gamma delta https://example.test\n".repeat(100)))
    const start = performance.now()
    const target = moveByWord(state, "next", { itemId: itemId("word-0"), graphemeOffset: 0 })
    expect(target).toEqual({ itemId: itemId("word-0"), graphemeOffset: 6 })
    expect(performance.now() - start).toBeLessThan(50)
  })

  test("crosses empty items and newlines without splitting Unicode graphemes", () => {
    let state = syncTranscriptItem(initialTranscript(), message("a", "café 👨‍👩‍👧‍👦\nnext"))
    state = syncTranscriptItem(state, message("empty", ""))
    state = syncTranscriptItem(state, message("b", "日本語 last"))
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 0 })
    expect(moveByWord(state, "end")?.graphemeOffset).toBe(3)
    expect(moveByWord(state, "next")?.graphemeOffset).toBe(5)
    expect(moveByWord(state, "next", state.cursor, 3)).toEqual({ itemId: itemId("b"), graphemeOffset: 0 })
    expect(moveByWord(state, "previous", { itemId: itemId("b"), graphemeOffset: 0 })).toEqual({ itemId: itemId("a"), graphemeOffset: 7 })
    expect(moveByWord(state, "end", { itemId: itemId("b"), graphemeOffset: 0 })).toEqual({ itemId: itemId("b"), graphemeOffset: 2 })
  })

  test("extends a semantic Visual range while canonical Markdown copy stays exact", () => {
    let state = syncTranscriptItem(initialTranscript(), message("a", "[café](https://example.test) next"))
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 0 })
    state = beginSelection(state, "character")
    state = moveCursor(state, moveByWord(state, "end")!)
    expect(state.selection?.anchor.graphemeOffset).toBe(0)
    expect(state.selection?.head.graphemeOffset).toBe(3)
    expect(selectedText(state, "plain")).toBe("café")
    expect(selectedText(state, "source")).toBe("[café](https://example.test)")
    state = moveCursor(state, moveByWord(state, "end")!)
    expect(selectedText(state, "plain")).toBe("café next")
  })
})
