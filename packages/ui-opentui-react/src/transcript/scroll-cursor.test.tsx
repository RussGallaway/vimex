import { expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { act } from "react"
import { blockKey } from "@vimex/transcript"
import { transcriptBlockRenderableId } from "./rendered-layout"
import { wheelHarness, answer } from "./scroll-continuity-harness"

async function cursorHarness() {
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
  await act(async () => {
    h.resize(80, 26)
    h.controller.dispatchInteraction({ type: "mode.normal" })
    h.controller.dispatchInteraction({
      type: "focus.set",
      surface: "transcript",
    })
    const projection = h.workspace().transcript.projectionById[answer]!
    const offset = projection.plain.indexOf("Line 20 readable output")
    h.controller.transcript({
      type: "cursor.move",
      target: { itemId: answer, graphemeOffset: offset },
      preferredScreenRow: 6,
      extend: false,
    })
  })
  await settle()
  const position = () => {
    const frame = h.controller.transcriptRuntime("main")!.getSnapshot()
    const cursor = h.workspace().transcript.cursor!
    const block = frame.blocks.find(
      (b) => b.key.kind === "item" && b.key.itemId === cursor.itemId,
    )!
    const point =
      frame.geometry.byBlockKey[blockKey(block)]!.points[cursor.graphemeOffset]!
    const root = scroll.getRenderable(transcriptBlockRenderableId(block))!
    return {
      cursor,
      localRow: point.row,
      screenRow: root.screenY + point.row - scroll.viewport.screenY,
    }
  }
  const key = async (value: string, count = 1) => {
    const paints: ReturnType<typeof position>[] = []
    const originalEmit = h.renderer.emit
    h.renderer.emit = function (event: string | symbol, ...args: unknown[]) {
      if (event === "frame") paints.push(position())
      return originalEmit.call(this, event, ...args)
    }
    try {
      await act(async () => {
        for (let i = 0; i < count; i++)
          h.mockInput.pressKey(value, { ctrl: true })
        await h.flush()
        await h.renderOnce()
      })
      await settle()
      expect(paints.length).toBeGreaterThan(0)
      for (const paint of paints) expect(paint).toEqual(position())
    } finally {
      h.renderer.emit = originalEmit
    }
  }
  return { ...h, scroll, position, key, settle }
}

test("transcript Ctrl-U/D move cursor with viewport at the same screen row", async () => {
  const h = await cursorHarness()
  try {
    const before = h.position(),
      top = h.scroll.scrollTop,
      half = h.scroll.viewport.height / 2
    expect(half % 2).toBe(0) // Paragraph starts remain addressable after the move.
    await h.key("u")
    expect(h.scroll.scrollTop).toBe(top - half)
    expect(h.position().screenRow).toBe(before.screenRow)
    expect(h.position().localRow).toBe(before.localRow - half)
    await h.key("d")
    expect(h.scroll.scrollTop).toBe(top)
    expect(h.position()).toEqual(before)
  } finally {
    await h.close()
  }
})

for (const key of ["y", "e"] as const)
  test(`transcript Ctrl-${key} preserves visible cursor then clamps it before brace navigation`, async () => {
    const h = await cursorHarness()
    try {
      const before = h.position()
      await h.key(key)
      expect(h.position().cursor).toEqual(before.cursor)
      expect(h.position().screenRow).toBe(
        before.screenRow + (key === "y" ? 1 : -1),
      )
      await h.key(key, 16)
      const clamped = h.position()
      expect(clamped.cursor).not.toEqual(before.cursor)
      expect(clamped.screenRow).toBeGreaterThanOrEqual(0)
      expect(clamped.screenRow).toBeLessThan(h.scroll.viewport.height)
      expect(
        key === "y"
          ? h.scroll.viewport.height - 1 - clamped.screenRow
          : clamped.screenRow,
      ).toBeLessThanOrEqual(1)
      await act(async () => {
        await h.mockInput.typeText("{")
        await h.flush()
        await h.renderOnce()
      })
      await h.settle()
      expect(h.position().localRow).toBe(clamped.localRow - 2)
    } finally {
      await h.close()
    }
  })

test("composer scrolling preserves transcript cursor and draft", async () => {
  const h = await cursorHarness()
  try {
    await act(async () => {
      h.controller.changeDraft("keep composing", 3)
      h.controller.dispatchInteraction({
        type: "focus.set",
        surface: "composer",
      })
    })
    const cursor = h.workspace().transcript.cursor
    const composer = h.workspace().composer
    for (const key of ["u", "d", "y", "e"]) await h.key(key)
    expect(h.workspace().transcript.cursor).toEqual(cursor)
    expect(h.workspace().composer).toEqual(composer)
    expect(h.workspace().interaction.surface).toBe("composer")
  } finally {
    await h.close()
  }
})

test("Ctrl-U then brace in one input batch navigates from the scrolled cursor", async () => {
  const h = await cursorHarness()
  try {
    const before = h.position(),
      top = h.scroll.scrollTop,
      half = h.scroll.viewport.height / 2
    const painted: ReturnType<typeof h.position>[] = []
    const originalEmit = h.renderer.emit
    h.renderer.emit = function (event: string | symbol, ...args: unknown[]) {
      if (event === "frame") painted.push(h.position())
      return originalEmit.call(this, event, ...args)
    }
    try {
      await act(async () => {
        h.mockInput.pressKey("u", { ctrl: true })
        await h.mockInput.typeText("{")
        await h.flush()
        await h.renderOnce()
      })
      await h.settle()
    } finally {
      h.renderer.emit = originalEmit
    }
    expect(h.scroll.scrollTop).toBe(top - half)
    expect(h.position().localRow).toBe(before.localRow - half - 2)
    expect(h.position().screenRow).toBe(before.screenRow - 2)
    expect(painted.length).toBeGreaterThan(0)
    for (const paint of painted) expect(paint).toEqual(h.position())
  } finally {
    await h.close()
  }
})
