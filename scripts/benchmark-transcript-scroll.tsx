// Diagnostic native-renderer benchmark; intentionally has no timing pass/fail gate.
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { initialTranscript, syncTranscriptItem } from "@vimex/transcript"
import { itemId, turnId } from "@vimex/conversation"
import { ToolCall } from "../packages/ui-opentui-react/src/transcript/ToolCall"
import { measureRenderedTranscript, topVisiblePoint } from "../packages/ui-opentui-react/src/transcript/rendered-layout"

const item = {
  id: itemId("large"), turnId: turnId("benchmark"), kind: "command" as const,
  title: "Large output", status: "complete" as const,
  detail: Array.from({ length: 1500 }, (_, index) => `${index}: ${"result ".repeat(12)}`).join("\n"),
}
const state = syncTranscriptItem(initialTranscript(), item)
const setup = await testRender(
  <scrollbox id="scroll" width="100%" height="100%">
    <box id="transcript-item:large"><ToolCall item={item} folded={false} /></box>
  </scrollbox>,
  { width: 100, height: 30 },
)
try {
  await act(async () => { await setup.flush(); await setup.renderOnce() })
  const scroll = setup.renderer.root.findDescendantById("scroll") as ScrollBoxRenderable
  measureRenderedTranscript(setup.renderer, scroll, state)
  const measurements: number[] = [], anchors: number[] = [], frames: number[] = []
  for (let index = 0; index < 12; index++) {
    scroll.scrollBy(15, "step")
    let started = performance.now()
    await setup.renderOnce()
    frames.push(performance.now() - started)
    started = performance.now()
    const layout = measureRenderedTranscript(setup.renderer, scroll, state)!
    measurements.push(performance.now() - started)
    started = performance.now()
    topVisiblePoint(layout, scroll)
    anchors.push(performance.now() - started)
  }
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  console.log(JSON.stringify({
    chars: item.detail.length,
    measureMs: average(measurements), anchorMs: average(anchors), frameMs: average(frames),
  }))
} finally { await act(async () => setup.renderer.destroy()) }
