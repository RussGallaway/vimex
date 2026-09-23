import { expect, spyOn, test } from "bun:test"
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

test("running roster entry pulses while completed entries stay still", async () => {
  const intervals = spyOn(globalThis, "setInterval")
  const cleared = spyOn(globalThis, "clearInterval")
  let pulseTimer: unknown
  const setup = await testRender(
    <AgentsOverlay
      rows={[
        {
          threadId: threadId("working"),
          parentId: threadId("parent"),
          name: "working_agent",
          status: "running",
          updatedAt: 1,
        },
        {
          threadId: threadId("done"),
          parentId: threadId("parent"),
          name: "done_agent",
          status: "complete",
          updatedAt: 1,
        },
      ]}
      selected={0}
      hideFinished={false}
      scoped={false}
    />,
    { width: 60, height: 15 },
  )
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain("◌ working_agent")
    expect(setup.captureCharFrame()).toContain("✓ done_agent")
    const pulseCalls = intervals.mock.calls.filter((args) => args[1] === 450)
    expect(pulseCalls).toHaveLength(1)
    pulseTimer = intervals.mock.results.find(
      (_, index) => intervals.mock.calls[index]?.[1] === 450,
    )?.value
    const advancePulse = pulseCalls[0]![0] as () => void
    await act(async () => {
      advancePulse()
      await setup.flush()
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain("◍ working_agent")
    expect(setup.captureCharFrame()).toContain("✓ done_agent")
  } finally {
    await act(async () => setup.renderer.destroy())
    expect(cleared.mock.calls.some((args) => args[0] === pulseTimer)).toBe(true)
    intervals.mockRestore()
    cleared.mockRestore()
  }
})
