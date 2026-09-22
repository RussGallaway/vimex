// Run: bun scripts/transcript-scroll-repro.tsx [output.json]
// Headless painted-frame evidence, not a real-terminal smoothness acceptance test.
// Actions are a sequential workload: Y starts at the destination of earlier U/D.
// The stream updates the first running assistant item; this is not tail streaming.
// Dense mode is a diagnostic reference at 100 tools, not a scalability proposal.
import assert from "node:assert/strict"
import { blockKey } from "@vimex/transcript"
import type { ScrollBoxRenderable } from "@opentui/core"
import { act } from "react"
import {
  wheelHarness,
  thread,
  answer,
} from "../packages/ui-opentui-react/src/transcript/scroll-continuity-harness"

function nativeBlockRoots(scroll: ScrollBoxRenderable) {
  const roots: Array<{ id: string; y: number; height: number }> = []
  const pending = [...scroll.getChildren()]
  while (pending.length) {
    const renderable = pending.pop()!
    if (renderable.id.startsWith("transcript-block:"))
      roots.push({
        id: renderable.id,
        y: renderable.y,
        height: renderable.height,
      })
    pending.push(...renderable.getChildren())
  }
  return roots
}

const runs: unknown[] = []
for (const dense of [false, true])
  for (const expanded of [false, true]) {
    const h = await wheelHarness(100, expanded, dense)
    const scroll = h.renderer.root.findDescendantById(
      "transcript",
    ) as ScrollBoxRenderable
    let action = "settle"
    let inputAt = performance.now()
    const frames: Array<Record<string, unknown>> = []
    const originalEmit = h.renderer.emit
    // Capture BEFORE listeners run: useTranscriptLayout's frame listener can mutate
    // native scroll position and publish geometry after this frame was painted.
    h.renderer.emit = function (event: string | symbol, ...args: unknown[]) {
      if (event === "frame") {
        const frame = h.controller.transcriptRuntime("main")!.getSnapshot()
        const screen = h.captureCharFrame().split("\n")
        const visible = screen.slice(
          scroll.viewport.y,
          scroll.viewport.y + scroll.viewport.height,
        )
        frames.push({
          frame: frames.length,
          action,
          afterInputMs: performance.now() - inputAt,
          nativeTop: scroll.scrollTop,
          nativeHeight: scroll.scrollHeight,
          viewportY: scroll.viewport.y,
          viewportHeight: scroll.viewport.height,
          semantic: h.workspace().transcript.viewport,
          cursor: h.workspace().transcript.cursor,
          interaction: h.workspace().interaction,
          presentationRevision: frame.presentationRevision,
          measuredBlocks: frame.geometry.measuredBlockCount,
          topSpacer: frame.window.topSpacerRows,
          bottomSpacer: frame.window.bottomSpacerRows,
          plannedBlockKeys: frame.window.blocks.map(blockKey),
          nativeBlockRoots: nativeBlockRoots(scroll),
          geometryRevision: frame.geometry.revision,
          geometryTotalRows: frame.geometry.totalRows,
          visible,
          blank: visible.every((line) => !line.trim()),
        })
      }
      const result = originalEmit.call(this, event, ...args)
      if (event === "frame") {
        const frame = h.controller.transcriptRuntime("main")!.getSnapshot()
        frames.at(-1)!.afterHandlers = {
          nativeTop: scroll.scrollTop,
          nativeHeight: scroll.scrollHeight,
          presentationRevision: frame.presentationRevision,
          semantic: h.workspace().transcript.viewport,
          topSpacer: frame.window.topSpacerRows,
          bottomSpacer: frame.window.bottomSpacerRows,
        }
      }
      return result
    }
    const settle = async (count = 8) => {
      for (let i = 0; i < count; i++)
        await act(async () => {
          await h.flush()
          await h.renderOnce()
        })
    }
    const run = async (name: string, fn: () => void | Promise<void>) => {
      action = name
      inputAt = performance.now()
      await act(async () => {
        await fn()
        await h.flush()
        await h.renderOnce()
      })
      await settle()
    }
    try {
      await settle()
      await run("burst-up-8", () => {
        for (let i = 0; i < 8; i++) h.mockInput.pressKey("u", { ctrl: true })
      })
      await run("reverse-down-3", () => {
        for (let i = 0; i < 3; i++) h.mockInput.pressKey("d", { ctrl: true })
      })
      await run("burst-row-up-56", () => {
        for (let i = 0; i < 56; i++) h.mockInput.pressKey("y", { ctrl: true })
      })
      await run("reverse-row-down-12", () => {
        for (let i = 0; i < 12; i++) h.mockInput.pressKey("e", { ctrl: true })
      })
      for (let i = 0; i < 8; i++)
        await run(`steady-up-${i}`, () => {
          h.mockInput.pressKey("u", { ctrl: true })
        })
      await run("detached-stream", () =>
        h.emit({
          type: "conversation",
          event: {
            type: "item.delta",
            threadId: thread,
            itemId: answer,
            delta: "\n\nStreaming addition while reading history.".repeat(20),
          },
        }),
      )
      await run("normal-mode", () => {
        h.mockInput.pressKey("ESCAPE")
      })
      await run("focus-transcript", () => {
        h.controller.dispatchInteraction({
          type: "focus.set",
          surface: "transcript",
        })
        const viewport = h.workspace().transcript.viewport
        assert(viewport.kind === "point")
        h.controller.transcript({
          type: "cursor.move",
          target: viewport.point,
          preferredScreenRow: viewport.preferredScreenRow,
          extend: false,
        })
      })
      for (let i = 0; i < 4; i++)
        await run(`block-previous-${i}`, () => h.mockInput.typeText("{"))
      for (let i = 0; i < 4; i++)
        await run(`block-next-${i}`, () => h.mockInput.typeText("}"))
      const actions = [...new Set(frames.map((f) => f.action))].map((name) => {
        const group = frames.filter((f) => f.action === name)
        return {
          name,
          frames: group.length,
          blankFrames: group.filter((f) => f.blank).length,
          distinctTops: [...new Set(group.map((f) => f.nativeTop))],
          distinctPaints: new Set(group.map((f) => JSON.stringify(f.visible)))
            .size,
          first: group[0]?.frame,
          last: group.at(-1)?.frame,
        }
      })
      runs.push({
        fixture: expanded ? "expanded-tools" : "folded-tools",
        dense,
        frames,
        actions,
      })
      console.log(
        JSON.stringify({
          fixture: expanded ? "expanded-tools" : "folded-tools",
          dense,
          actions,
        }),
      )
    } finally {
      h.renderer.emit = originalEmit
      await h.close()
    }
  }
const output = process.argv[2] ?? "/tmp/vimex-scroll-repro.json"
await Bun.write(
  output,
  JSON.stringify(
    { schemaVersion: 1, viewport: { width: 80, height: 24 }, runs },
    null,
    2,
  ),
)
console.log(`Painted-frame evidence: ${output}`)
