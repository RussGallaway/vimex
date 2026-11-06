import { expect, test } from "bun:test"
import { itemId } from "@vimex/conversation"
import type { ScrollBoxRenderable } from "@opentui/core"
import { act } from "react"
import { wheelHarness } from "./scroll-continuity-harness"
import { transcriptBlockRenderableId } from "./rendered-layout"

for (const focus of ["composer", "transcript"] as const)
  test(`retained window preserves ${focus} interaction and retains nearby roots`, async () => {
    const previous = process.env.VIMEX_NAV_RETAINED_WINDOW
    process.env.VIMEX_NAV_RETAINED_WINDOW = "1"
    const h = await wheelHarness(1000)
    const runtime = h.controller.transcriptRuntime("main")!
    const scroll = h.renderer.root.findDescendantById(
      "transcript",
    ) as ScrollBoxRenderable
    try {
      await act(async () => {
        h.controller.dispatchInteraction({ type: "mode.insert" })
        h.controller.dispatchInteraction({
          type: "focus.set",
          surface: "composer",
        })
        await h.mockInput.typeText("preserve this draft")
        h.controller.dispatchInteraction({ type: "mode.normal" })
        h.controller.dispatchInteraction({ type: "focus.set", surface: focus })
        const point = {
          itemId: itemId("scroll-command-500"),
          graphemeOffset: 0,
        }
        h.controller.transcript({
          type: "cursor.move",
          target: point,
          preferredScreenRow: 3,
          extend: false,
        })
        h.controller.transcript({
          type: "cursor.move",
          target: { ...point, graphemeOffset: 1 },
          preferredScreenRow: 3,
          extend: true,
        })
        h.controller.transcript({
          type: "viewport.anchor",
          point,
          preferredScreenRow: 3,
        })
        await h.flush({ maxPasses: 400 })
        await h.renderOnce()
      })
      const before = runtime.getSnapshot()
      const viewport = before.transcript.viewport
      const cursor = before.transcript.cursor
      const selection = before.transcript.selection
      const draft = h.workspace().composer
      expect(before.window.blocks.length).toBeGreaterThan(20)
      await act(async () => {
        await h.flush({ maxPasses: 400 })
        await h.renderOnce()
      })
      expect(runtime.getSnapshot().transcript.viewport).toEqual(viewport)
      expect(runtime.getSnapshot().transcript.cursor).toEqual(cursor)
      expect(runtime.getSnapshot().transcript.selection).toEqual(selection)
      expect(h.workspace().composer).toEqual(draft)
      expect(h.workspace().interaction.surface).toBe(focus)
      const prepared = new Map(
        runtime.getSnapshot().window.blocks.flatMap((block) => {
          const id = transcriptBlockRenderableId(block)
          const root = scroll.getRenderable(id)
          return root ? [[id, root] as const] : []
        }),
      )
      expect(prepared.size).toBeGreaterThan(0)
      for (let i = 0; i < 4; i++)
        await act(async () => {
          h.mockInput.pressKey("e", { ctrl: true })
          await h.flush({ maxPasses: 400 })
        })
      for (const [id, root] of prepared)
        expect(scroll.getRenderable(id) === root).toBe(true)
      expect(h.workspace().composer).toEqual(draft)
      expect(h.workspace().interaction.surface).toBe(focus)
    } finally {
      await h.close()
      if (previous === undefined) delete process.env.VIMEX_NAV_RETAINED_WINDOW
      else process.env.VIMEX_NAV_RETAINED_WINDOW = previous
    }
  }, 30000)
