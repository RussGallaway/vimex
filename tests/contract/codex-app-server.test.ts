import { describe, expect, test } from "bun:test"
import {
  CodexAppServerClient,
  createCodexGateways,
  StdioTransport,
  type CodexAdapterEvent,
  type CodexTransport,
  type JsonObject,
  RpcClient,
  type StdioProcess,
} from "@vimex/codex-app-server"
import { itemId, threadId, turnId } from "@vimex/conversation"

class FakeTransport implements CodexTransport {
  readonly sent: JsonObject[] = []
  started = false
  closed = false
  private readonly messages = new Set<(message: unknown) => void>()
  private readonly errors = new Set<(error: Error) => void>()
  private readonly closes = new Set<(error?: Error) => void>()

  async start() {
    this.started = true
  }
  async send(message: JsonObject) {
    this.sent.push(message)
  }
  async close() {
    this.closed = true
    for (const listener of this.closes) listener()
  }
  onMessage(listener: (message: unknown) => void) {
    this.messages.add(listener)
    return () => this.messages.delete(listener)
  }
  onError(listener: (error: Error) => void) {
    this.errors.add(listener)
    return () => this.errors.delete(listener)
  }
  onClose(listener: (error?: Error) => void) {
    this.closes.add(listener)
    return () => this.closes.delete(listener)
  }
  receive(message: unknown) {
    for (const listener of this.messages) listener(message)
  }
  fail(error: Error) {
    for (const listener of this.errors) listener(error)
  }
  exit(error?: Error) {
    for (const listener of this.closes) listener(error)
  }
}

class FakeProcess implements StdioProcess {
  readonly writes: string[] = []
  killed = false
  ended = false
  stdout?: (chunk: string | Uint8Array) => void
  stderr?: (chunk: string | Uint8Array) => void
  error?: (error: Error) => void
  exit?: (code: number | null, signal: string | null) => void
  async write(value: string) {
    this.writes.push(value)
  }
  end() {
    this.ended = true
  }
  kill() {
    this.killed = true
  }
  onStdout(listener: (chunk: string | Uint8Array) => void) {
    this.stdout = listener
  }
  onStderr(listener: (chunk: string | Uint8Array) => void) {
    this.stderr = listener
  }
  onError(listener: (error: Error) => void) {
    this.error = listener
  }
  onExit(listener: (code: number | null, signal: string | null) => void) {
    this.exit = listener
  }
}

const initializeResult = {
  userAgent: "codex-cli/0.154.0",
  codexHome: "/tmp/codex",
  platformFamily: "unix",
  platformOs: "macos",
}

const baseThread = {
  id: "thr-1",
  environments: null,
  extra: null,
  sessionId: "thr-1",
  forkedFromId: null,
  parentThreadId: null,
  preview: "Fix parser",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "full",
  modelProvider: "openai",
  model: "gpt-test",
  reasoningEffort: "high",
  createdAt: 1,
  updatedAt: 2,
  recencyAt: 2,
  status: { type: "idle" },
  path: null,
  cwd: "/repo",
  cliVersion: "0.154.0",
  originator: null,
  source: "appServer",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: { sha: "abc", branch: "main", originUrl: null },
  name: "Parser",
  daybreakEnabled: null,
  turns: [],
}

async function connectedClient(experimentalApi = false) {
  const transport = new FakeTransport()
  const client = new CodexAppServerClient(transport, {
    clientInfo: { name: "vimex_test", title: "Vimex Test", version: "1.0.0" },
    experimentalApi,
  })
  const connecting = client.connect()
  await tick()
  const initialize = transport.sent[0]
  expect(initialize).toEqual({
    method: "initialize",
    id: 1,
    params: {
      clientInfo: { name: "vimex_test", title: "Vimex Test", version: "1.0.0" },
      capabilities: { experimentalApi, requestAttestation: false },
    },
  })
  transport.receive({ id: 1, result: initializeResult })
  await connecting
  expect(transport.sent[1]).toEqual({ method: "initialized" })
  return { client, transport }
}

describe("JSONL stdio transport", () => {
  test("frames split chunks, reports malformed lines, and writes one message per line", async () => {
    const process = new FakeProcess()
    const stderr: string[] = []
    const transport = new StdioTransport({
      processFactory: () => process,
      onStderr: (value) => stderr.push(value),
    })
    const messages: unknown[] = []
    const errors: string[] = []
    transport.onMessage((message) => messages.push(message))
    transport.onError((error) => errors.push(error.message))

    await transport.start()
    process.stdout?.('{"id":1,"res')
    process.stdout?.(
      'ult":{}}\nnot-json\n{"method":"turn/started","params":{}}\n',
    )
    process.stderr?.("diagnostic")
    await transport.send({ method: "initialized" })

    expect(messages).toEqual([
      { id: 1, result: {} },
      { method: "turn/started", params: {} },
    ])
    expect(errors[0]).toContain("Invalid JSONL")
    expect(stderr).toEqual(["diagnostic"])
    expect(process.writes).toEqual(['{"method":"initialized"}\n'])

    await transport.close()
    expect(process.ended).toBe(true)
    expect(process.killed).toBe(true)
  })

  test("decodes a multibyte JSON string split across byte chunks", async () => {
    const process = new FakeProcess()
    const transport = new StdioTransport({ processFactory: () => process })
    const messages: unknown[] = []
    transport.onMessage((message) => messages.push(message))
    await transport.start()
    const bytes = new TextEncoder().encode(
      '{"method":"notice","params":{"text":"👨"}}\n',
    )
    const emojiStart = bytes.findIndex((value) => value === 0xf0)
    process.stdout?.(bytes.slice(0, emojiStart + 2))
    process.stdout?.(bytes.slice(emojiStart + 2))
    expect(messages).toEqual([{ method: "notice", params: { text: "👨" } }])
    await transport.close()
  })
})

describe("Codex app-server client", () => {
  test("receives a later user-facing thread name", async () => {
    const { client, transport } = await connectedClient()
    const events: CodexAdapterEvent[] = []
    client.onEvent((event) => events.push(event))
    transport.receive({
      method: "thread/name/updated",
      params: { threadId: "thr-1", threadName: "My\n  session" },
    })
    expect(events).toContainEqual({
      type: "thread.name",
      threadId: threadId("thr-1"),
      name: "My session",
    })
  })
  test("initializes before issuing calls and correlates out-of-order responses", async () => {
    const { client, transport } = await connectedClient()
    const listed = client.listThreads()
    const started = client.startThread({ cwd: "/repo" })
    await tick()

    const listRequest = transport.sent[2]
    const startRequest = transport.sent[3]
    expect(listRequest).toMatchObject({
      method: "thread/list",
      params: {
        sortKey: "recency_at",
        sortDirection: "desc",
        sourceKinds: [
          "cli",
          "vscode",
          "exec",
          "appServer",
          "subAgent",
          "subAgentReview",
          "subAgentCompact",
          "subAgentThreadSpawn",
          "subAgentOther",
          "unknown",
        ],
      },
    })
    expect(startRequest).toMatchObject({
      method: "thread/start",
      params: { cwd: "/repo" },
    })

    transport.receive({
      id: startRequest!.id,
      result: sessionResponse(baseThread),
    })
    transport.receive({
      id: listRequest!.id,
      result: {
        data: [baseThread],
        nextCursor: null,
        backwardsCursor: "newer",
      },
    })

    expect((await started).summary).toMatchObject({
      title: "Parser",
      gitBranch: "main",
      status: "idle",
      updatedAt: 2_000,
    })
    expect(await listed).toMatchObject({
      nextCursor: null,
      backwardsCursor: "newer",
    })
  })

  test("builds exact turn, steering, interruption, rename, and settings requests", async () => {
    const { client, transport } = await connectedClient()

    const turn = client.startTurn("thr-1", "hello", { effort: "high" })
    await respondNext(transport, "turn/start", {
      turn: { id: "turn-1", items: [], status: "inProgress", error: null },
    })
    await turn
    expect(findSent(transport, "turn/start").params).toEqual({
      threadId: "thr-1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      effort: "high",
    })

    const steer = client.steerTurn("thr-1", "turn-1", "focus tests")
    await respondNext(transport, "turn/steer", { turnId: "turn-1" })
    await steer
    expect(findSent(transport, "turn/steer").params).toEqual({
      threadId: "thr-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "focus tests", text_elements: [] }],
    })

    const interrupt = client.interruptTurn("thr-1", "turn-1")
    await respondNext(transport, "turn/interrupt", {})
    await interrupt
    const rename = client.renameThread("thr-1", "New name")
    await respondNext(transport, "thread/name/set", {})
    await rename
    const settings = client.updateThreadSettings("thr-1", {
      model: "gpt-next",
      effort: "low",
      cwd: "/next",
    })
    await respondNext(transport, "thread/settings/update", {})
    await settings
    expect(findSent(transport, "thread/settings/update").params).toEqual({
      threadId: "thr-1",
      model: "gpt-next",
      effort: "low",
      cwd: "/next",
    })
  })

  test("normalizes streamed conversation, status, token metadata, and unknown events", async () => {
    const { client, transport } = await connectedClient()
    const events: CodexAdapterEvent[] = []
    client.onEvent((event) => events.push(event))

    transport.receive({
      method: "thread/status/changed",
      params: {
        threadId: "thr-1",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
      },
    })
    transport.receive({
      method: "turn/started",
      params: {
        threadId: "thr-1",
        turn: { id: "turn-1", status: "inProgress", items: [] },
      },
    })
    transport.receive({
      method: "item/started",
      params: {
        threadId: "thr-1",
        turnId: "turn-1",
        startedAtMs: 1,
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "",
          phase: "commentary",
          memoryCitation: null,
          delivery: null,
          questions: null,
        },
      },
    })
    transport.receive({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thr-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "hello",
      },
    })
    transport.receive({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thr-1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 4200,
            inputTokens: 3000,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 1200,
            reasoningOutputTokens: 200,
          },
          last: {
            totalTokens: 42,
            inputTokens: 30,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 12,
            reasoningOutputTokens: 2,
          },
          modelContextWindow: 1000,
        },
      },
    })
    transport.receive({ method: "future/event", params: { value: 1 } })

    expect(events).toContainEqual({
      type: "thread.status",
      threadId: threadId("thr-1"),
      status: "blocked",
    })
    expect(events).toContainEqual({
      type: "conversation",
      event: {
        type: "item.delta",
        threadId: threadId("thr-1"),
        itemId: itemId("item-1"),
        delta: "hello",
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread.tokenUsage",
        used: 42,
        contextLimit: 1000,
      }),
    )
    expect(events).toContainEqual({
      type: "unknown",
      method: "future/event",
      payload: { value: 1 },
    })
  })

  test("preserves numeric approval ids and waits for server resolution", async () => {
    const { client, transport } = await connectedClient()
    const events: CodexAdapterEvent[] = []
    client.onEvent((event) => events.push(event))
    transport.receive({
      method: "item/commandExecution/requestApproval",
      id: 17,
      params: {
        kind: "command",
        threadId: "thr-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
        environmentId: null,
        command: "git fetch",
        cwd: "/repo",
        availableDecisions: ["accept", "decline"],
      },
    })

    expect(events.at(-1)).toMatchObject({
      type: "approval.requested",
      requestId: 17,
      approval: { id: "number:17", kind: "command", title: "git fetch" },
    })
    await client.resolveApproval("number:17", "accept")
    expect(transport.sent.at(-1)).toEqual({
      id: 17,
      result: { decision: "accept" },
    })
    await expect(client.resolveApproval(17, "accept")).rejects.toThrow(
      "already answered",
    )

    transport.receive({
      method: "serverRequest/resolved",
      params: { threadId: "thr-1", requestId: 17 },
    })
    expect(events.at(-1)).toEqual({
      type: "approval.resolved",
      threadId: threadId("thr-1"),
      requestId: 17,
    })
    await expect(client.resolveApproval(17, "accept")).rejects.toThrow(
      "Unknown or resolved",
    )

    transport.receive({
      method: "item/commandExecution/requestApproval",
      id: 19,
      params: {
        kind: "command",
        threadId: "thr-1",
        turnId: "turn-1",
        itemId: "item-2",
        startedAtMs: 1,
        environmentId: null,
        command: "git push",
        cwd: "/repo",
      },
    })
    const fallback = events.at(-1)
    expect(fallback).toMatchObject({ type: "approval.requested" })
    if (fallback?.type !== "approval.requested")
      throw new Error("expected approval")
    expect(fallback.approval.choices.map((choice) => choice.id)).toEqual([
      "accept",
      "decline",
      "cancel",
    ])
  })

  test("maps file and permission approvals and returns the requested permission subset", async () => {
    const { client, transport } = await connectedClient()
    const events: CodexAdapterEvent[] = []
    client.onEvent((event) => events.push(event))

    transport.receive({
      method: "item/fileChange/requestApproval",
      id: "file-1",
      params: {
        threadId: "thr-1",
        turnId: "turn-1",
        itemId: "edit-1",
        startedAtMs: 1,
        reason: "write",
      },
    })
    expect(events.at(-1)).toMatchObject({
      type: "approval.requested",
      approval: { id: "string:file-1", kind: "file-change" },
    })
    await client.resolveApproval("string:file-1", "acceptForSession")
    expect(transport.sent.at(-1)).toEqual({
      id: "file-1",
      result: { decision: "acceptForSession" },
    })

    transport.receive({
      method: "item/permissions/requestApproval",
      id: 18,
      params: {
        threadId: "thr-1",
        turnId: "turn-1",
        itemId: "permissions-1",
        environmentId: null,
        startedAtMs: 1,
        cwd: "/repo",
        reason: "network",
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    })
    await client.resolveApproval("number:18", "grant-session")
    expect(transport.sent.at(-1)).toEqual({
      id: 18,
      result: { permissions: { network: { enabled: true } }, scope: "session" },
    })
  })

  test("forks at a completed turn and normalizes model catalog entries", async () => {
    const { client, transport } = await connectedClient()
    const forked = client.forkThread("thr-1", "turn-1", { ephemeral: true })
    await tick()
    const forkRequest = findSent(transport, "thread/fork")
    expect(forkRequest.params).toEqual({
      threadId: "thr-1",
      lastTurnId: "turn-1",
      ephemeral: true,
    })
    transport.receive({
      id: forkRequest.id,
      result: sessionResponse({
        ...baseThread,
        id: "thr-fork",
        forkedFromId: "thr-1",
      }),
    })
    expect((await forked).summary.id).toBe(threadId("thr-fork"))

    const models = client.listModels({ limit: 20 })
    await tick()
    const modelsRequest = findSent(transport, "model/list")
    transport.receive({
      id: modelsRequest.id,
      result: {
        data: [
          {
            id: "gpt-test",
            model: "gpt-test",
            displayName: "GPT Test",
            description: "Test model",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
            ],
            defaultReasoningEffort: "low",
            inputModalities: ["text"],
            isDefault: true,
          },
        ],
        nextCursor: null,
      },
    })
    expect((await models).models[0]).toEqual({
      id: "gpt-test",
      model: "gpt-test",
      label: "GPT Test",
      description: "Test model",
      supportedReasoningEfforts: [{ effort: "low", description: "Fast" }],
      defaultReasoningEffort: "low",
      inputModalities: ["text"],
      isDefault: true,
    })
  })

  test("hydrates stored turns without completing an in-progress turn", async () => {
    const { client, transport } = await connectedClient()
    const resumed = client.resumeThread("thr-1")
    await tick()
    const request = findSent(transport, "thread/resume")
    expect(request.params).toEqual({ threadId: "thr-1" })
    transport.receive({
      id: request.id,
      result: sessionResponse({
        ...baseThread,
        turns: [
          {
            id: "turn-done",
            items: [
              {
                type: "agentMessage",
                id: "item-done",
                text: "done",
                phase: "final_answer",
                memoryCitation: null,
                delivery: null,
                questions: null,
              },
            ],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1000,
          },
          {
            id: "turn-live",
            items: [],
            itemsView: "full",
            status: "inProgress",
            error: null,
            startedAt: 3,
            completedAt: null,
            durationMs: null,
          },
        ],
      }),
    })
    const session = await resumed
    expect(
      session.events.some(
        (event) =>
          event.type === "turn.completed" && event.turnId === "turn-done",
      ),
    ).toBe(true)
    expect(
      session.events.some(
        (event) =>
          event.type === "turn.completed" && event.turnId === "turn-live",
      ),
    ).toBe(false)
  })

  test("hydrates paginated turns and missing full items in chronological order", async () => {
    const { client, transport } = await connectedClient(true)
    const resumed = client.resumeThread("thr-1")
    await tick()
    const request = findSent(transport, "thread/resume")
    expect(request.params).toMatchObject({
      threadId: "thr-1",
      excludeTurns: true,
      initialTurnsPage: {
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      },
    })
    transport.receive({
      id: request.id,
      result: {
        ...sessionResponse({ ...baseThread, turns: [] }),
        initialTurnsPage: {
          data: [turnFixture("new", 2, "full", [agentItem("new-item", "new")])],
          nextCursor: "older",
          backwardsCursor: null,
        },
        turnsBackwardsCursor: null,
        itemsBackwardsCursor: null,
      },
    })
    await tick()
    const older = findSent(transport, "thread/turns/list")
    expect(older.params).toMatchObject({
      threadId: "thr-1",
      cursor: "older",
      sortDirection: "desc",
      itemsView: "full",
    })
    transport.receive({
      id: older.id,
      result: {
        data: [turnFixture("old", 1, "summary", [])],
        nextCursor: null,
        backwardsCursor: null,
      },
    })
    await tick()
    const items = findSent(transport, "thread/items/list")
    expect(items.params).toMatchObject({
      threadId: "thr-1",
      turnId: "old",
      sortDirection: "asc",
    })
    transport.receive({
      id: items.id,
      result: {
        data: [{ turnId: "old", item: agentItem("old-item", "old") }],
        nextCursor: null,
        backwardsCursor: null,
      },
    })
    const session = await resumed
    const starts = session.events.filter(
      (event) => event.type === "turn.started",
    )
    expect(starts.map((event) => event.turnId)).toEqual([
      turnId("old"),
      turnId("new"),
    ])
    expect(
      session.events.some(
        (event) =>
          event.type === "item.started" && event.item.id === "old-item",
      ),
    ).toBe(true)
  })

  test("normalizes user questions, answers them, and rejects unsupported server requests", async () => {
    const { client, transport } = await connectedClient()
    const events: CodexAdapterEvent[] = []
    client.onEvent((event) => events.push(event))
    transport.receive({
      method: "item/tool/requestUserInput",
      id: 21,
      params: {
        threadId: "thr-1",
        turnId: "turn-1",
        itemId: "question-1",
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: "q",
            header: "Choice",
            question: "Pick",
            isOther: true,
            isSecret: false,
            options: [{ label: "A", description: "first" }],
          },
        ],
      },
    })
    expect(events.at(-1)).toMatchObject({
      type: "userInput.requested",
      requestId: 21,
      isBlocking: true,
      questions: [{ id: "q", allowOther: true }],
    })
    await client.respondToUserInput(21, { q: "A" })
    expect(transport.sent.at(-1)).toEqual({
      id: 21,
      result: { answers: { q: { answers: ["A"] } } },
    })

    transport.receive({
      method: "item/tool/call",
      id: 22,
      params: { threadId: "thr-1" },
    })
    await tick()
    expect(transport.sent.at(-1)).toEqual({
      id: 22,
      error: {
        code: -32601,
        message: "Unsupported server request: item/tool/call",
      },
    })
  })

  test("keeps reasoning summary separate, maps live plan and patch updates, and marks interrupted tools", async () => {
    const { client, transport } = await connectedClient()
    const events: CodexAdapterEvent[] = []
    client.onEvent((event) => events.push(event))
    const common = { threadId: "thr-1", turnId: "turn-1", itemId: "item-1" }
    transport.receive({
      method: "item/reasoning/summaryPartAdded",
      params: { ...common, summaryIndex: 1 },
    })
    transport.receive({
      method: "item/reasoning/summaryTextDelta",
      params: { ...common, summaryIndex: 1, delta: "summary" },
    })
    transport.receive({
      method: "item/reasoning/textDelta",
      params: { ...common, contentIndex: 0, delta: "raw reasoning" },
    })
    transport.receive({
      method: "item/plan/delta",
      params: { ...common, delta: "plan" },
    })
    transport.receive({
      method: "item/fileChange/patchUpdated",
      params: {
        ...common,
        changes: [{ path: "a.ts", kind: "update", diff: "+x" }],
      },
    })
    transport.receive({
      method: "item/completed",
      params: {
        threadId: "thr-1",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          id: "agent-call",
          tool: "wait",
          status: "interrupted",
          senderThreadId: "thr-1",
          receiverThreadIds: [],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "unknown",
        method: "item/reasoning/textDelta",
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "conversation",
        event: expect.objectContaining({ type: "item.delta", delta: "plan" }),
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "conversation",
        event: expect.objectContaining({
          type: "item.completed",
          item: expect.objectContaining({ kind: "edit", patch: "+x" }),
        }),
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "conversation",
        event: expect.objectContaining({
          item: expect.objectContaining({
            id: "agent-call",
            status: "interrupted",
          }),
        }),
      }),
    )
  })

  test("preserves subagent thread and item linkage", async () => {
    const { client, transport } = await connectedClient()
    const events: CodexAdapterEvent[] = []
    client.onEvent((event) => events.push(event))
    transport.receive({
      method: "thread/started",
      params: {
        thread: {
          ...baseThread,
          id: "child",
          parentThreadId: "thr-1",
          source: "appServer",
          agentNickname: "worker",
          agentRole: "tester",
        },
      },
    })
    transport.receive({
      method: "item/started",
      params: {
        threadId: "thr-1",
        turnId: "turn-1",
        item: {
          type: "subAgentActivity",
          id: "activity",
          kind: "started",
          agentThreadId: "child",
          agentPath: "/root/worker",
        },
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread.summary",
        relation: expect.objectContaining({
          threadId: "child",
          parentThreadId: "thr-1",
          agentNickname: "worker",
        }),
      }),
    )
    expect(events).toContainEqual({
      type: "subagent.link",
      link: {
        ownerThreadId: threadId("thr-1"),
        agentThreadId: threadId("child"),
        itemId: itemId("activity"),
        relation: "spawned",
        agentPath: "/root/worker",
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "conversation",
        event: expect.objectContaining({
          item: expect.objectContaining({ action: "spawn" }),
        }),
      }),
    )
  })

  test("times out unanswered RPC calls and cancels pending approvals on disconnect", async () => {
    const raw = new FakeTransport()
    await raw.start()
    const rpc = new RpcClient(raw, { requestTimeoutMs: 5 })
    await expect(rpc.request("never/replies", {})).rejects.toThrow("timed out")

    const { client, transport } = await connectedClient()
    const events: CodexAdapterEvent[] = []
    client.onEvent((event) => events.push(event))
    transport.receive({
      method: "item/fileChange/requestApproval",
      id: 31,
      params: {
        threadId: "thr-1",
        turnId: "turn-1",
        itemId: "edit",
        startedAtMs: 1,
      },
    })
    transport.exit(new Error("gone"))
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "approval.cancelled",
        requestId: 31,
        error: "gone",
      }),
    )
    await expect(client.resolveApproval(31, "accept")).rejects.toThrow(
      "Unknown or resolved",
    )
  })

  test("emits connection failure even with no pending request", async () => {
    const { client, transport } = await connectedClient()
    const events: CodexAdapterEvent[] = []
    client.onEvent((event) => events.push(event))
    transport.exit(new Error("child crashed"))
    expect(events).toContainEqual({
      type: "connection",
      status: "error",
      error: "child crashed",
    })
  })
})

describe("Codex gateway lifecycle", () => {
  test("sends image attachments as app-server localImage inputs for turns and steering", async () => {
    const { client, transport } = await connectedClient()
    const gateway = createCodexGateways("/repo", "codex", () => client)
    try {
      const started = gateway.conversation.startTurn(
        threadId("thr-1"),
        "inspect",
        "message-1",
        [
          { type: "text", text: "inspect " },
          { type: "image", path: "/owned/screen.png" },
          { type: "text", text: " now" },
        ],
      )
      await respondNext(transport, "turn/start", {
        turn: { id: "turn-1", items: [], status: "inProgress", error: null },
      })
      await started
      expect(findSent(transport, "turn/start").params).toMatchObject({
        input: [
          { type: "text", text: "inspect ", text_elements: [] },
          { type: "localImage", path: "/owned/screen.png" },
          { type: "text", text: " now", text_elements: [] },
        ],
        clientUserMessageId: "message-1",
      })
      const steered = gateway.conversation.steerTurn(
        threadId("thr-1"),
        turnId("turn-1"),
        "",
        "message-2",
        [{ type: "image", path: "/owned/second.png" }],
      )
      await respondNext(transport, "turn/steer", { turnId: "turn-1" })
      await steered
      expect(findSent(transport, "turn/steer").params).toMatchObject({
        input: [{ type: "localImage", path: "/owned/second.png" }],
        clientUserMessageId: "message-2",
      })
    } finally {
      await gateway.connection.close()
    }
  })
  test("restarts through a new handshake, invalidates connection state, and keeps subscribers attached", async () => {
    const transports: FakeTransport[] = []
    const gateways = createCodexGateways("/repo", "codex", () => {
      const transport = new FakeTransport()
      transports.push(transport)
      return new CodexAppServerClient(transport, {
        clientInfo: {
          name: "vimex_test",
          title: "Vimex Test",
          version: "1.0.0",
        },
      })
    })
    const events: Array<{ type: string; [key: string]: unknown }> = []
    gateways.connection.subscribe((event) => events.push(event))

    const connecting = gateways.connection.connect()
    await tick()
    transports[0]!.receive({ id: 1, result: initializeResult })
    await connecting

    transports[0]!.receive({
      method: "item/fileChange/requestApproval",
      id: 31,
      params: {
        threadId: "thr-1",
        turnId: "turn-1",
        itemId: "edit",
        startedAtMs: 1,
      },
    })
    const oldRequest = gateways.conversation.listThreads()
    const oldRequestOutcome = oldRequest.then(
      () => "resolved",
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    )

    const firstRestart = gateways.connection.restart()
    const sameRestart = gateways.connection.restart()
    await tick()
    expect(transports).toHaveLength(2)
    expect(await oldRequestOutcome).not.toBe("resolved")
    expect(events).toContainEqual({
      type: "disconnected",
      message: "Restarting Codex app server",
      reason: "restart",
    })
    expect(events).toContainEqual({
      type: "approval.resolved",
      id: "number:31",
    })
    await expect(
      gateways.approvals.resolveApproval("number:31", "accept"),
    ).rejects.toThrow("no longer pending")

    expect(transports[1]!.sent[0]).toMatchObject({
      method: "initialize",
      id: 1,
    })
    transports[1]!.receive({ id: 1, result: initializeResult })
    await Promise.all([firstRestart, sameRestart])
    expect(transports[1]!.sent[1]).toEqual({ method: "initialized" })
    expect(events.filter((event) => event.type === "disconnected")).toEqual([
      {
        type: "disconnected",
        message: "Restarting Codex app server",
        reason: "restart",
      },
    ])

    const beforeOldEvent = events.length
    transports[0]!.receive({
      method: "warning",
      params: { message: "stale generation" },
    })
    expect(events).toHaveLength(beforeOldEvent)
    transports[1]!.receive({
      method: "warning",
      params: { message: "new generation" },
    })
    expect(events.at(-1)).toEqual({ type: "notice", message: "new generation" })

    const child = gateways.conversation.startThread("/repo")
    await tick()
    const start = findSent(transports[1]!, "thread/start")
    transports[1]!.receive({
      id: start.id,
      result: sessionResponse({
        ...baseThread,
        id: "child",
        parentThreadId: "thr-1",
        recencyAt: 9,
      }),
    })
    expect((await child).summary.updatedAt).toBe(9_000)
    expect(events).toContainEqual({
      type: "subagent.link",
      link: {
        parentId: threadId("thr-1"),
        childId: threadId("child"),
        itemId: itemId("thread:child"),
        relation: "spawned",
      },
    })

    await gateways.connection.close()
    await expect(gateways.connection.restart()).rejects.toThrow("closed")
  })
})

function agentItem(id: string, text: string) {
  return {
    type: "agentMessage",
    id,
    text,
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
    questions: null,
  }
}

function turnFixture(
  id: string,
  startedAt: number,
  itemsView: "full" | "summary",
  items: unknown[],
) {
  return {
    id,
    items,
    itemsView,
    status: "completed",
    error: null,
    startedAt,
    completedAt: startedAt + 1,
    durationMs: 1000,
  }
}

function sessionResponse(thread: typeof baseThread | Record<string, unknown>) {
  return {
    thread,
    model: "gpt-test",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/repo",
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite" },
    activePermissionProfile: null,
    reasoningEffort: "high",
    multiAgentMode: "explicitRequestOnly",
  }
}

function findSent(transport: FakeTransport, method: string): JsonObject {
  const message = transport.sent.findLast(
    (candidate) => candidate.method === method,
  )
  if (!message) throw new Error(`Missing sent method ${method}`)
  return message
}

async function respondNext(
  transport: FakeTransport,
  method: string,
  result: unknown,
) {
  await tick()
  const request = findSent(transport, method)
  transport.receive({ id: request.id, result })
}

function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe("model catalog pagination", () => {
  const wireModel = (model: string) => ({
    id: `catalog-${model}`,
    model,
    displayName: model,
    description: "Test",
    supportedReasoningEfforts: [
      { reasoningEffort: "high", description: "Deep" },
    ],
    defaultReasoningEffort: "high",
    inputModalities: ["text"],
    isDefault: false,
  })

  test("maps every model page using the actual model identifier", async () => {
    const { client, transport } = await connectedClient()
    const gateway = createCodexGateways("/repo", "codex", () => client)
    try {
      const result = gateway.models.listModels()
      await respondNext(transport, "model/list", {
        data: [wireModel("first")],
        nextCursor: "page-two",
      })
      await tick()
      const next = findSent(transport, "model/list")
      expect(next.params).toEqual({ cursor: "page-two", limit: 100 })
      transport.receive({
        id: next.id,
        result: { data: [wireModel("second")], nextCursor: null },
      })
      expect(await result).toEqual([
        { id: "first", label: "first", efforts: ["high"] },
        { id: "second", label: "second", efforts: ["high"] },
      ])
    } finally {
      await gateway.connection.close()
    }
  })

  test("rejects cyclic cursors instead of hanging or silently truncating", async () => {
    const { client, transport } = await connectedClient()
    const gateway = createCodexGateways("/repo", "codex", () => client)
    try {
      const result = gateway.models.listModels()
      const rejected = result.then(
        () => undefined,
        (error) => error,
      )
      await respondNext(transport, "model/list", {
        data: [wireModel("first")],
        nextCursor: "repeated",
      })
      await respondNext(transport, "model/list", {
        data: [],
        nextCursor: "repeated",
      })
      expect(String(await rejected)).toContain("repeated pagination cursor")
      expect(
        transport.sent.filter((message) => message.method === "model/list"),
      ).toHaveLength(2)
    } finally {
      await gateway.connection.close()
    }
  })
})

test("goal capability uses pinned get/set/clear RPC contracts and omits unrequested budgets", async () => {
  const { client, transport } = await connectedClient()
  const goal = {
    threadId: "thr-1",
    objective: "Fix tests",
    status: "active" as const,
    tokenBudget: null,
    tokensUsed: 10,
    timeUsedSeconds: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  const get = client.getGoal("thr-1")
  await respondNext(transport, "thread/goal/get", { goal: null })
  expect(await get).toBeNull()
  const set = client.setGoal("thr-1", {
    objective: "Fix tests",
    status: "active",
  })
  await tick()
  expect(transport.sent.at(-1)?.params).toEqual({
    threadId: "thr-1",
    objective: "Fix tests",
    status: "active",
  })
  await respondNext(transport, "thread/goal/set", { goal })
  expect(await set).toEqual(goal)
  const clear = client.clearGoal("thr-1")
  await respondNext(transport, "thread/goal/clear", { cleared: true })
  expect(await clear).toBe(true)
  await client.close()
})

test("side fork is ephemeral, clears inherited goal, and retirement unsubscribes child", async () => {
  const { client, transport } = await connectedClient(true)
  const gateway = createCodexGateways("/repo", "codex", () => client)
  try {
    const fork = gateway.conversation.forkSideThread!(threadId("thr-1"))
    await respondNext(
      transport,
      "thread/fork",
      sessionResponse({ ...baseThread, id: "side-thread" }),
    )
    expect(findSent(transport, "thread/fork").params).toEqual({
      threadId: "thr-1",
      deferGoalContinuation: true,
      ephemeral: true,
      excludeTurns: true,
    })
    await respondNext(transport, "thread/goal/clear", { cleared: true })
    expect(findSent(transport, "thread/goal/clear").params).toEqual({
      threadId: "side-thread",
    })
    expect((await fork).summary.id).toBe(threadId("side-thread"))
    const retiring = gateway.conversation.retireThread!(threadId("side-thread"))
    await respondNext(transport, "thread/unsubscribe", {
      status: "unsubscribed",
    })
    await retiring
    expect(findSent(transport, "thread/unsubscribe").params).toEqual({
      threadId: "side-thread",
    })
  } finally {
    await gateway.connection.close()
  }
})

test("thread shell command uses the pinned RPC and leaves streamed output to turn events", async () => {
  const { client, transport } = await connectedClient()
  const gateway = createCodexGateways("/repo", "codex", () => client)
  const events: import("@vimex/workbench").RuntimeEvent[] = []
  gateway.connection.subscribe((event) => events.push(event))
  try {
    const request = gateway.conversation.shellCommand!(
      threadId("thr-1"),
      "pwd | cat",
    )
    await tick()
    expect(findSent(transport, "thread/shellCommand").params).toEqual({
      threadId: "thr-1",
      command: "pwd | cat",
    })
    await respondNext(transport, "thread/shellCommand", {})
    await request
    expect(events).toEqual([])
    transport.receive({
      method: "turn/started",
      params: {
        threadId: "thr-1",
        turn: { id: "shell-turn", items: [], status: "inProgress" },
      },
    })
    expect(events.some((event) => event.type === "conversation")).toBe(true)
  } finally {
    await gateway.connection.close()
  }
})

test("compaction sends pinned RPC and observes item lifecycle independently of acknowledgement", async () => {
  const { client, transport } = await connectedClient()
  const gateways = createCodexGateways("/repo", "codex", () => client)
  const events: import("@vimex/workbench").RuntimeEvent[] = []
  gateways.connection.subscribe((event) => events.push(event))
  const request = gateways.conversation.compactThread!(threadId("thr-1"))
  await tick()
  expect(findSent(transport, "thread/compact/start").params).toEqual({
    threadId: "thr-1",
  })
  await respondNext(transport, "thread/compact/start", {})
  await request
  expect(events).toEqual([])
  const params = {
    threadId: threadId("thr-1"),
    turnId: turnId("compact-turn"),
    item: { id: "compact-item", type: "contextCompaction" },
  }
  transport.receive({ method: "item/started", params })
  transport.receive({ method: "item/completed", params })
  transport.receive({
    method: "thread/compacted",
    params: { threadId: threadId("thr-1"), turnId: turnId("compact-turn") },
  })
  expect(events.filter((event) => event.type === "compaction")).toEqual([
    {
      type: "compaction",
      phase: "started",
      threadId: threadId("thr-1"),
      turnId: turnId("compact-turn"),
    },
    {
      type: "compaction",
      phase: "completed",
      threadId: threadId("thr-1"),
      turnId: turnId("compact-turn"),
    },
    {
      type: "compaction",
      phase: "completed",
      threadId: threadId("thr-1"),
      turnId: turnId("compact-turn"),
    },
  ])
  expect(events.filter((event) => event.type === "conversation")).toHaveLength(
    2,
  )
  events.length = 0
  transport.receive({
    method: "error",
    params: {
      threadId: threadId("thr-1"),
      turnId: turnId("compact-turn"),
      willRetry: true,
      error: { message: "retrying" },
    },
  })
  expect(events.some((event) => event.type === "compaction")).toBe(false)
  transport.receive({
    method: "error",
    params: {
      threadId: threadId("thr-1"),
      turnId: turnId("compact-turn"),
      willRetry: false,
      error: { message: "failed" },
    },
  })
  expect(events).toContainEqual({
    type: "compaction",
    phase: "failed",
    threadId: threadId("thr-1"),
    turnId: turnId("compact-turn"),
    error: "failed",
  })
  await gateways.connection.close()
})
