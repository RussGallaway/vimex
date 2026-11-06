import { expect, test } from "bun:test"
import { act } from "react"
import type { ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { itemId, turnId } from "@vimex/conversation"
import { blockGraphemeRange, selectedText } from "@vimex/transcript"
import { wheelHarness, thread } from "../navigation/scroll-continuity-harness"
import {
  getPreparedRuntimeGeometryDiagnostics,
  measuredPoint,
  readRenderedTranscriptLayout,
} from "../native-layout/rendered-layout"

type Harness = Awaited<ReturnType<typeof wheelHarness>>
const scrollbox = (h: Harness) =>
  h.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable

async function settle(h: Harness, passes = 12) {
  for (let index = 0; index < passes; index++)
    await act(async () => {
      await Bun.sleep(2)
      await h.flush({ maxPasses: 300 })
      await h.renderOnce()
    })
}

function snapshot(h: Harness) {
  const scroll = scrollbox(h)
  const frame = h.controller.transcriptRuntime("main")!.getSnapshot()
  const layout = readRenderedTranscriptLayout(scroll, frame)!
  const cursor = h.workspace().transcript.cursor!
  const point = measuredPoint(layout, cursor)
  return {
    cursor,
    viewport: h.workspace().transcript.viewport,
    selection: h.workspace().transcript.selection,
    selected: selectedText(h.workspace().transcript, "plain"),
    nativeSelection: h.renderer.getSelection()?.getSelectedText(),
    point: point && {
      row: point.row,
      column: point.column,
      screenY: point.screenY,
      screenX: point.screenX,
    },
    paint: h
      .captureCharFrame()
      .split("\n")
      .slice(scroll.viewport.y, scroll.viewport.y + scroll.viewport.height)
      .map((line) =>
        line.slice(
          scroll.viewport.x,
          scroll.viewport.x + scroll.viewport.width - 1,
        ),
      ),
  }
}

async function scenario(enabled: boolean) {
  const previous = process.env.VIMEX_NAV_PREPARED_PAINT
  const previousGeometry = process.env.VIMEX_NAV_PREPARED_GEOMETRY
  process.env.VIMEX_NAV_PREPARED_PAINT = enabled ? "1" : "0"
  // Painting must imply geometry without requiring a second user flag.
  process.env.VIMEX_NAV_PREPARED_GEOMETRY = "0"
  const h = await wheelHarness(0, true)
  const copied: string[] = []
  // The reused harness owns a fake clipboard port, never the host clipboard.
  const ports = (
    h.controller as unknown as {
      ports: { clipboard: { writeText(text: string): Promise<void> } }
    }
  ).ports
  ports.clipboard.writeText = async (text) => {
    copied.push(text)
  }
  const id = itemId("prepared-paint-connected-command")
  try {
    await act(async () => {
      h.emit({
        type: "conversation",
        event: {
          type: "item.started",
          threadId: thread,
          item: {
            id,
            turnId: turnId("prepared-connected-turn"),
            kind: "command",
            title: "Large completed output",
            status: "complete",
            detail: Array.from(
              { length: 160 },
              (_, row) =>
                `ROW ${String(row).padStart(3, "0")} alpha beta 界面 é deterministic output`,
            ).join("\n"),
          },
        },
      })
      await h.controller.settle()
      h.controller.transcript({ type: "fold.all", folded: false })
      h.controller.dispatchInteraction({ type: "mode.normal" })
      h.controller.dispatchInteraction({
        type: "focus.set",
        surface: "transcript",
      })
    })
    await settle(h)
    const frame = h.controller.transcriptRuntime("main")!.getSnapshot()
    const final = frame.blocks.find(
      (block) =>
        "item" in block &&
        block.key.itemId === id &&
        block.fragment?.kind === "command-output" &&
        block.fragment.index === block.fragment.count - 1,
    )!
    expect(final).toBeDefined()
    if (!("item" in final)) throw new Error("Expected command output")
    const range = blockGraphemeRange(final)
    await act(async () => {
      h.controller.transcript({
        type: "cursor.move",
        target: { itemId: id, graphemeOffset: range.from + 100 },
        preferredScreenRow: 3,
        extend: false,
      })
    })
    await settle(h)
    const before = snapshot(h)
    expect(before.paint.some((row) => row.includes("ROW"))).toBe(true)
    if (enabled)
      expect(
        getPreparedRuntimeGeometryDiagnostics(scrollbox(h))?.preparedPaints,
      ).toBeGreaterThan(0)
    else
      expect(
        getPreparedRuntimeGeometryDiagnostics(scrollbox(h)),
      ).toBeUndefined()
    const checkpoints = [before]
    // Real production input dispatch, including reversal across fragment edges.
    for (const direction of ["u", "u", "u", "d", "d"] as const) {
      await act(async () => h.mockInput.pressKey(direction, { ctrl: true }))
      await settle(h, 6)
      checkpoints.push(snapshot(h))
    }
    // Accepted bursts retain their order even while preparation is pending.
    for (const direction of ["u", "d"] as const) {
      await act(async () => {
        for (let index = 0; index < 8; index++)
          h.mockInput.pressKey(direction, { ctrl: true })
      })
      await settle(h, 16)
      checkpoints.push(snapshot(h))
    }
    // Exercise selection on the eligible final fragment, not its native header.
    await act(async () => {
      h.controller.transcript({
        type: "cursor.move",
        target: { itemId: id, graphemeOffset: range.from + 100 },
        preferredScreenRow: 3,
        extend: false,
      })
    })
    await settle(h)
    const paintsBeforeSelection =
      getPreparedRuntimeGeometryDiagnostics(scrollbox(h))?.preparedPaints ?? 0
    await h.keys("v")
    await h.keys("6l")
    await settle(h)
    const selected = snapshot(h)
    if (!selected.selected) throw new Error("Expected canonical selection")
    expect(selected.selected.length).toBeGreaterThan(0)
    expect(selected.nativeSelection).toBe(selected.selected)
    if (enabled)
      expect(
        getPreparedRuntimeGeometryDiagnostics(scrollbox(h))
          ?.nativePaintFallbacks,
      ).toBeGreaterThan(0)
    checkpoints.push(selected)
    await act(async () => {
      h.resize(62, 20)
      await h.flush()
      await h.renderOnce()
    })
    await settle(h)
    const resized = snapshot(h)
    expect(resized.selection).toEqual(selected.selection)
    expect(resized.selected).toBe(selected.selected)
    expect(resized.nativeSelection).toBe(selected.selected)
    checkpoints.push(resized)
    await h.keys("y")
    await h.controller.settle()
    await settle(h, 4)
    expect(copied).toEqual([selected.selected])
    expect(h.workspace().transcript.selection).toBeUndefined()
    if (enabled)
      expect(
        getPreparedRuntimeGeometryDiagnostics(scrollbox(h))?.preparedPaints,
      ).toBeGreaterThan(paintsBeforeSelection)
    // Native hit testing/copy must still refer to original source after prepared
    // row painting. Find a visible output row rather than guessing screen offsets.
    const rows = h.captureCharFrame().split("\n")
    const body = h.renderer.root.findDescendantById(
      `tool-output:${id}:${final.key.blockId}`,
    ) as TextRenderable
    expect(body).toBeDefined()
    const y = rows.findIndex(
      (row, index) =>
        index >= scrollbox(h).viewport.y &&
        index < scrollbox(h).viewport.y + scrollbox(h).viewport.height &&
        index >= body.screenY &&
        index < body.screenY + body.height &&
        row.includes("ROW "),
    )
    expect(y).toBeGreaterThanOrEqual(0)
    const x = rows[y]!.indexOf("ROW ")
    await act(async () => {
      await h.mockMouse.pressDown(x, y)
      await h.mockMouse.moveTo(x + 2, y)
      await h.renderOnce()
    })
    expect(h.renderer.getSelection()?.getSelectedText()).toBe("ROW")
    checkpoints.push(snapshot(h))
    await act(async () => {
      await h.mockMouse.release(x + 2, y)
      await h.flush()
    })
    await h.controller.settle()
    await settle(h, 4)
    expect(copied).toEqual([selected.selected, "ROW"])
    checkpoints.push(snapshot(h))
    return { checkpoints, copied }
  } finally {
    await h.close()
    if (previous === undefined) delete process.env.VIMEX_NAV_PREPARED_PAINT
    else process.env.VIMEX_NAV_PREPARED_PAINT = previous
    if (previousGeometry === undefined)
      delete process.env.VIMEX_NAV_PREPARED_GEOMETRY
    else process.env.VIMEX_NAV_PREPARED_GEOMETRY = previousGeometry
  }
}

test("opt-in prepared painting preserves connected held reversal, selection, resize, yank and mouse copy", async () => {
  const native = await scenario(false)
  const prepared = await scenario(true)
  expect(prepared).toEqual(native)
}, 30_000)
