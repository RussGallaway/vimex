import { expect, test } from "bun:test"
import { act } from "react"
import type { ScrollBoxRenderable } from "@opentui/core"
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
  const previous = process.env.VIMEX_NAV_PREPARED_GEOMETRY
  process.env.VIMEX_NAV_PREPARED_GEOMETRY = enabled ? "1" : "0"
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
  const id = itemId("prepared-connected-command")
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
        getPreparedRuntimeGeometryDiagnostics(scrollbox(h))?.hits,
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
    await h.keys("v")
    await h.keys("6l")
    await settle(h)
    const selected = snapshot(h)
    if (!selected.selected) throw new Error("Expected canonical selection")
    expect(selected.selected.length).toBeGreaterThan(0)
    expect(selected.nativeSelection).toBe(selected.selected)
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
    return { checkpoints, copied }
  } finally {
    await h.close()
    if (previous === undefined) delete process.env.VIMEX_NAV_PREPARED_GEOMETRY
    else process.env.VIMEX_NAV_PREPARED_GEOMETRY = previous
  }
}

test("opt-in prepared runtime geometry preserves connected Ctrl-U/D, native selection, resize and yank", async () => {
  const native = await scenario(false)
  const prepared = await scenario(true)
  expect(prepared).toEqual(native)
}, 30_000)
