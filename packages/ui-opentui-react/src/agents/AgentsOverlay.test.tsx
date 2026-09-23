import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { threadId } from "@vimex/conversation"
import type { AgentRosterRow } from "@vimex/workbench"
import { act } from "react"
import { AgentsOverlay } from "./AgentsOverlay"

test("narrow agent roster keeps status readable beside a long name", async () => {
  const rows: AgentRosterRow[] = [
    {
      threadId: threadId("child"),
      parentId: threadId("parent"),
      name: "extremely_long_subagent_name_for_a_narrow_terminal",
      assignment: "Review the renderer",
      status: "complete",
      updatedAt: 1,
    },
  ]
  const setup = await testRender(
    <AgentsOverlay
      rows={rows}
      selected={0}
      hideFinished={false}
      scoped={false}
    />,
    { width: 44, height: 12 },
  )
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    const frame = setup.captureCharFrame()
    expect(frame).toContain("FINISHED")
    expect(frame).toContain(" Completed")
    expect(frame).toContain("✓ extre")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})
