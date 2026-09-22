import { expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { act } from "react"
import { blockKey } from "@vimex/transcript"
import { transcriptBlockRenderableId } from "./rendered-layout"
import { wheelHarness, answer } from "./scroll-continuity-harness"

test("brace navigation moves within viewport before minimally scrolling at its edges", async () => {
  // Sixty one-row paragraphs separated by one blank row, in one measured item.
  // This isolates viewport policy from cold-block estimates and window remounts.
  const h = await wheelHarness(0)
  const scroll = h.renderer.root.findDescendantById(
    "transcript",
  ) as ScrollBoxRenderable
  const settle = async () => {
    for (let i = 0; i < 4; i++)
      await act(async () => {
        await h.flush()
        await h.renderOnce()
      })
  }
  try {
    await act(async () => {
      h.controller.dispatchInteraction({ type: "mode.normal" })
      h.controller.dispatchInteraction({
        type: "focus.set",
        surface: "transcript",
      })
      h.controller.transcript({
        type: "cursor.move",
        target: { itemId: answer, graphemeOffset: 0 },
        preferredScreenRow: 0,
        extend: false,
      })
      await h.mockInput.typeText("gg")
    })
    await settle()
    const initialTop = scroll.scrollTop
    let expectedTop = initialTop
    async function move(key: "{" | "}", paragraph: number) {
      const documentRow = initialTop + paragraph * 2
      expectedTop =
        key === "}"
          ? Math.max(expectedTop, documentRow - (scroll.viewport.height - 1))
          : Math.min(expectedTop, documentRow)
      const paints: number[] = []
      const originalEmit = h.renderer.emit
      h.renderer.emit = function (event: string | symbol, ...args: unknown[]) {
        if (event === "frame") paints.push(scroll.scrollTop)
        return originalEmit.call(this, event, ...args)
      }
      try {
        await act(async () => {
          await h.mockInput.typeText(key)
          await h.flush()
          await h.renderOnce()
        })
        await settle()
      } finally {
        h.renderer.emit = originalEmit
      }
      expect(paints.length).toBeGreaterThan(0)
      for (const top of paints)
        expect(
          top,
          `${key} to paragraph ${paragraph} must scroll only enough to keep its cursor visible`,
        ).toBe(expectedTop)
      const frame = h.controller.transcriptRuntime("main")!.getSnapshot()
      const cursor = h.workspace().transcript.cursor!
      expect(cursor.itemId).toBe(answer)
      const block = frame.blocks.find(
        (b) => b.key.kind === "item" && b.key.itemId === answer,
      )!
      const geometry = frame.geometry.byBlockKey[blockKey(block)]!
      const localPoint = geometry.points[cursor.graphemeOffset]!
      expect(localPoint.row).toBe(paragraph * 2)
      const root = scroll.getRenderable(transcriptBlockRenderableId(block))!
      expect(root.screenY + localPoint.row - scroll.viewport.screenY).toBe(
        documentRow - expectedTop,
      )
    }
    for (let paragraph = 1; paragraph <= 10; paragraph++)
      await move("}", paragraph)
    for (let paragraph = 9; paragraph >= 0; paragraph--)
      await move("{", paragraph)
  } finally {
    await h.close()
  }
}, 30000)
