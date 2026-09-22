import { themeNames } from "@vimex/interaction"
import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { act } from "react"
import { itemId, turnId } from "@vimex/conversation"
import {
  graphemeCount,
  initialTranscript,
  selectedText,
  syncTranscriptItem,
} from "@vimex/transcript"
import { createEmberTideSyntax } from "../theme"
import { MarkdownMessage } from "./MarkdownMessage"
import { measureRenderedTranscript, measuredPoint } from "./rendered-layout"

const source =
  "# Heading\n\n**STRONG** and *EMPHASIS* and ~~REMOVED~~ with `INLINE`.\n\n- List item\n\n> QUOTATION\n\n[LINK](https://example.test)\n\n| Name | Value |\n| --- | --- |\n| Cell | **TABLEBOLD** |\n\n```typescript\nconst value = 42\n```"

for (const theme of themeNames)
  test(`${theme}: native Markdown spans retain styles and exact source copy through narrow reflow`, async () => {
    const item = {
      id: itemId("styled"),
      turnId: turnId("turn"),
      kind: "assistant" as const,
      markdown: source,
      status: "complete" as const,
    }
    const base = syncTranscriptItem(initialTranscript(), item)
    const start = { itemId: item.id, graphemeOffset: 0 }
    const state = {
      ...base,
      selection: {
        anchor: start,
        head: {
          itemId: item.id,
          graphemeOffset:
            graphemeCount(base.projectionById[item.id]!.plain) - 1,
        },
        shape: "character" as const,
      },
    }
    const syntax = createEmberTideSyntax(theme)
    const h = await testRender(
      <scrollbox id="style-scroll" width="100%" height="100%">
        <box id={`transcript-item:${item.id}`}>
          <MarkdownMessage item={item} syntax={syntax} />
        </box>
      </scrollbox>,
      { width: 80, height: 45 },
    )
    try {
      for (const width of [80, 40]) {
        h.resize(width, 45)
        for (let frame = 0; frame < 3; frame++)
          await act(async () => {
            await h.flush()
            await h.renderOnce()
          })
        for (
          let attempt = 0;
          attempt < 100 && !h.captureCharFrame().includes("STRONG");
          attempt++
        )
          await act(async () => {
            await Bun.sleep(10)
            await h.flush()
            await h.renderOnce()
          })
        const spans = h.captureSpans().lines.flatMap((line) => line.spans)
        const span = (word: string) => {
          const found = spans.find((value) => value.text.includes(word))
          expect(found).toBeDefined()
          return found!
        }
        expect(span("Heading").attributes & TextAttributes.BOLD).toBe(
          TextAttributes.BOLD,
        )
        expect(span("QUOTATION").attributes & TextAttributes.ITALIC).toBe(
          TextAttributes.ITALIC,
        )
        expect(span("STRONG").attributes & TextAttributes.BOLD).toBe(
          TextAttributes.BOLD,
        )
        expect(span("EMPHASIS").attributes & TextAttributes.ITALIC).toBe(
          TextAttributes.ITALIC,
        )
        expect(span("LINK").attributes & TextAttributes.UNDERLINE).toBe(
          TextAttributes.UNDERLINE,
        )
        expect(span("TABLEBOLD").attributes & TextAttributes.BOLD).toBe(
          TextAttributes.BOLD,
        )
        expect(span("INLINE").fg.toString()).toBe(
          syntax.getStyle("markup.raw")!.fg!.toString(),
        )
        expect(span("REMOVED").fg.toString()).toBe(
          syntax.getStyle("markup.strikethrough")!.fg!.toString(),
        )
        const scroll = h.renderer.root.findDescendantById(
          "style-scroll",
        ) as ScrollBoxRenderable
        const layout = measureRenderedTranscript(h.renderer, scroll, state)!
        const plain = base.projectionById[item.id]!.plain
        for (const word of [
          "STRONG",
          "EMPHASIS",
          "INLINE",
          "List",
          "QUOTATION",
          "LINK",
          "TABLEBOLD",
          "const",
        ]) {
          const offset = graphemeCount(plain.slice(0, plain.indexOf(word)))
          const point = measuredPoint(layout, {
            itemId: item.id,
            graphemeOffset: offset,
          })!
          expect(point.screenX).toBeGreaterThanOrEqual(0)
          expect(point.screenX).toBeLessThan(width)
        }
        expect(selectedText(state, "source")).toBe(source)
        expect(selectedText(state, "plain")).toBe(plain)
      }
    } finally {
      await act(async () => h.renderer.destroy())
      syntax.destroy()
    }
  })
