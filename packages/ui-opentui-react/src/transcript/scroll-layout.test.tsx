import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { itemId, turnId } from "@vimex/conversation"
import { initialTranscript, syncTranscriptItem } from "@vimex/transcript"
import { ToolCall } from "./ToolCall"
import { measureRenderedTranscript, measuredPoint, topVisiblePoint } from "./rendered-layout"
import { createEmberTideSyntax } from "../theme"

test("native scroll translates cached points without remapping; resize invalidates geometry", async () => {
  const item = { id: itemId("scroll-cache"), turnId: turnId("turn"), kind: "command" as const, title: "Output", detail: Array.from({ length: 80 }, (_, i) => `${i}: ${"result ".repeat(12)}`).join("\n"), status: "complete" as const }
  const state = syncTranscriptItem(initialTranscript(), item)
  const h = await testRender(<scrollbox id="scroll" width="100%" height="100%"><box id={`transcript-item:${item.id}`}><ToolCall item={item} folded={false} /></box></scrollbox>, { width: 100, height: 20 })
  try {
    await act(async () => { await h.flush(); await h.renderOnce() })
    const scroll = h.renderer.root.findDescendantById("scroll") as ScrollBoxRenderable
    const initial = measureRenderedTranscript(h.renderer, scroll, state)!
    const point = { itemId: item.id, graphemeOffset: 20 }
    const initialY = measuredPoint(initial, point)!.screenY
    scroll.scrollBy(10, "step")
    await h.renderOnce()
    const moved = measureRenderedTranscript(h.renderer, scroll, state)!
    expect(moved.points).toBe(initial.points)
    expect(measuredPoint(moved, point)!.screenY).toBe(initialY - 10)
    expect(measuredPoint(initial, point)!.screenY).toBe(initialY)
    expect(topVisiblePoint(moved, scroll)!.screenY).toBe(scroll.viewport.screenY)
    expect(measureRenderedTranscript(h.renderer, scroll, state)).toBe(moved)
    scroll.scrollBy(-10, "step")
    await h.renderOnce()
    const restored = measureRenderedTranscript(h.renderer, scroll, state)!
    expect(restored.points).toBe(initial.points)
    expect(measuredPoint(restored, point)!.screenY).toBe(initialY)
    h.resize(50, 20)
    await act(async () => { await h.flush(); await h.renderOnce() })
    expect(measureRenderedTranscript(h.renderer, scroll, state)!.points).not.toBe(initial.points)
  } finally { await act(async () => h.renderer.destroy()) }
})

test("scrolling many settled Markdown items translates cached geometry", async () => {
  const items = Array.from({ length: 20 }, (_, index) => ({
    id: itemId(`markdown-${index}`), turnId: turnId(`turn-${index}`), kind: "assistant" as const,
    markdown: `## Answer ${index}\n\n${"Historical **Markdown** paragraph.\n\n".repeat(5)}`, status: "complete" as const,
  }))
  let state = initialTranscript()
  for (const item of items) state = syncTranscriptItem(state, item)
  const syntax = createEmberTideSyntax()
  const h = await testRender(<scrollbox id="scroll" width="100%" height="100%">{items.map(item =>
    <box id={`transcript-item:${item.id}`} key={item.id}><markdown id={`markdown:${item.id}`} content={item.markdown} syntaxStyle={syntax} conceal /></box>)}</scrollbox>, { width: 80, height: 20 })
  try {
    for (let index = 0; index < 8; index++) await act(async () => { await h.flush(); await h.renderOnce(); await Bun.sleep(2) })
    const scroll = h.renderer.root.findDescendantById("scroll") as ScrollBoxRenderable
    const initial = measureRenderedTranscript(h.renderer, scroll, state)!
    scroll.scrollBy(-7, "step")
    await h.renderOnce()
    const moved = measureRenderedTranscript(h.renderer, scroll, state)!
    expect(moved.points).toBe(initial.points)
  } finally {
    syntax.destroy()
    await act(async () => h.renderer.destroy())
  }
})
