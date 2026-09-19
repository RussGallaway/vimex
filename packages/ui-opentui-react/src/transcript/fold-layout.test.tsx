import { expect, test } from "bun:test"
import { MarkdownRenderable, TextBufferRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { itemId, turnId } from "@vimex/conversation"
import { initialTranscript, projectItem, setFold, syncTranscriptItem, type TranscriptState } from "@vimex/transcript"
import { act, useState } from "react"
import { createEmberTideSyntax } from "../theme"
import { ReasoningBlock } from "./ReasoningBlock"
import { ToolCall } from "./ToolCall"
import { measureRenderedTranscript } from "./rendered-layout"

test("folding one item reuses and translates unchanged item geometry", async () => {
  const items = ["before", "folded", "after"].map((name, index) => ({
    id: itemId(name), turnId: turnId(`turn-${index}`), kind: "reasoning" as const,
    markdown: `${name}\n\n${Array.from({ length: index === 1 ? 14 : 4 }, (_, line) => `${name} detail ${line}`).join("\n\n")}`,
    status: "complete" as const,
  }))
  let base = initialTranscript()
  // Reasoning renderer geometry remains reusable by a future inspector even
  // though primary transcript projection intentionally excludes these items.
  for (const item of items) base = { ...base, order: [...base.order, item.id], projectionById: { ...base.projectionById, [item.id]: projectItem(item) } }
  let current: TranscriptState = base
  let toggleFold = () => {}
  const syntax = createEmberTideSyntax()

  function Harness() {
    const [folded, setFolded] = useState(false)
    toggleFold = () => setFolded(value => !value)
    current = setFold(base, items[1]!.id, folded)
    return <scrollbox id="scroll" width="100%" height="100%">
      {items.map((item, index) => <box id={`transcript-item:${item.id}`} key={item.id}>
        <ReasoningBlock item={item} folded={index === 1 && folded} syntax={syntax} />
      </box>)}
    </scrollbox>
  }

  // Keep the vertical scrollbar present in both states. A scrollbar appearing
  // or disappearing changes the Markdown width and must invalidate every item.
  const h = await testRender(<Harness />, { width: 80, height: 12 })
  try {
    for (let index = 0; index < 5; index++) await act(async () => { await h.flush(); await h.renderOnce(); await Bun.sleep(2) })
    const scroll = h.renderer.root.findDescendantById("scroll") as ScrollBoxRenderable
    const initial = measureRenderedTranscript(h.renderer, scroll, current)!
    const initialAfterY = initial.points![items[2]!.id]![0]!.screenY

    const reads: [number, number] = [0, 0]
    for (const [counter, item] of [items[0], items[2]].entries()) {
      const markdown = h.renderer.root.findDescendantById(`markdown:${item!.id}`) as MarkdownRenderable
      const block = (markdown as unknown as { _blockStates: readonly { renderable: TextBufferRenderable }[] })._blockStates[0]!.renderable
      let prototype: object | null = block
      let getter: (() => string) | undefined
      while (prototype && !getter) {
        getter = Object.getOwnPropertyDescriptor(prototype, "plainText")?.get as (() => string) | undefined
        prototype = Object.getPrototypeOf(prototype)
      }
      expect(getter).toBeDefined()
      Object.defineProperty(block, "plainText", { configurable: true, get() {
        if (counter === 0) reads[0] += 1
        else reads[1] += 1
        return getter!.call(block)
      } })
      // Force a native invalidation to establish the checked-but-unchanged
      // cost. A real remap reads the text again to construct point geometry.
      block.emit("line-info-change")
    }

    // An invalidated fingerprint reads settled Markdown once; an unchanged
    // cached fingerprint requires no native text reads.
    measureRenderedTranscript(h.renderer, scroll, current)
    const fingerprintReads: [number, number] = [reads[0], reads[1]]
    reads.fill(0)

    await act(async () => { toggleFold() })
    await act(async () => { await h.flush(); await h.renderOnce() })
    const folded = measureRenderedTranscript(h.renderer, scroll, current)!
    expect(reads[0]).toBeLessThanOrEqual(fingerprintReads[0])
    expect(reads[1]).toBeLessThanOrEqual(fingerprintReads[1])
    expect(folded.points![items[2]!.id]![0]!.screenY).toBeLessThan(initialAfterY)
    expect(initial.points![items[2]!.id]![0]!.screenY).toBe(initialAfterY)
    expect(folded.points![items[2]!.id]).not.toBe(initial.points![items[2]!.id])
  } finally {
    syntax.destroy()
    await act(async () => h.renderer.destroy())
  }
})

test("folded point fallback reads a large projection a bounded number of times", async () => {
  const item = {
    id: itemId("large-fold"), turnId: turnId("large-fold-turn"), kind: "command" as const,
    title: "Large output", detail: Array.from({ length: 200 }, (_, index) => `${index}: output`).join("\n"), status: "complete" as const,
  }
  let state = setFold(syncTranscriptItem(initialTranscript(), item), item.id, true)
  const projection = state.projectionById[item.id]!
  let reads = 0
  const counted = { ...projection }
  Object.defineProperty(counted, "plain", { enumerable: true, get() { reads += 1; return projection.plain } })
  state = { ...state, projectionById: { ...state.projectionById, [item.id]: counted } }
  const h = await testRender(<scrollbox id="scroll" width="100%" height="100%">
    <box id={`transcript-item:${item.id}`}><ToolCall item={item} folded /></box>
  </scrollbox>, { width: 80, height: 12 })
  try {
    await act(async () => { await h.flush(); await h.renderOnce() })
    const layout = measureRenderedTranscript(h.renderer, h.renderer.root.findDescendantById("scroll") as ScrollBoxRenderable, state)!
    expect(Object.keys(layout.points![item.id]!).length).toBeLessThan(32)
    expect(layout.points![item.id]![projection.sourceSpans.length]?.hidden).toBe(true)
    expect(reads).toBeLessThan(10)
  } finally {
    await act(async () => h.renderer.destroy())
  }
})
