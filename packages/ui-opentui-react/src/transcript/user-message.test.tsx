import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { ScrollBoxRenderable } from "@opentui/core"
import { act, createRef } from "react"
import { itemId, turnId } from "@vimex/conversation"
import { graphemeCount, initialTranscript, selectedText, syncTranscriptItem } from "@vimex/transcript"
import { TranscriptViewport } from "./TranscriptViewport"
import { measureRenderedTranscript, measuredPoint } from "./rendered-layout"
import { createEmberTideSyntax } from "../theme"

test("sent user panels preserve exact selectable Markdown without a role label through narrow reflow", async () => {
  const item = { id: itemId("user"), turnId: turnId("turn"), kind: "user" as const, markdown: "You asked for **clearer** text 🙂 with a longer line that wraps.", status: "complete" as const }
  const base = syncTranscriptItem(initialTranscript(), item)
  const from = { itemId: item.id, graphemeOffset: 0 }
  const to = { itemId: item.id, graphemeOffset: graphemeCount(base.projectionById[item.id]!.plain) - 1 }
  const state = { ...base, cursor: from, selection: { anchor: from, head: to, shape: "character" as const } }
  const scrollRef = createRef<ScrollBoxRenderable>()
  const syntax = createEmberTideSyntax()
  const blocks = [{ key: { kind: "item" as const, itemId: item.id, blockId: "root" as const }, turnId: item.turnId, item, renderItem: item,
    projection: state.projectionById[item.id]!, sourceSpan: { from: 0, to: item.markdown.length }, contentRevision: 1, estimatedRows: 1, followedByActivity: false }]
  const h = await testRender(<TranscriptViewport window={{ blocks, topSpacerRows: 2, bottomSpacerRows: 3, overscanRows: 1 }} state={state} surface="transcript" syntax={syntax} scrollRef={scrollRef} />, { width: 80, height: 20 })
  try {
    for (const width of [80, 38]) {
      h.resize(width, 20)
      for (let frame = 0; frame < 3; frame++) await act(async () => { await h.flush(); await h.renderOnce() })
      expect(h.renderer.root.findDescendantById(`decoration:user-label:${item.id}`)).toBeUndefined()
      expect(h.renderer.root.findDescendantById("transcript-top-spacer")?.height).toBe(2)
      expect(h.renderer.root.findDescendantById("transcript-bottom-spacer")?.height).toBe(3)
      const markdown = h.renderer.root.findDescendantById(`markdown:${item.id}`)!
      expect(markdown.id).toBe(`markdown:${item.id}`)
      const layout = measureRenderedTranscript(h.renderer, scrollRef.current!, state)!
      const first = measuredPoint(layout, from)!
      const last = measuredPoint(layout, to)!
      expect(first.screenY).toBe(markdown.screenY)
      expect(first.screenX).toBe(markdown.screenX)
      expect(last.screenY).toBeGreaterThanOrEqual(first.screenY)
      expect(last.screenX).toBeLessThan(width)
      expect(selectedText(state, "plain")).toBe("You asked for clearer text 🙂 with a longer line that wraps.")
      expect(selectedText(state, "source")).toBe(item.markdown)
    }
  } finally { await act(async () => h.renderer.destroy()); syntax.destroy() }
})
