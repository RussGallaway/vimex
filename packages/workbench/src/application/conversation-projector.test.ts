import { expect, test } from "bun:test"
import {
  createConversationStructureDiagnostics,
  itemId,
  persistentConversationTurnIds,
  threadId,
  turnId,
} from "@vimex/conversation"
import {
  initialWorkbench,
  createWorkspace,
  type WorkbenchState,
} from "./workbench-state"
import { applyConversationEvent } from "./conversation-projector"
import { agentRoster } from "./agent-roster"

test("side-child projection misses inherited history through a logarithmic persistent membership index", () => {
  for (const inheritedCount of [100, 1_000, 10_000, 100_000]) {
    const parentId = threadId(`membership-parent-${inheritedCount}`)
    const childId = threadId(`membership-child-${inheritedCount}`)
    const localTurnId = turnId(`membership-local-turn-${inheritedCount}`)
    const localItemId = itemId(`membership-local-item-${inheritedCount}`)
    let state = {
      ...initialWorkbench(),
      workspaces: { [childId]: createWorkspace(childId) },
    }
    state = applyConversationEvent(state, {
      type: "item.started",
      threadId: childId,
      item: {
        id: localItemId,
        turnId: localTurnId,
        kind: "assistant",
        markdown: "seed",
        status: "running",
      },
    }).state
    const inheritedTurnIds = persistentConversationTurnIds(
      Array.from({ length: inheritedCount }, (_, index) =>
        turnId(`membership-inherited-turn-${inheritedCount}-${index}`),
      ),
    )
    state = {
      ...state,
      sideChats: {
        [parentId]: {
          parentId,
          threadId: childId,
          visible: true,
          maximized: false,
          inheritedTurnIds,
        },
      },
    }
    const diagnostics = createConversationStructureDiagnostics()
    const next = applyConversationEvent(
      state,
      {
        type: "item.delta",
        threadId: childId,
        itemId: localItemId,
        delta: " delta",
      },
      diagnostics,
    ).state

    expect(
      next.workspaces[childId]!.conversation.items[localItemId],
    ).toMatchObject({ markdown: "seed delta" })
    expect(
      next.workspaces[childId]!.transcript.projectionById[localItemId]?.source,
    ).toBe("seed delta")
    expect(diagnostics.conversationTurnIdSequenceNormalizations).toBe(0)
    expect(diagnostics.conversationTurnIdSequenceNormalizationVisits).toBe(0)
    expect(diagnostics.conversationTurnIdSequenceLookups).toBe(1)
    expect(
      diagnostics.conversationTurnIdSequenceLookupNodeVisits,
    ).toBeLessThanOrEqual(2 * (Math.ceil(Math.log2(inheritedCount + 1)) + 1))
  }
})

test("child task progress updates the assignment without changing tool outcomes or adding telemetry rows", () => {
  const parent = threadId("parent"),
    child = threadId("child"),
    turn = turnId("turn"),
    spawnId = itemId("spawn")
  let state = {
    ...initialWorkbench(),
    workspaces: { [parent]: createWorkspace(parent) },
  }
  const spawn = {
    id: spawnId,
    turnId: turn,
    kind: "agent" as const,
    action: "spawn" as const,
    detail: "Investigate token refresh",
    agentThreadIds: [child],
    status: "running" as const,
    agentStates: [{ threadId: child, status: "pending" as const }],
  }
  state = applyConversationEvent(state, {
    type: "item.started",
    threadId: parent,
    item: spawn,
  }).state
  state = applyConversationEvent(state, {
    type: "item.completed",
    threadId: parent,
    item: {
      ...spawn,
      status: "complete",
      agentStates: [{ threadId: child, status: "running" }],
    },
  }).state
  const task = () => state.workspaces[parent]!.conversation.items[spawnId]!
  expect(task()).toMatchObject({
    status: "complete",
    childTasks: [{ threadId: child, status: "running" }],
  })
  state = applyConversationEvent(state, {
    type: "turn.completed",
    threadId: parent,
    turnId: turn,
    outcome: "complete",
  }).state
  expect(task()).toMatchObject({ childTasks: [{ status: "running" }] })
  state = applyConversationEvent(state, {
    type: "item.completed",
    threadId: parent,
    item: {
      id: itemId("wait"),
      turnId: turn,
      kind: "agent",
      action: "wait",
      detail: "",
      status: "complete",
      agentThreadIds: [child],
      agentStates: [
        {
          threadId: child,
          status: "complete",
          message: "Fixed the refresh race",
        },
      ],
    },
  }).state
  expect(task()).toMatchObject({
    status: "complete",
    childTasks: [{ status: "complete", message: "Fixed the refresh race" }],
  })
  state = applyConversationEvent(state, {
    type: "item.completed",
    threadId: parent,
    item: {
      id: itemId("done"),
      turnId: turn,
      kind: "agent",
      action: "activity",
      activity: "completed",
      agentPath: "/root/child",
      detail: "",
      status: "complete",
      agentThreadIds: [child],
    },
  }).state
  expect(task()).toMatchObject({
    childTasks: [{ status: "complete", message: "Fixed the refresh race" }],
  })
  expect(state.workspaces[parent]!.transcript.order).toEqual([spawnId])
  expect(
    state.workspaces[parent]!.transcript.projectionById[spawnId]!.source,
  ).toBe(spawn.detail)
})

test("a Codex lifecycle start stays visible as one child row through interactions, waits, and completion", () => {
  const parent = threadId("parent-lifecycle"),
    child = threadId("child-lifecycle"),
    turn = turnId("turn-lifecycle"),
    startId = itemId("call-spawn")
  let state: WorkbenchState = {
    ...initialWorkbench(),
    activeThreadId: parent,
    workspaces: { [parent]: createWorkspace(parent) },
  }
  state = applyConversationEvent(state, {
    type: "item.completed",
    threadId: parent,
    item: {
      id: startId,
      turnId: turn,
      kind: "agent",
      action: "spawn",
      detail: "",
      agentThreadIds: [child],
      agentPath: "/root/subagent_check",
      agentStates: [{ threadId: child, status: "running" }],
      status: "complete",
    },
  }).state
  expect(state.workspaces[parent]!.transcript.order).toEqual([startId])
  expect(agentRoster(state)).toMatchObject([
    { name: "subagent_check", status: "running", threadId: child },
  ])
  for (const [id, activity] of [
    ["interacted", "interacted"],
    ["completed", "completed"],
  ] as const) {
    state = applyConversationEvent(state, {
      type: "item.completed",
      threadId: parent,
      item: {
        id: itemId(id),
        turnId: turn,
        kind: "agent",
        action: "activity",
        activity,
        detail: "",
        agentThreadIds: [child],
        agentPath: "/root/subagent_check",
        status: "complete",
      },
    }).state
  }
  state = applyConversationEvent(state, {
    type: "item.completed",
    threadId: parent,
    item: {
      id: itemId("wait"),
      turnId: turn,
      kind: "agent",
      action: "wait",
      detail: "",
      agentThreadIds: [],
      agentStates: [],
      status: "complete",
    },
  }).state
  expect(state.workspaces[parent]!.transcript.order).toEqual([startId])
  expect(state.workspaces[parent]!.conversation.items[startId]).toMatchObject({
    childTasks: [{ threadId: child, status: "complete" }],
  })
  expect(agentRoster(state)).toMatchObject([
    { name: "subagent_check", status: "complete", threadId: child },
  ])
})

test("late spawn completion retains newer lifecycle status and follow-ups remain separate", () => {
  const parent = threadId("parent-late"),
    child = threadId("child-late"),
    turn = turnId("turn"),
    spawnId = itemId("spawn-late")
  let state = {
    ...initialWorkbench(),
    workspaces: { [parent]: createWorkspace(parent) },
  }
  const spawn = {
    id: spawnId,
    turnId: turn,
    kind: "agent" as const,
    action: "spawn" as const,
    detail: "Check tests",
    agentThreadIds: [child],
    status: "running" as const,
    agentStates: [{ threadId: child, status: "pending" as const }],
  }
  state = applyConversationEvent(state, {
    type: "item.started",
    threadId: parent,
    item: spawn,
  }).state
  state = applyConversationEvent(state, {
    type: "item.completed",
    threadId: parent,
    item: {
      id: itemId("interrupted"),
      turnId: turn,
      kind: "agent",
      action: "activity",
      activity: "interrupted",
      agentPath: "/root/child",
      detail: "",
      agentThreadIds: [child],
      status: "complete",
    },
  }).state
  state = applyConversationEvent(state, {
    type: "item.completed",
    threadId: parent,
    item: { ...spawn, status: "complete" },
  }).state
  expect(state.workspaces[parent]!.conversation.items[spawnId]).toMatchObject({
    childTasks: [{ status: "interrupted" }],
  })
  state = applyConversationEvent(state, {
    type: "item.completed",
    threadId: parent,
    item: {
      id: itemId("follow-up"),
      turnId: turn,
      kind: "agent",
      action: "follow-up",
      detail: "Check edge cases too",
      agentThreadIds: [child],
      agentStates: [{ threadId: child, status: "running" }],
      status: "complete",
    },
  }).state
  expect(state.workspaces[parent]!.conversation.items[spawnId]).toMatchObject({
    childTasks: [{ status: "running" }],
  })
  expect(state.workspaces[parent]!.transcript.order).toEqual([
    spawnId,
    itemId("follow-up"),
  ])
})

test("a child result arriving before the spawn reply is attached when the child ID becomes known", () => {
  const parent = threadId("early-parent"),
    child = threadId("early-child"),
    turn = turnId("turn"),
    spawnId = itemId("early-spawn")
  let state = {
    ...initialWorkbench(),
    workspaces: { [parent]: createWorkspace(parent) },
  }
  const spawn = {
    id: spawnId,
    turnId: turn,
    kind: "agent" as const,
    action: "spawn" as const,
    detail: "Quick check",
    agentThreadIds: [],
    status: "running" as const,
  }
  state = applyConversationEvent(state, {
    type: "item.started",
    threadId: parent,
    item: spawn,
  }).state
  state = applyConversationEvent(state, {
    type: "item.completed",
    threadId: parent,
    item: {
      id: itemId("early-result"),
      turnId: turn,
      kind: "agent",
      action: "wait",
      detail: "",
      status: "complete",
      agentThreadIds: [child],
      agentStates: [
        { threadId: child, status: "complete", message: "All clear" },
      ],
    },
  }).state
  state = applyConversationEvent(state, {
    type: "item.completed",
    threadId: parent,
    item: {
      ...spawn,
      status: "complete",
      agentThreadIds: [child],
      agentStates: [{ threadId: child, status: "running" }],
    },
  }).state
  expect(state.workspaces[parent]!.conversation.items[spawnId]).toMatchObject({
    childTasks: [{ status: "complete", message: "All clear" }],
  })
})
