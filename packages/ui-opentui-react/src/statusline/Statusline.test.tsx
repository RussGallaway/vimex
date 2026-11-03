import { test, expect } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { threadId } from "@vimex/conversation"
import { Statusline } from "./Statusline"

test("statusline shows authoritative goal state and explicit budget usage", async () => {
  const setup = await testRender(
    <Statusline
      mode="normal"
      pendingKeys=""
      unseenEntries={0}
      pendingApprovals={0}
      pendingQuestions={0}
      activeTurn={false}
      summary={{
        id: threadId("a"),
        title: "a",
        model: "test",
        reasoningEffort: "medium",
        cwd: "/tmp",
        status: "idle",
        goal: {
          objective: "Fix tests",
          status: "paused",
          tokenBudget: 1000,
          tokensUsed: 250,
          timeUsedSeconds: 3,
        },
      }}
    />,
    { width: 120, height: 4 },
  )
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain("goal paused 25%")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("statusline distinguishes active automatic sleep prevention from disabled and failed", async () => {
  for (const [power, label] of [
    [{ supported: true, enabled: true, active: true }, "awake:on"],
    [{ supported: true, enabled: true, active: false }, "awake:auto"],
    [{ supported: true, enabled: false, active: false }, "awake:off"],
    [
      { supported: true, enabled: true, active: false, error: "failed" },
      "awake:error",
    ],
  ] as const) {
    const setup = await testRender(
      <Statusline
        mode="normal"
        power={power}
        pendingKeys=""
        unseenEntries={0}
        pendingApprovals={0}
        pendingQuestions={0}
        activeTurn={false}
      />,
      { width: 80, height: 4 },
    )
    try {
      await act(async () => {
        await setup.flush()
        await setup.renderOnce()
      })
      expect(setup.captureCharFrame()).toContain(label)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  }
})
