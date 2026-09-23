import { expect, test } from "bun:test"
import { itemId, threadId, turnId } from "@vimex/conversation"
import { initialWorkbench } from "./workbench-state"
import { transitionWorkbench } from "./reduce-workbench"
import { liveActivity } from "./live-activity"

test("keeps one stable working heartbeat while underlying item kinds advance", () => {
  const thread = threadId("activity"),
    turn = turnId("turn")
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Activity",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "working",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "turn.started",
      threadId: thread,
      turnId: turn,
      startedAt: 10_000,
    },
  }).state
  expect(liveActivity(state)).toEqual({
    working: true,
    label: "Working",
    startedAt: 10_000,
  })
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "item.started",
      threadId: thread,
      item: {
        id: itemId("reasoning"),
        turnId: turn,
        kind: "reasoning",
        markdown: "Thinking",
        status: "running",
      },
    },
  }).state
  expect(liveActivity(state)).toEqual({
    working: true,
    label: "Working",
    startedAt: 10_000,
  })
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "interrupted",
      completedAt: 12_000,
      durationMs: 2_000,
    },
  }).state
  expect(liveActivity(state)).toEqual({ working: false })
})

test("uses explicit stopping and compacting phases without losing observed start time", () => {
  const thread = threadId("phases"),
    turn = turnId("turn")
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Phases",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "working",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "turn.started",
      threadId: thread,
      turnId: turn,
      startedAt: 20_000,
    },
  }).state
  expect(
    liveActivity({ ...state, interruptingTurns: { [thread]: turn } }),
  ).toEqual({ working: true, label: "Stopping", startedAt: 20_000 })
  expect(
    liveActivity({
      ...state,
      compactingThreads: { [thread]: { phase: "running", turnId: turn } },
    }),
  ).toEqual({ working: true, label: "Compacting", startedAt: 20_000 })
})

test("failed terminal turns stop the working heartbeat", () => {
  const thread = threadId("failed"),
    turn = turnId("turn")
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Failed",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "working",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "turn.started",
      threadId: thread,
      turnId: turn,
      startedAt: 30_000,
    },
  }).state
  expect(liveActivity(state)).toEqual({
    working: true,
    label: "Working",
    startedAt: 30_000,
  })
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "failed",
      completedAt: 31_000,
    },
  }).state
  expect(liveActivity(state)).toEqual({ working: false })
})

test("shows Waiting for agents only while the current wait call is running", () => {
  const thread = threadId("waiting"),
    turn = turnId("turn"),
    wait = itemId("wait")
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Waiting",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "working",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "turn.started",
      threadId: thread,
      turnId: turn,
      startedAt: 40_000,
    },
  }).state
  const item = {
    id: wait,
    turnId: turn,
    kind: "agent" as const,
    action: "wait" as const,
    detail: "",
    agentThreadIds: [threadId("child")],
    status: "running" as const,
  }
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: { type: "item.started", threadId: thread, item },
  }).state
  expect(liveActivity(state)).toEqual({
    working: true,
    label: "Waiting for agents",
    startedAt: 40_000,
  })
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "item.completed",
      threadId: thread,
      item: { ...item, status: "complete" },
    },
  }).state
  expect(liveActivity(state).label).toBe("Working")
})
