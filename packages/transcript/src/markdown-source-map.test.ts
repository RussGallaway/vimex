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
    const projection = projectMarkdown(
      '[outer [brackets]](https://example.test/a_(b) "title")',
    )
    expect(projection.plain).toBe("outer [brackets]")
    expect(projection.links).toEqual([
      {
        from: 0,
        to: graphemeCount("outer [brackets]"),
        url: "https://example.test/a_(b)",
      },
    ])
  })

  test("requires a fence closer to match marker and opening width", () => {
    const markdown = "````ts\nalpha\n```\nomega\n````"
    const projection = projectMarkdown(markdown)
    expect(projection.plain).toBe("alpha\n```\nomega\n")

    let state = syncTranscriptItem(
      initialTranscript(),
      message("fence", `before\n\n${markdown}\n\nafter`),
    )
    const start = graphemeCount("before\n\n")
    state = moveCursor(state, {
      itemId: itemId("fence"),
      graphemeOffset: start,
    })
    state = beginSelection(state, "character")
    state = moveCursor(state, {
      itemId: itemId("fence"),
      graphemeOffset: start + graphemeCount(projection.plain) - 2,
    })
    expect(selectedText(state, "source")).toBe(markdown)
  })

  test("preserves a complete table source while omitting its delimiter from logical text", () => {
    const table = "| A | B |\n|---|:---:|\n| 1 | 2 |"
    const markdown = `before\n\n${table}\n\nafter`
    const projection = projectMarkdown(markdown)
    expect(projection.plain).toBe("before\n\n| A | B |\n| 1 | 2 |\n\nafter")

    let state = syncTranscriptItem(
      initialTranscript(),
      message("table", markdown),
    )
    const start = graphemeCount("before\n\n")
    const visibleTable = "| A | B |\n| 1 | 2 |"
    state = moveCursor(state, {
      itemId: itemId("table"),
      graphemeOffset: start,
    })
    state = beginSelection(state, "character")
    state = moveCursor(state, {
      itemId: itemId("table"),
      graphemeOffset: start + graphemeCount(visibleTable) - 1,
    })
    expect(selectedText(state, "source")).toBe(table)
  })

  test("retains angle-autolink syntax for canonical selections", () => {
    let state = syncTranscriptItem(
      initialTranscript(),
      message("link", "See <https://example.test/path> now"),
    )
    state = moveCursor(state, { itemId: itemId("link"), graphemeOffset: 4 })
    state = beginSelection(state, "character")
    state = moveCursor(state, { itemId: itemId("link"), graphemeOffset: 28 })
    expect(selectedText(state, "source")).toBe("<https://example.test/path>")
  })

  test("matches CommonMark delimiter rules for intraword underscores and nested emphasis", () => {
    expect(projectMarkdown("foo_bar_baz").plain).toBe("foo_bar_baz")
    expect(projectMarkdown("***bold*** and **a *nested* value**").plain).toBe(
      "bold and a nested value",
    )
  })

  test("normalizes code-span spaces and keeps their complete source envelope", () => {
    const markdown = "before `  a  ` after"
    const projection = projectMarkdown(markdown)
    expect(projection.plain).toBe("before  a  after")
    let state = syncTranscriptItem(
      initialTranscript(),
      message("code", markdown),
    )
    state = moveCursor(state, { itemId: itemId("code"), graphemeOffset: 7 })
    state = beginSelection(state, "character")
    state = moveCursor(state, { itemId: itemId("code"), graphemeOffset: 9 })
    expect(selectedText(state, "source")).toBe("`  a  `")
  })

  test("resolves full, collapsed, and shortcut reference links", () => {
    const markdown =
      "[one][target] [two][] [three]\n\n[target]: https://one.test\n[two]: https://two.test\n[three]: https://three.test"
    const projection = projectMarkdown(markdown)
    expect(projection.plain).toBe("one two three\n\n")
    expect(projection.links.map(({ url }) => url)).toEqual([
      "https://one.test",
      "https://two.test",
      "https://three.test",
    ])
  })

  test("resolves multiline reference destinations and titles", () => {
    const markdown =
      'Read [the guide][docs].\n\n[docs]:\n  <https://example.test/guide>\n  "Guide title"'
    const projection = projectMarkdown(markdown)
    expect(projection.plain).toBe("Read the guide.\n\n")
    expect(projection.links).toEqual([
      { from: 5, to: 14, url: "https://example.test/guide" },
    ])
    let state = syncTranscriptItem(
      initialTranscript(),
      message("reference", markdown),
    )
    state = moveCursor(state, {
      itemId: itemId("reference"),
      graphemeOffset: 5,
    })
    state = beginSelection(state, "character")
    state = moveCursor(state, {
      itemId: itemId("reference"),
      graphemeOffset: 13,
    })
    expect(selectedText(state, "source")).toBe("[the guide][docs]")
  })

  test("normalizes line endings inside multiline code spans", () => {
    const markdown = "before `alpha\nbeta` after"
    const projection = projectMarkdown(markdown)
    expect(projection.plain).toBe("before alpha beta after")
    expect(projection.sourceRegions).toContainEqual({
      from: 7,
      to: 17,
      sourceFrom: 7,
      sourceTo: 19,
    })
  })

  test("preserves entities literally to match OpenTUI's Marked text tokens", () => {
    expect(
      projectMarkdown("A &copy; &eacute; &NotEqualTilde; &#x1F600;").plain,
    ).toBe("A &copy; &eacute; &NotEqualTilde; &#x1F600;")
  })

  test("only consumes CommonMark punctuation escapes", () => {
    expect(projectMarkdown(String.raw`C:\Users \alpha \*literal*`).plain).toBe(
      String.raw`C:\Users \alpha *literal*`,
    )
  })

  test("projects thematic breaks as the stable native rule glyph with exact source mapping", () => {
    for (const marker of [
      "---",
      "***",
      "___",
      "- - -",
      "* * *",
      "_ _ _",
      "  ---  ",
    ]) {
      const projection = projectMarkdown(`before\n\n${marker}\n\nafter`)
      expect(projection.plain).toBe("before\n\n─\n\nafter")
      const rule = graphemeCount("before\n\n")
      expect(
        projection.source.slice(
          projection.sourceSpans[rule]!.from,
          projection.sourceSpans[rule]!.to,
        ),
      ).toBe(marker)
    }
  })

  test("preserves setext underline text to match the native renderer", () => {
    expect(projectMarkdown("Heading\n=======").plain).toBe("Heading\n=======")
    expect(projectMarkdown("Heading\n---").plain).toBe("Heading\n---")
  })

  test("does not treat reference-like text inside a fence as a definition", () => {
    const projection = projectMarkdown(
      "```\n[id]: https://inside.test\n```\n[id]",
    )
    expect(projection.plain).toBe("[id]: https://inside.test\n[id]")
    expect(projection.links).toEqual([])
  })
})

// A generous budget catches repeated whole-prefix Unicode segmentation (formerly
// ~5.6s for this fixture), while allowing substantial CI hardware variance.
test("projects a large formatted response without repeated prefix scans", () => {
  const source =
    "- **result** with [link](https://example.com) and details\n".repeat(1000)
  const start = performance.now()
  const projection = projectMarkdown(source)
  const elapsed = performance.now() - start
  expect(projection.links).toHaveLength(1000)
  expect(projection.plain).toBe("result with link and details\n".repeat(1000))
  expect(elapsed).toBeLessThan(1000)
})
