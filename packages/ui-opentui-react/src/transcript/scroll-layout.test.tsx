import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { itemId, turnId } from "@vimex/conversation"
import { initialTranscript, syncTranscriptItem } from "@vimex/transcript"
import { ToolCall } from "./ToolCall"
import { measureRenderedTranscript, measuredPoint, topVisiblePoint } from "./rendered-layout"

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
