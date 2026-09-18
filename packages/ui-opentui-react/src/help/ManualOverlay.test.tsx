import { expect, test } from "bun:test"
import { act, useState } from "react"
import { testRender } from "@opentui/react/test-utils"
import type { ScrollBoxRenderable } from "@opentui/core"
import { threadId } from "@vimex/conversation"
import { initialWorkbench, transitionWorkbench } from "@vimex/workbench"
import { VimexRoot } from "../index"
import { inertController } from "../contracts"

for (const [width, height] of [[100, 30], [48, 18]] as const) {
  test(`offline manual scrolls and closes without editing the draft at ${width}x${height}`, async () => {
    const id = threadId("manual")
    let initial = transitionWorkbench(initialWorkbench(), { type: "thread.open", summary: { id, title: "Manual", cwd: "/tmp", model: "test", reasoningEffort: "medium", status: "idle" } }).state
    initial = transitionWorkbench(initial, { type: "composer.change", text: "Keep this draft", cursorOffset: 3 }).state
    initial = transitionWorkbench(initial, { type: "interaction.command", command: { type: "overlay.open", overlay: "manual" } }).state
    let observed = initial
    function Harness() {
      const [state, setState] = useState(initial)
      observed = state
      return <VimexRoot state={state} controller={{ ...inertController, dispatchInteraction(command) {
        setState(current => transitionWorkbench(current, { type: "interaction.command", command }).state)
      } }} />
    }
    const h = await testRender(<Harness />, { width, height })
    try {
      await act(async () => { await h.flush(); await h.renderOnce() })
      expect(h.captureCharFrame()).toContain("vimex(1)")
      const scroll = h.renderer.root.findDescendantById("manual-scroll") as ScrollBoxRenderable
      expect(scroll.y).toBeGreaterThan(0)
      expect(scroll.y + scroll.height).toBeLessThan(height)
      await act(async () => { await h.mockInput.typeText("G"); await h.flush(); await h.renderOnce() })
      expect(scroll.scrollTop).toBeGreaterThan(0)
      expect(h.captureCharFrame()).toContain("SEE ALSO")
      await act(async () => { await h.mockInput.typeText("gg"); await h.flush(); await h.renderOnce() })
      expect(scroll.scrollTop).toBe(0)
      await act(async () => { h.mockInput.pressKey("ESCAPE"); await Bun.sleep(30); await h.flush() })
      expect(observed.workspaces[id]?.interaction.overlay).toBeNull()
      expect(observed.workspaces[id]?.composer.text).toBe("Keep this draft")
      expect(observed.workspaces[id]?.composer.cursorOffset).toBe(3)
    } finally { await act(async () => h.renderer.destroy()) }
  })
}
