import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { itemId, threadId, turnId } from "@vimex/conversation"
import { initialWorkbench, transitionWorkbench } from "@vimex/workbench"
import {
  beginSelection,
  findSearchMatches,
  graphemes,
  moveCursor,
  selectedText,
} from "@vimex/transcript"
import { createEmberTideSyntax } from "../theme"
import { inertController } from "../contracts"
import { VimexRoot } from "../index"
import { AgentActivity } from "./AgentActivity"
import { ActivityBatch } from "./ActivityBatch"
import { ReasoningBlock } from "./ReasoningBlock"
import { ToolCall } from "./ToolCall"
import { TurnActivity } from "./TurnActivity"
import { measureRenderedTranscript } from "./rendered-layout"

test("renders structured agent activity as a compact foldable row", async () => {
  const item = {
    id: itemId("agent"),
    turnId: turnId("turn"),
    kind: "agent" as const,
    action: "follow-up" as const,
    detail: "Check the edge cases",
    senderThreadId: threadId("parent"),
    agentThreadIds: [threadId("child")],
    agentStates: [{ threadId: threadId("child"), status: "running" as const }],
    status: "complete" as const,
  }
  const folded = await testRender(<AgentActivity item={item} folded />, {
    width: 70,
    height: 8,
  })
  try {
    await act(async () => folded.flush())
    const frame = folded.captureCharFrame()
    expect(frame).toContain("Follow up with agent")
    expect(frame).not.toContain("child")
    expect(frame).toContain("Check the edge cases")
  } finally {
    await act(async () => folded.renderer.destroy())
  }

  const open = await testRender(<AgentActivity item={item} folded={false} />, {
    width: 70,
    height: 10,
  })
  try {
    await act(async () => open.flush())
    expect(open.captureCharFrame()).toContain("Check the edge cases")
    expect(open.captureCharFrame()).toContain("child · running")
  } finally {
    await act(async () => open.renderer.destroy())
  }
})

test("renders observed terminal turn duration as noncanonical decoration", async () => {
  const complete = await testRender(
    <TurnActivity
      turn={{
        id: turnId("done"),
        status: "complete",
        itemIds: [],
        durationMs: 164_000,
      }}
    />,
    { width: 50, height: 3 },
  )
  try {
    await act(async () => complete.flush())
    expect(complete.captureCharFrame()).toContain("Worked for 2m 44s")
  } finally {
    await act(async () => complete.renderer.destroy())
  }

  const interrupted = await testRender(
    <TurnActivity
      turn={{
        id: turnId("stopped"),
        status: "interrupted",
        itemIds: [],
        durationMs: 3_000,
      }}
    />,
    { width: 50, height: 3 },
  )
  try {
    await act(async () => interrupted.flush())
    expect(interrupted.captureCharFrame()).toContain("Stopped after 3s")
  } finally {
    await act(async () => interrupted.renderer.destroy())
  }
})

test("narrow activity summaries preserve provider identity and truncate trailing metadata atomically", async () => {
  const batch = {
    key: "provider:linear-service:first",
    turnId: turnId("turn"),
    family: "provider" as const,
    label: "Linear Service",
    countLabel: "12 actions",
    leadItemId: itemId("first"),
    itemIds: [itemId("first"), itemId("second")],
    blockKeys: ["item:first:root", "item:second:root"],
    blockItemIds: [itemId("first"), itemId("second")],
    leadGraphemeFrom: 0,
    leadGraphemeTo: 1,
    leadIncludesEnd: true,
    durationMs: 12_345,
  }
  const setup = await testRender(<ActivityBatch batch={batch} />, {
    width: 24,
    height: 3,
  })
  try {
    await act(async () => setup.flush())
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Linear")
    expect(frame).not.toContain("12.")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("folds adjacent settled web activity into one navigable runtime batch", async () => {
  const thread = threadId("web-batch"),
    turn = turnId("turn")
  const ids = [itemId("web-a"), itemId("web-b"), itemId("web-c")]
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Research",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: { type: "turn.started", threadId: thread, turnId: turn },
  }).state
  for (const id of ids) {
    state = transitionWorkbench(state, {
      type: "conversation.event",
      event: {
        type: "item.started",
        threadId: thread,
        item: {
          id,
          turnId: turn,
          kind: "tool",
          title: "Web search",
          detail: `result ${id}`,
          activity: { family: "web-research" },
          status: "complete",
        },
      },
    }).state
    state = transitionWorkbench(state, {
      type: "transcript.command",
      command: { type: "fold.set", itemId: id, folded: true },
    }).state
  }
  const setup = await testRender(
    <VimexRoot state={state} controller={inertController} />,
    { width: 80, height: 18 },
  )
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
      await setup.flush()
      await setup.renderOnce()
    })
    const frame = setup.captureCharFrame()
    expect(frame.match(/Web research/g)).toHaveLength(1)
    expect(frame).toContain("3 searches")
    expect(frame).not.toContain("result web-")
    expect(
      setup.renderer.root.findDescendantById(`transcript-block:${ids[1]}:root`)
        ?.visible,
    ).toBe(false)
    const transcript = state.workspaces[thread]!.transcript
    expect(transcript.order).toEqual(ids)
    expect(findSearchMatches(transcript, "result")).toHaveLength(3)
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("running transcript rows remain static and create no animation timers", async () => {
  const intervals = spyOn(globalThis, "setInterval")
  const syntax = createEmberTideSyntax()
  try {
    const reasoning = await testRender(
      <ReasoningBlock
        item={{
          id: itemId("reasoning"),
          turnId: turnId("turn"),
          kind: "reasoning",
          markdown: "Thinking",
          status: "running",
        }}
        folded
        syntax={syntax}
      />,
      { width: 60, height: 5 },
    )
    try {
      await act(async () => reasoning.flush())
      expect(reasoning.captureCharFrame()).toContain("⋯ Thinking")
    } finally {
      await act(async () => reasoning.renderer.destroy())
    }
    const tool = await testRender(
      <ToolCall
        item={{
          id: itemId("tool"),
          turnId: turnId("turn"),
          kind: "tool",
          title: "Search",
          detail: "",
          status: "running",
        }}
        folded
      />,
      { width: 60, height: 5 },
    )
    try {
      await act(async () => tool.flush())
      expect(tool.captureCharFrame()).toContain("⋯ Calling")
    } finally {
      await act(async () => tool.renderer.destroy())
    }
    expect(intervals).not.toHaveBeenCalled()
  } finally {
    syntax.destroy()
    intervals.mockRestore()
  }
})

test("one visible pane owns one heartbeat while running rows own none", async () => {
  const intervals = spyOn(globalThis, "setInterval")
  const thread = threadId("heartbeat"),
    turn = turnId("turn")
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Heartbeat",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "working",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "connection.changed",
    connection: "connected",
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "turn.started",
      threadId: thread,
      turnId: turn,
      startedAt: Date.now() - 2_000,
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "item.started",
      threadId: thread,
      item: {
        id: itemId("thought"),
        turnId: turn,
        kind: "reasoning",
        markdown: "UNIQUE PRIVATE THOUGHT",
        status: "running",
      },
    },
  }).state
  const setup = await testRender(
    <VimexRoot state={state} controller={inertController} />,
    { width: 80, height: 20 },
  )
  try {
    await act(async () => setup.flush())
    expect(setup.captureCharFrame()).toContain("Working")
    expect(setup.captureCharFrame()).not.toContain("UNIQUE PRIVATE THOUGHT")
    const composer = setup.renderer.root.findDescendantById("composer-shell")!
    const activityStrip =
      setup.renderer.root.findDescendantById("activity-strip")!
    const status = setup.renderer.root.findDescendantById("status-bar")!
    expect(activityStrip.y).toBe(composer.y + composer.height)
    expect(status.y).toBe(activityStrip.y + activityStrip.height)
    expect(setup.captureCharFrame().split("\n")[activityStrip.y]).toContain(
      "Working",
    )
    expect(intervals.mock.calls.filter((args) => args[1] === 120)).toHaveLength(
      1,
    )
  } finally {
    await act(async () => setup.renderer.destroy())
    intervals.mockRestore()
  }
})

test("a reasoning-only completed turn renders one worked footer and no reasoning row", async () => {
  const thread = threadId("reasoning-footer"),
    turn = turnId("turn")
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Reasoning",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "item.started",
      threadId: thread,
      item: {
        id: itemId("thought"),
        turnId: turn,
        kind: "reasoning",
        markdown: "UNIQUE PRIVATE THOUGHT",
        status: "complete",
      },
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "complete",
      durationMs: 164_000,
    },
  }).state
  const setup = await testRender(
    <VimexRoot state={state} controller={inertController} />,
    { width: 70, height: 12 },
  )
  try {
    await act(async () => setup.flush())
    const frame = setup.captureCharFrame()
    expect(frame.match(/Worked for 2m 44s/g)).toHaveLength(1)
    expect(frame).not.toContain("UNIQUE PRIVATE THOUGHT")
    expect(state.workspaces[thread]!.transcript.order).toEqual([])
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("agent decoration is excluded from canonical projection and native geometry", async () => {
  const thread = threadId("agent-geometry"),
    turn = turnId("turn")
  const agent = {
    id: itemId("agent-geometry"),
    turnId: turn,
    kind: "agent" as const,
    action: "spawn" as const,
    detail: "Review tests",
    agentThreadIds: [threadId("opaque-child-id")],
    agentStates: [
      {
        threadId: threadId("opaque-child-id"),
        status: "running" as const,
        message: "Inspecting",
      },
    ],
    status: "complete" as const,
  }
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Agent",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: { type: "item.started", threadId: thread, item: agent },
  }).state
  const setup = await testRender(
    <VimexRoot state={state} controller={inertController} />,
    { width: 80, height: 20 },
  )
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    const transcript = state.workspaces[thread]!.transcript
    const projection = transcript.projectionById[agent.id]!
    expect(projection.source).toBe("Review tests")
    expect(projection.source).not.toContain("opaque-child-id")
    const layout = measureRenderedTranscript(
      setup.renderer,
      setup.renderer.root.findDescendantById(
        "transcript",
      ) as ScrollBoxRenderable,
      transcript,
    )!
    expect(Object.keys(layout.points![agent.id]!)).toHaveLength(
      graphemes(projection.plain).length + 1,
    )
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("terminal turns without items still render their outcome", async () => {
  const thread = threadId("empty-turn"),
    turn = turnId("turn")
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Empty",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "failed",
      durationMs: 1_500,
    },
  }).state
  const setup = await testRender(
    <VimexRoot state={state} controller={inertController} />,
    { width: 70, height: 24 },
  )
  try {
    await act(async () => setup.flush())
    expect(setup.captureCharFrame()).toContain("Failed after 1s")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("empty terminal turns retain chronology before later transcript content", async () => {
  const thread = threadId("empty-before-content"),
    empty = turnId("empty"),
    later = turnId("later")
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Chronology",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "turn.completed",
      threadId: thread,
      turnId: empty,
      outcome: "failed",
      durationMs: 500,
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "item.started",
      threadId: thread,
      item: {
        id: itemId("later-answer"),
        turnId: later,
        kind: "assistant",
        markdown: "Later answer",
        status: "complete",
      },
    },
  }).state
  const setup = await testRender(
    <VimexRoot state={state} controller={inertController} />,
    { width: 70, height: 24 },
  )
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    const footer = setup.renderer.root.findDescendantById(
      `decoration:turn:${empty}`,
    )!
    const row = setup.renderer.root.findDescendantById(
      "transcript-block:later-answer:root",
    )!
    expect(footer).toBeDefined()
    expect(row).toBeDefined()
    expect(footer.y).toBeLessThan(row.y)
    let transcript = state.workspaces[thread]!.transcript
    expect(transcript.order).toEqual([itemId("later-answer")])
    expect(findSearchMatches(transcript, "Failed")).toEqual([])
    transcript = beginSelection(
      moveCursor(transcript, {
        itemId: itemId("later-answer"),
        graphemeOffset: 0,
      }),
      "character",
    )
    transcript = moveCursor(transcript, {
      itemId: itemId("later-answer"),
      graphemeOffset: 999,
    })
    expect(selectedText(transcript, "plain")).toBe("Later answer")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("turns containing only suppressed telemetry still render their terminal outcome", async () => {
  const thread = threadId("telemetry-footer"),
    turn = turnId("turn")
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Telemetry",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "item.started",
      threadId: thread,
      item: {
        id: itemId("wait"),
        turnId: turn,
        kind: "agent",
        action: "wait",
        detail: "",
        agentThreadIds: [threadId("child")],
        status: "complete",
      },
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "interrupted",
      durationMs: 2_000,
    },
  }).state
  expect(state.workspaces[thread]!.transcript.order).toEqual([])
  const setup = await testRender(
    <VimexRoot state={state} controller={inertController} />,
    { width: 70, height: 16 },
  )
  try {
    await act(async () => setup.flush())
    expect(setup.captureCharFrame()).toContain("Stopped after 2s")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("empty canonical agent rows retain one native anchor point", async () => {
  const thread = threadId("empty-agent"),
    turn = turnId("turn"),
    id = itemId("interrupt")
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Agent",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "item.started",
      threadId: thread,
      item: {
        id,
        turnId: turn,
        kind: "agent",
        action: "interrupt",
        detail: "",
        agentThreadIds: [threadId("child")],
        status: "complete",
      },
    },
  }).state
  const setup = await testRender(
    <VimexRoot state={state} controller={inertController} />,
    { width: 70, height: 16 },
  )
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    const transcript = state.workspaces[thread]!.transcript
    const layout = measureRenderedTranscript(
      setup.renderer,
      setup.renderer.root.findDescendantById(
        "transcript",
      ) as ScrollBoxRenderable,
      transcript,
    )!
    expect(Object.keys(layout.points![id]!)).toEqual(["0"])
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("successful turns without observed timing add no synthetic footer", async () => {
  const setup = await testRender(
    <TurnActivity
      turn={{ id: turnId("done"), status: "complete", itemIds: [] }}
    />,
    { width: 50, height: 3 },
  )
  try {
    await act(async () => setup.flush())
    expect(setup.captureCharFrame().trim()).toBe("")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

for (const width of [44, 100]) {
  test(`folded child task stays compact at ${width} columns`, async () => {
    const item = {
      id: itemId("task"),
      turnId: turnId("turn"),
      kind: "agent" as const,
      action: "spawn" as const,
      detail: "Investigate token refresh and the background renewal race",
      agentThreadIds: [threadId("child")],
      status: "complete" as const,
      childTasks: [{ threadId: threadId("child"), status: "running" as const }],
    }
    const setup = await testRender(
      <AgentActivity
        item={item}
        folded
        agentSummaries={{
          child: {
            id: threadId("child"),
            title: "Child",
            agentNickname: "refresh_ux",
            cwd: "/work",
            model: "test",
            reasoningEffort: "high",
            status: "working",
          },
        }}
      />,
      {
        width,
        height: 5,
      },
    )
    try {
      await act(async () => {
        await setup.flush()
        await setup.renderOnce()
      })
      const frame = setup.captureCharFrame()
      expect(frame).toContain("◌ refresh_ux")
      expect(frame).not.toContain("Investigate token refresh")
      expect(frame).not.toContain("Working")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
}

test("expanded child task shows the assignment, reported result, and open shortcut", async () => {
  const setup = await testRender(
    <AgentActivity
      item={{
        id: itemId("task-result"),
        turnId: turnId("turn"),
        kind: "agent",
        action: "spawn",
        detail: "Investigate token refresh",
        agentThreadIds: [threadId("child")],
        status: "complete",
        childTasks: [
          {
            threadId: threadId("child"),
            status: "complete",
            message: "Fixed the refresh race",
          },
        ],
      }}
      folded={false}
    />,
    { width: 70, height: 12 },
  )
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    const frame = setup.captureCharFrame()
    for (const text of [
      "Agent 1",
      "Completed",
      "Assignment",
      "Investigate token refresh",
      "Fixed the refresh race",
      "gc Open transcript",
    ])
      expect(frame).toContain(text)
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("expanded child row keeps status visible beside a long agent name", async () => {
  const setup = await testRender(
    <AgentActivity
      item={{
        id: itemId("long-agent-name"),
        turnId: turnId("turn"),
        kind: "agent",
        action: "spawn",
        detail: "Review the renderer",
        agentThreadIds: [threadId("child")],
        status: "complete",
        childTasks: [{ threadId: threadId("child"), status: "complete" }],
      }}
      folded={false}
      agentSummaries={{
        child: {
          id: threadId("child"),
          title: "Child",
          agentNickname: "extremely_long_subagent_name_for_a_narrow_terminal",
          cwd: "/work",
          model: "test",
          reasoningEffort: "high",
          status: "idle",
        },
      }}
    />,
    { width: 44, height: 12 },
  )
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Completed")
    expect(frame).toContain("Assignment: Review the renderer")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("multi-agent spawn keeps a failed child visible while another works", async () => {
  const setup = await testRender(
    <AgentActivity
      item={{
        id: itemId("two-agents"),
        turnId: turnId("turn"),
        kind: "agent",
        action: "spawn",
        detail: "Compare reference clients",
        agentThreadIds: [threadId("one"), threadId("two")],
        status: "complete",
        childTasks: [
          { threadId: threadId("one"), status: "running" },
          { threadId: threadId("two"), status: "error", message: "Timed out" },
        ],
      }}
      folded={false}
      agentSummaries={{
        one: {
          id: threadId("one"),
          title: "One",
          agentNickname: "opencode_ux",
          cwd: "/work",
          model: "test",
          reasoningEffort: "high",
          status: "working",
        },
        two: {
          id: threadId("two"),
          title: "Two",
          agentNickname: "grok_ux",
          cwd: "/work",
          model: "test",
          reasoningEffort: "high",
          status: "idle",
        },
      }}
    />,
    { width: 70, height: 12 },
  )
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    const frame = setup.captureCharFrame()
    expect(frame).toContain("✕ 2 agents")
    expect(frame).toContain("Failed")
    expect(frame).toContain("opencode_ux · running")
    expect(frame).toContain("grok_ux · error")
    expect(frame).toContain("gc Choose child transcript")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})
