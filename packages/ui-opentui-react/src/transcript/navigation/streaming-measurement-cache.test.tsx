import { expect, test } from "bun:test"
import {
  MarkdownRenderable,
  type Renderable,
  type ScrollBoxRenderable,
} from "@opentui/core"
import { markdownMeasurementCacheStats } from "../native-layout/measure-rendered-block"
import { graphemes, selectedText } from "@vimex/transcript"
import { act } from "react"
import { answer, thread, wheelHarness } from "./scroll-continuity-harness"

type Harness = Awaited<ReturnType<typeof wheelHarness>>

async function settle(h: Harness) {
  await h.controller.settle()
  await h.flush({ maxPasses: 500 })
  await h.renderOnce()
}

function placement(h: Harness) {
  const state = h.workspace().transcript
  const scroll = h.renderer.root.findDescendantById(
    "transcript",
  ) as ScrollBoxRenderable
  const cursor = h.renderer.getCursorState()
  return {
    cursor: state.cursor,
    viewport: state.viewport,
    nativeCursor: { x: cursor.x, y: cursor.y, visible: cursor.visible },
    cells: h
      .captureCharFrame()
      .split("\n")
      .slice(
        scroll.viewport.screenY,
        scroll.viewport.screenY + scroll.viewport.height,
      )
      .map((line) =>
        line.slice(
          scroll.viewport.screenX,
          scroll.viewport.screenX + scroll.viewport.width,
        ),
      ),
  }
}

async function traverse(cached: boolean) {
  const previous = {
    cache: process.env.VIMEX_NAV_MARKDOWN_MEASUREMENT_CACHE,
    retained: process.env.VIMEX_NAV_RETAINED_WINDOW,
  }
  process.env.VIMEX_NAV_MARKDOWN_MEASUREMENT_CACHE = cached ? "1" : "0"
  process.env.VIMEX_NAV_RETAINED_WINDOW = "1"
  const h = await wheelHarness(0)
  try {
    const original = h.workspace().conversation.items[answer]!
    if (original.kind !== "assistant")
      throw new Error("Expected running answer")
    const paragraph =
      "\n\nReadable active answer with **emphasis**, [a link](https://vimex.test), café and 東京."
    await act(async () => {
      h.emit({
        type: "conversation",
        event: {
          type: "item.delta",
          threadId: thread,
          itemId: answer,
          delta: paragraph.repeat(70),
        },
      })
      await settle(h)
      h.controller.dispatchInteraction({ type: "mode.normal" })
      h.controller.dispatchInteraction({
        type: "focus.set",
        surface: "transcript",
      })
    })
    await h.keys("G")
    const snapshots: ReturnType<typeof placement>[] = []
    for (const [index, key] of [
      "u",
      "y",
      "e",
      "d",
      "u",
      "e",
      "y",
      "d",
    ].entries()) {
      await act(async () => {
        h.emit({
          type: "conversation",
          event: {
            type: "item.delta",
            threadId: thread,
            itemId: answer,
            delta: ` next token ${index}`,
          },
        })
        h.mockInput.pressKey(key, { ctrl: true })
        await settle(h)
      })
      snapshots.push(placement(h))
      if (index === 3) {
        await act(async () => {
          h.resize(48, 24)
          await settle(h)
        })
        snapshots.push(placement(h))
      }
    }
    // A source replacement must invalidate cached local mappings, even when a
    // native root survives and the item remains a running, unfragmented message.
    await act(async () => {
      const item = h.workspace().conversation.items[answer]!
      if (item.kind !== "assistant") throw new Error("Expected running answer")
      h.emit({
        type: "conversation",
        event: {
          type: "item.started",
          threadId: thread,
          item: {
            ...item,
            markdown: item.markdown.replace("Readable active", "Updated"),
          },
        },
      })
      await settle(h)
    })
    snapshots.push(placement(h))
    await act(async () => {
      const plain = h.workspace().transcript.projectionById[answer]!.plain
      const offset = graphemes(
        plain.slice(0, plain.lastIndexOf("Readable active")),
      ).length
      h.controller.transcript({
        type: "cursor.move",
        target: { itemId: answer, graphemeOffset: offset },
        preferredScreenRow: 5,
        extend: false,
      })
      await settle(h)
    })
    await h.keys("v4l")
    const semanticSelection = selectedText(h.workspace().transcript, "plain")
    const nativeSelection = h.renderer.getSelection()?.getSelectedText()
    if (!semanticSelection) throw new Error("Expected nonempty selection")
    expect(semanticSelection.length).toBeGreaterThan(0)
    expect(nativeSelection).toBe(semanticSelection)
    await h.keys("y")
    await h.controller.settle()
    // wheelHarness supplies a no-op fake clipboard. The shared Vim register
    // verifies the actual yank result without accessing the host clipboard.
    const copied = h.workspace().interaction.unnamedRegister.text
    expect(copied).toBe(semanticSelection)
    if (cached) {
      const pending: Renderable[] = [h.renderer.root]
      let hits = 0
      while (pending.length) {
        const node = pending.pop()!
        if (node instanceof MarkdownRenderable)
          hits += markdownMeasurementCacheStats(node)?.hits ?? 0
        pending.push(...node.getChildren())
      }
      expect(hits).toBeGreaterThan(0)
    }
    return { snapshots, semanticSelection, nativeSelection, copied }
  } finally {
    await h.close()
    for (const [name, value] of [
      ["VIMEX_NAV_MARKDOWN_MEASUREMENT_CACHE", previous.cache],
      ["VIMEX_NAV_RETAINED_WINDOW", previous.retained],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test("cached growing Markdown preserves navigation, resize, source replacement, and selection/copy", async () => {
  const native = await traverse(false)
  const cached = await traverse(true)
  expect(cached).toEqual(native)
}, 60000)
