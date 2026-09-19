import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useState } from "react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createConversation, itemId, reduceConversation, threadId, turnId } from "@vimex/conversation"
import { initialTranscript, syncTranscriptItem, TranscriptRuntime } from "@vimex/transcript"
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

test("cached native text avoids repeated reads and observes late equal-height reflow", async () => {
  const item = { id: itemId("late-text"), turnId: turnId("turn"), kind: "assistant" as const, markdown: "abcd", status: "running" as const }
  const state = syncTranscriptItem(initialTranscript(), item)
  const h = await testRender(<scrollbox id="scroll" width={40} height={8}>
    <box id={`transcript-item:${item.id}`}><text id="late-native-text">{"ab\ncd"}</text></box>
  </scrollbox>, { width: 40, height: 8 })
  try {
    await act(async () => { await h.flush(); await h.renderOnce() })
    const scroll = h.renderer.root.findDescendantById("scroll") as ScrollBoxRenderable
    const text = h.renderer.root.findDescendantById("late-native-text") as import("@opentui/core").TextRenderable
    const first = measureRenderedTranscript(h.renderer, scroll, state)!
    let reads = 0
    let prototype: object | null = text
    let getter: (() => string) | undefined
    while (prototype && !getter) {
      getter = Object.getOwnPropertyDescriptor(prototype, "plainText")?.get as (() => string) | undefined
      prototype = Object.getPrototypeOf(prototype)
    }
    Object.defineProperty(text, "plainText", { configurable: true, get() { reads++; return getter!.call(text) } })
    for (let frame = 0; frame < 40; frame++) {
      await h.renderOnce()
      expect(measureRenderedTranscript(h.renderer, scroll, state)).toBe(first)
    }
    expect(reads).toBe(0)
    // Highlight completion may announce unchanged geometry. Preserve cache
    // identity after checking values, rather than remapping on every event.
    text.emit("line-info-change")
    expect(measureRenderedTranscript(h.renderer, scroll, state)).toBe(first)
    expect(reads).toBe(1)
    const point = { itemId: item.id, graphemeOffset: 1 }
    expect(measuredPoint(first, point)!.screenY).toBe(0)
    // This native-only update has the same dimensions and character count.
    // No transcript revision or fixed settling window may conceal its reflow.
    text.content = "a\nbcd"
    await act(async () => { await h.flush(); await h.renderOnce() })
    const changed = measureRenderedTranscript(h.renderer, scroll, state)!
    expect(changed.points).not.toBe(first.points)
    expect(measuredPoint(changed, point)!.screenY).toBe(1)
    expect(measuredPoint(first, point)!.screenY).toBe(0)
  } finally { await act(async () => h.renderer.destroy()) }
})

test("a block-damage append is discovered after an initially empty render plan", async () => {
  const thread = threadId("append-thread")
  const turn = turnId("append-turn")
  const item = { id: itemId("appended"), turnId: turn, kind: "assistant" as const, markdown: "new answer", status: "running" as const }
  let conversation = createConversation(thread)
  let transcript = initialTranscript()
  let revision = 0
  const runtime = new TranscriptRuntime({
    threadId: thread, canonicalGeneration: 0, canonicalRevision: revision,
    conversation, transcript, mode: "follow", canonicalDamage: { kind: "none" },
  })
  let mount = () => {}
  function Harness() {
    const [visible, setVisible] = useState(false)
    mount = () => setVisible(true)
    return <scrollbox id="scroll" width={40} height={8}>{visible
      ? <box id={`transcript-block:${item.id}:root`} width={40} height={1}><text>{item.markdown}</text></box>
      : null}</scrollbox>
  }
  const h = await testRender(<Harness />, { width: 40, height: 8 })
  try {
    await act(async () => { await h.flush(); await h.renderOnce() })
    const scroll = h.renderer.root.findDescendantById("scroll") as ScrollBoxRenderable
    expect(measureRenderedTranscript(h.renderer, scroll, { frame: runtime.getSnapshot(), runtime, styleRevision: "test" })).toBeUndefined()

    conversation = reduceConversation(conversation, { type: "turn.started", threadId: thread, turnId: turn })
    revision++
    conversation = reduceConversation(conversation, { type: "item.started", threadId: thread, item })
    revision++
    transcript = syncTranscriptItem(transcript, conversation.items[item.id]!)
    const appended = runtime.update({
      threadId: thread, canonicalGeneration: 0, canonicalRevision: revision,
      conversation, transcript, mode: "follow", canonicalDamage: { kind: "blocks", itemIds: [item.id] },
    })
    await act(async () => { mount(); await h.flush(); await h.renderOnce(); await h.renderOnce() })
    expect(measureRenderedTranscript(h.renderer, scroll, { frame: appended, runtime, styleRevision: "test" })).toBeUndefined()
    const measured = runtime.getSnapshot()
    expect(Object.keys(measured.geometry.byBlockKey)).toEqual([`item:${item.id}:root`])
    expect(measured.geometry.byBlockKey[`item:${item.id}:root`]?.key.contentRevision).toBe(appended.blocks[0]?.contentRevision)
    expect(measured.geometry.totalPoints).toBeGreaterThan(0)
    expect(measureRenderedTranscript(h.renderer, scroll, { frame: measured, runtime, styleRevision: "test" })).toBeDefined()
  } finally { await act(async () => h.renderer.destroy()) }
})
