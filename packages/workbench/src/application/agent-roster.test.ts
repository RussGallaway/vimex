import { expect, test } from "bun:test"
import {
  itemId,
  threadId,
  turnId,
  type ThreadSummary,
} from "@vimex/conversation"
import { agentRoster, agentRosterRoot } from "./agent-roster"
import { transitionWorkbench } from "./reduce-workbench"
import { initialWorkbench } from "./workbench-state"

test("the conversation roster includes nested spawned agents, but excludes side chats and target links", () => {
  const root = threadId("root")
  const working = threadId("working")
  const done = threadId("done")
  const nested = threadId("nested")
  const side = threadId("side")
  const target = threadId("target")
  const summaries = (
    [
      { id: root, title: "Parent", status: "working" },
      {
        id: working,
        title: "Working",
        agentNickname: "opencode_ux",
        status: "idle",
      },
      { id: done, title: "Done", agentNickname: "grok_ux", status: "idle" },
      {
        id: nested,
        title: "Nested",
        agentNickname: "codex_docs",
        status: "idle",
      },
      { id: side, title: "Side", status: "idle" },
      { id: target, title: "Target", status: "idle" },
    ] satisfies Partial<ThreadSummary>[]
  ).map((summary) => ({
    ...summary,
    cwd: "/work",
    model: "test",
    reasoningEffort: "high",
  }))
  let state = initialWorkbench()
  for (const summary of summaries)
    state = transitionWorkbench(state, { type: "thread.open", summary }).state
  const turn = turnId("delegation")
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: { type: "turn.started", threadId: root, turnId: turn },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "item.completed",
      threadId: root,
      item: {
        id: itemId("spawn"),
        turnId: turn,
        kind: "agent",
        action: "spawn",
        detail: "Compare the two products",
        agentThreadIds: [working, done],
        childTasks: [
          { threadId: working, status: "running" },
          { threadId: done, status: "complete", message: "Report ready" },
        ],
        status: "complete",
      },
    },
  }).state
  state = {
    ...state,
    activeThreadId: working,
    agentRelationships: [
      {
        parentId: root,
        childId: working,
        itemId: itemId("spawn"),
        relation: "spawned",
      },
      {
        parentId: root,
        childId: done,
        itemId: itemId("spawn"),
        relation: "spawned",
      },
      {
        parentId: working,
        childId: nested,
        itemId: itemId("nested-spawn"),
        relation: "spawned",
      },
      {
        parentId: root,
        childId: side,
        itemId: itemId("side-fork"),
        relation: "spawned",
      },
      {
        parentId: root,
        childId: target,
        itemId: itemId("message"),
        relation: "target",
      },
    ],
    sideChats: {
      [root]: {
        parentId: root,
        threadId: side,
        visible: true,
        maximized: false,
      },
    },
  }
  expect(agentRosterRoot(state)).toBe(root)
  expect(agentRoster(state).map(({ name, status }) => [name, status])).toEqual([
    ["opencode_ux", "running"],
    ["codex_docs", "running"],
    ["grok_ux", "complete"],
  ])
  expect(agentRoster(state)[2]).toMatchObject({
    assignment: "Compare the two products",
    result: "Report ready",
  })
  expect(agentRosterRoot(state, side)).toBe(root)
  expect(agentRoster(state, side).map((row) => row.threadId)).toEqual(
    agentRoster(state).map((row) => row.threadId),
  )
})

test("a thread-start relationship appears before the spawn item is hydrated", () => {
  const parent = threadId("parent")
  const child = threadId("child")
  const state = {
    ...initialWorkbench(),
    activeThreadId: parent,
    summaries: {
      [child]: {
        id: child,
        title: "Child preview",
        agentNickname: "researcher",
        model: "test",
        reasoningEffort: "high",
        cwd: "/work",
        status: "idle" as const,
      },
    },
    agentRelationships: [
      {
        parentId: parent,
        childId: child,
        itemId: itemId("thread:child"),
        relation: "spawned" as const,
      },
    ],
  }
  expect(agentRoster(state)).toMatchObject([
    { threadId: child, name: "researcher", status: "running" },
  ])
})

test("a completed child keeps its result after shutdown", () => {
  const parent = threadId("parent")
  const child = threadId("child")
  const turn = turnId("turn")
  let state = initialWorkbench()
  for (const id of [parent, child])
    state = transitionWorkbench(state, {
      type: "thread.open",
      summary: {
        id,
        title: id,
        cwd: "/work",
        model: "test",
        reasoningEffort: "high",
        status: "idle",
      },
    }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: { type: "turn.started", threadId: parent, turnId: turn },
  }).state
  for (const [id, action, status, message] of [
    ["spawn", "spawn", "pending", undefined],
    ["wait", "wait", "complete", "Found the fix"],
    ["close", "close", "closed", undefined],
  ] as const)
    state = transitionWorkbench(state, {
      type: "conversation.event",
      event: {
        type: "item.completed",
        threadId: parent,
        item: {
          id: itemId(id),
          turnId: turn,
          kind: "agent",
          action,
          detail: action === "spawn" ? "Investigate the bug" : "",
          agentThreadIds: [child],
          agentStates: [
            { threadId: child, status, ...(message ? { message } : {}) },
          ],
          status: "complete",
        },
      },
    }).state
  expect(agentRoster(state)).toMatchObject([
    {
      threadId: child,
      assignment: "Investigate the bug",
      status: "complete",
      result: "Found the fix",
    },
  ])
})
