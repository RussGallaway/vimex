import { describe, expect, test } from "bun:test"
import { itemId } from "@vimex/conversation"
import { assistantMessage as message } from "@vimex/testkit"
import {
  beginSelection,
  graphemeCount,
  initialTranscript,
  moveCursor,
  projectMarkdown,
  selectedText,
  syncTranscriptItem,
} from "./index"

describe("canonical Markdown source projection", () => {
  test("balances nested labels and parentheses in link destinations", () => {
    const projection = projectMarkdown("[outer [brackets]](https://example.test/a_(b) \"title\")")
    expect(projection.plain).toBe("outer [brackets]")
    expect(projection.links).toEqual([{
      from: 0,
      to: graphemeCount("outer [brackets]"),
      url: "https://example.test/a_(b)",
    }])
  })

  test("requires a fence closer to match marker and opening width", () => {
    const markdown = "````ts\nalpha\n```\nomega\n````"
    const projection = projectMarkdown(markdown)
    expect(projection.plain).toBe("alpha\n```\nomega\n")

    let state = syncTranscriptItem(initialTranscript(), message("fence", `before\n\n${markdown}\n\nafter`))
    const start = graphemeCount("before\n\n")
    state = moveCursor(state, { itemId: itemId("fence"), graphemeOffset: start })
    state = beginSelection(state, "character")
    state = moveCursor(state, { itemId: itemId("fence"), graphemeOffset: start + graphemeCount(projection.plain) - 2 })
    expect(selectedText(state, "source")).toBe(markdown)
  })

  test("preserves a complete table source while omitting its delimiter from logical text", () => {
    const table = "| A | B |\n|---|:---:|\n| 1 | 2 |"
    const markdown = `before\n\n${table}\n\nafter`
    const projection = projectMarkdown(markdown)
    expect(projection.plain).toBe("before\n\n| A | B |\n| 1 | 2 |\n\nafter")

    let state = syncTranscriptItem(initialTranscript(), message("table", markdown))
    const start = graphemeCount("before\n\n")
    const visibleTable = "| A | B |\n| 1 | 2 |"
    state = moveCursor(state, { itemId: itemId("table"), graphemeOffset: start })
    state = beginSelection(state, "character")
    state = moveCursor(state, { itemId: itemId("table"), graphemeOffset: start + graphemeCount(visibleTable) - 1 })
    expect(selectedText(state, "source")).toBe(table)
  })

  test("retains angle-autolink syntax for canonical selections", () => {
    let state = syncTranscriptItem(initialTranscript(), message("link", "See <https://example.test/path> now"))
    state = moveCursor(state, { itemId: itemId("link"), graphemeOffset: 4 })
    state = beginSelection(state, "character")
    state = moveCursor(state, { itemId: itemId("link"), graphemeOffset: 28 })
    expect(selectedText(state, "source")).toBe("<https://example.test/path>")
  })
})

// A generous budget catches repeated whole-prefix Unicode segmentation (formerly
// ~5.6s for this fixture), while allowing substantial CI hardware variance.
test("projects a large formatted response without repeated prefix scans", () => {
  const source = "- **result** with [link](https://example.com) and details\n".repeat(1000)
  const start = performance.now()
  const projection = projectMarkdown(source)
  const elapsed = performance.now() - start
  expect(projection.links).toHaveLength(1000)
  expect(projection.plain).toBe("result with link and details\n".repeat(1000))
  expect(elapsed).toBeLessThan(1000)
})
