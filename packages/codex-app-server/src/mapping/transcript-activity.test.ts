import { expect, test } from "bun:test"
import { threadId, turnId } from "@vimex/conversation"
import type { ThreadItem } from "../generated/v0_154_0/v2/ThreadItem"
import { hydrateTurns, mapThreadItem } from "./map-item"
import { mapNotification, mapNotificationEvents } from "./map-notification"

test("keeps image markers visible when loading a sent user message", () => {
  const item = mapThreadItem(
    {
      type: "userMessage",
      id: "photo",
      clientId: null,
      content: [
        { type: "text", text: "Inspect this", text_elements: [] },
        { type: "localImage", path: "/private/image.png" },
        { type: "image", url: "data:image/png;base64,abc" },
      ],
    },
    "turn",
    true,
  )
  expect(item).toMatchObject({
    kind: "user",
    markdown: "Inspect this [Image 1] [Image 2]",
  })
  expect(
    mapThreadItem(
      {
        type: "userMessage",
        id: "split-text",
        clientId: null,
        content: [
          { type: "text", text: "first", text_elements: [] },
          { type: "text", text: "second", text_elements: [] },
        ],
      },
      "turn",
      true,
    ),
  ).toMatchObject({ markdown: "first\nsecond" })
})

test("maps every collaboration action without parsing presentation titles downstream", () => {
  const expected = {
    spawnAgent: "spawn",
    sendInput: "send-input",
    sendMessage: "send-message",
    followupTask: "follow-up",
    resumeAgent: "resume",
    wait: "wait",
    interruptAgent: "interrupt",
    closeAgent: "close",
    listAgents: "list",
  } as const
  for (const [tool, action] of Object.entries(expected)) {
    const item = mapThreadItem(
      {
        type: "collabAgentToolCall",
        id: tool,
        tool: tool as keyof typeof expected,
        status: "completed",
        senderThreadId: "parent",
        receiverThreadIds: ["child"],
        prompt: "Do the work",
        model: null,
        reasoningEffort: null,
        agentsStates: { child: { status: "completed", message: "Done" } },
      } satisfies ThreadItem,
      "turn",
      true,
    )
    expect(item).toMatchObject({
      kind: "agent",
      action,
      senderThreadId: threadId("parent"),
      agentThreadIds: [threadId("child")],
      detail: "Do the work",
      status: "complete",
      agentStates: [
        { threadId: threadId("child"), status: "complete", message: "Done" },
      ],
    })
  }
})

test("maps subagent lifecycle as structured agent activity", () => {
  for (const activity of [
    "started",
    "interacted",
    "interrupted",
    "completed",
  ] as const) {
    const item = mapThreadItem(
      {
        type: "subAgentActivity",
        id: activity,
        kind: activity,
        agentThreadId: "child",
        agentPath: "/root/worker",
      },
      "turn",
      true,
    )
    expect(item).toMatchObject({
      kind: "agent",
      action: "activity",
      activity,
      agentThreadIds: [threadId("child")],
      agentPath: "/root/worker",
    })
  }
})

test("maps batchable activity from protocol semantics rather than display titles", () => {
  expect(
    mapThreadItem(
      {
        type: "webSearch",
        id: "web",
        query: "vim",
        action: { type: "search", query: "vim", queries: ["vim"] },
        results: [],
      },
      "turn",
      true,
    ),
  ).toMatchObject({ kind: "tool", activity: { family: "web-research" } })
  expect(
    mapThreadItem(
      {
        type: "mcpToolCall",
        id: "linear",
        server: "codex_apps",
        tool: "linear.get_issue",
        status: "completed",
        arguments: {},
        appContext: {
          connectorId: "linear",
          linkId: null,
          resourceUri: null,
          appName: "Linear",
          actionName: "Get issue",
        },
        pluginId: null,
        readOnlyHint: true,
        result: null,
        error: null,
        durationMs: 5,
      },
      "turn",
      true,
    ),
  ).toMatchObject({
    kind: "tool",
    activity: { family: "provider", label: "Linear" },
  })
  expect(
    mapThreadItem(
      {
        type: "mcpToolCall",
        id: "write",
        server: "codex_apps",
        tool: "linear.create_issue",
        status: "completed",
        arguments: {},
        appContext: {
          connectorId: "linear",
          linkId: null,
          resourceUri: null,
          appName: "Linear",
          actionName: "Create issue",
        },
        pluginId: null,
        readOnlyHint: false,
        result: null,
        error: null,
        durationMs: 5,
      },
      "turn",
      true,
    ),
  ).not.toHaveProperty("activity")
})

test("normalizes every target-agent status", () => {
  const expected = {
    pendingInit: "pending",
    running: "running",
    interrupted: "interrupted",
    completed: "complete",
    errored: "error",
    shutdown: "closed",
    notFound: "missing",
  } as const
  for (const [status, normalized] of Object.entries(expected)) {
    const item = mapThreadItem(
      {
        type: "collabAgentToolCall",
        id: status,
        tool: "wait",
        status: "completed",
        senderThreadId: "parent",
        receiverThreadIds: ["child"],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {
          child: { status: status as keyof typeof expected, message: null },
        },
      },
      "turn",
      true,
    )
    expect(item).toMatchObject({
      kind: "agent",
      agentStates: [{ status: normalized }],
    })
  }
})

test("malformed collaboration payload degrades to unknown instead of throwing", () => {
  const mapped = mapNotification({
    method: "item/started",
    params: {
      threadId: "thread",
      turnId: "turn",
      item: {
        type: "collabAgentToolCall",
        id: "bad",
        tool: "futureTool",
        receiverThreadIds: null,
        agentsStates: null,
      },
    },
  })
  expect(mapped).toMatchObject({
    type: "conversation",
    event: {
      type: "item.started",
      item: { kind: "unknown", title: "Invalid agent activity" },
    },
  })
})

test("malformed item payloads never create structural agent links", () => {
  const notification = {
    method: "item/started",
    params: {
      threadId: "thread",
      turnId: "turn",
      item: {
        type: "subAgentActivity",
        id: "bad",
        kind: "started",
        agentThreadId: "child",
      },
    },
  }
  expect(mapNotificationEvents(notification)).toEqual([
    expect.objectContaining({
      type: "conversation",
      event: expect.objectContaining({
        item: expect.objectContaining({ kind: "unknown" }),
      }),
    }),
  ])
})

test("invalid turn completion status remains unknown", () => {
  expect(
    mapNotification({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: { id: "turn", status: "inProgress" },
      },
    }),
  ).toEqual({
    type: "unknown",
    method: "turn/completed",
    payload: { threadId: "thread", turn: { id: "turn", status: "inProgress" } },
  })
})

test("completed known items use completion status when their payload status is malformed", () => {
  const item = mapThreadItem(
    {
      type: "commandExecution",
      id: "command",
      pluginId: null,
      scriptPath: null,
      command: "pwd",
      cwd: "/tmp",
      processId: null,
      source: "agent",
      status: "future" as never,
      commandActions: [],
      aggregatedOutput: "",
      exitCode: 0,
      durationMs: 1,
    },
    "turn",
    true,
  )
  expect(item.status).toBe("complete")
})

test("malformed agent diagnostics are explicitly non-semantic", () => {
  const mapped = mapNotification({
    method: "item/started",
    params: {
      threadId: "thread",
      turnId: "turn",
      item: {
        type: "subAgentActivity",
        id: "bad",
        kind: "started",
        agentThreadId: "opaque-child",
      },
    },
  })
  expect(mapped).toMatchObject({
    type: "conversation",
    event: { item: { kind: "unknown", transcript: "diagnostic" } },
  })
})

test("normalizes server turn timestamps from seconds to milliseconds", () => {
  expect(
    mapNotification({
      method: "turn/started",
      params: { threadId: "thread", turn: { id: "turn", startedAt: 12.5 } },
    }),
  ).toMatchObject({
    type: "conversation",
    event: { type: "turn.started", startedAt: 12_500 },
  })
  expect(
    mapNotification({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          id: "turn",
          status: "completed",
          startedAt: 12.5,
          completedAt: 15,
          durationMs: 2_500,
        },
      },
    }),
  ).toMatchObject({
    type: "conversation",
    event: {
      type: "turn.completed",
      startedAt: 12_500,
      completedAt: 15_000,
      durationMs: 2_500,
    },
  })
})

test("rejects timestamps that overflow during seconds normalization", () => {
  expect(
    mapNotification({
      method: "turn/started",
      params: {
        threadId: "thread",
        turn: { id: "turn", startedAt: Number.MAX_VALUE },
      },
    }),
  ).toMatchObject({
    type: "conversation",
    event: { type: "turn.started", startedAt: undefined },
  })
})

test("hydrates observed turn timing", () => {
  const events = hydrateTurns(
    [
      {
        id: "turn",
        items: [],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 12.5,
        completedAt: 15,
        durationMs: 2_500,
      },
    ],
    "thread",
  )
  expect(events).toEqual([
    {
      type: "turn.started",
      threadId: threadId("thread"),
      turnId: turnId("turn"),
      startedAt: 12_500,
    },
    {
      type: "turn.completed",
      threadId: threadId("thread"),
      turnId: turnId("turn"),
      outcome: "complete",
      startedAt: 12_500,
      completedAt: 15_000,
      durationMs: 2_500,
    },
  ])
})

test("only spawning establishes ancestry; messaging and other targets stay transcript activity", () => {
  for (const tool of [
    "spawnAgent",
    "sendMessage",
    "sendInput",
    "followupTask",
    "resumeAgent",
    "wait",
    "interruptAgent",
    "closeAgent",
    "listAgents",
  ] as const) {
    const events = mapNotificationEvents({
      method: "item/completed",
      params: {
        threadId: "child",
        turnId: "turn",
        item: {
          type: "collabAgentToolCall",
          id: tool,
          tool,
          status: "completed",
          senderThreadId: "child",
          receiverThreadIds: ["parent"],
          agentsStates: {},
        },
      },
    })
    expect(events.some((event) => event.type === "conversation")).toBe(true)
    const links = events.filter((event) => event.type === "subagent.link")
    expect(links).toHaveLength(tool === "spawnAgent" ? 1 : 0)
  }
})
