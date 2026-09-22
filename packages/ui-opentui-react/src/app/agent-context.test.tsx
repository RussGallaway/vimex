import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FullscreenShell } from "./FullscreenShell"

for (const width of [44, 100]) {
  test(`subagent context and parent action remain visible at ${width} columns`, async () => {
    const setup = await testRender(
      <FullscreenShell
        title="Investigate transcript performance"
        parentTitle="Parent session with a deliberately long title to test truncation"
        connection="connected"
        working={false}
        transcript={<box flexGrow={1} />}
        composer={<text>draft</text>}
        statusline={<text>NORMAL</text>}
      />,
      { width, height: 24 },
    )
    try {
      await act(async () => {
        await setup.flush()
        await setup.renderOnce()
      })
      const frame = setup.captureCharFrame()
      expect(frame).toContain("SUBAGENT")
      expect(frame).toContain("Parent:")
      expect(frame).toContain("\\ parent")
      const context = setup.renderer.root.findDescendantById(
        "agent-parent-context",
      )!
      expect(context.height).toBe(1)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
}
