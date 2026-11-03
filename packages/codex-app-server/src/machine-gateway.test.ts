import { expect, test } from "bun:test"
import { createCodexGateways } from "./codex-gateway"
import type { CodexAppServerClient } from "./capabilities/codex-app-server-client"
import type { CodexAdapterEvent } from "./mapping/map-notification"
import type { RuntimeEvent } from "@vimex/workbench"
import { threadId } from "@vimex/conversation"

function fakeClient(overrides: Record<string, unknown> = {}) {
  const listeners = new Set<(event: CodexAdapterEvent) => void>()
  const value = {
    onEvent: (listener: (event: CodexAdapterEvent) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    connect: async () => {
      for (const listener of listeners)
        listener({ type: "connection", status: "connected" })
    },
    close: async () => {
      for (const listener of listeners)
        listener({ type: "connection", status: "disconnected" })
    },
    ...overrides,
  }
  return {
    client: value as unknown as CodexAppServerClient,
    emit: (event: CodexAdapterEvent) => {
      for (const listener of listeners) listener(event)
    },
  }
}

const eventually = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i++) await Bun.sleep(2)
  expect(condition()).toBe(true)
}

test("daemon reconnect rebuilds client and never replays an ambiguous mutation", async () => {
  let sends = 0
  const first = fakeClient({
    startTurn: async () => {
      sends++
      throw new Error("connection lost after send")
    },
  })
  const second = fakeClient()
  let creations = 0
  const gateway = createCodexGateways(
    "/repo",
    "codex",
    () => (creations++ === 0 ? first.client : second.client),
    { machine: { id: "local" }, reconnect: { initialDelayMs: 1 } },
  )
  const events: RuntimeEvent[] = []
  gateway.connection.subscribe((event) => events.push(event))
  await gateway.connection.connect()
  await expect(
    gateway.conversation.startTurn(threadId("a"), "hello", "message-a"),
  ).rejects.toThrow("connection lost")
  first.emit({ type: "connection", status: "disconnected" })
  first.emit({ type: "connection", status: "error", error: "duplicate close" })
  await eventually(() => events.some((event) => event.type === "reconnected"))
  expect(
    events.some(
      (event) =>
        event.type === "disconnected" &&
        event.message === "Reconnecting to Codex app server",
    ),
  ).toBe(true)
  expect(
    events.some(
      (event) =>
        event.type === "disconnected" &&
        event.message === "Restarting Codex app server",
    ),
  ).toBe(false)
  expect(creations).toBe(2)
  expect(sends).toBe(1)
  await gateway.connection.close()
  second.emit({ type: "connection", status: "disconnected" })
  await Bun.sleep(10)
  expect(creations).toBe(2)
})

test("failed reconnect handshakes retry with bounded attempts and shutdown cancels timers", async () => {
  let creations = 0
  const first = fakeClient()
  const gateway = createCodexGateways(
    "/repo",
    "codex",
    () => {
      creations++
      return creations === 1
        ? first.client
        : fakeClient({
            connect: async () => {
              throw new Error("offline")
            },
          }).client
    },
    {
      machine: { id: "devbox", sshHost: "devbox" },
      reconnect: { initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 2 },
    },
  )
  const events: RuntimeEvent[] = []
  gateway.connection.subscribe((event) => events.push(event))
  await gateway.connection.connect()
  first.emit({ type: "connection", status: "disconnected" })
  await eventually(() =>
    events.some(
      (event) =>
        event.type === "notice" &&
        event.message.includes("Unable to reconnect"),
    ),
  )
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        event.message.includes("Unable to reconnect to Codex: Error: offline"),
    ),
  ).toBe(true)
  expect(creations).toBe(3)
  await gateway.connection.close()
})

test("remote search and preview use remote filesystem even when local paths do not exist", async () => {
  const reads: string[] = []
  const mock = fakeClient({
    readHostDirectory: async (path: string) => ({
      entries:
        path === "/remote"
          ? [
              { fileName: "src", isDirectory: true, isFile: false },
              { fileName: "../escape", isDirectory: false, isFile: true },
            ]
          : [{ fileName: "code.ts", isDirectory: false, isFile: true }],
    }),
    getHostMetadata: async () => ({ isSymlink: false }),
    readHostFile: async (path: string) => {
      reads.push(path)
      return { dataBase64: Buffer.from("remote needle\n").toString("base64") }
    },
  })
  const gateway = createCodexGateways("/remote", "codex", () => mock.client, {
    machine: { id: "devbox", sshHost: "devbox" },
  })
  expect(
    await gateway.conversation.searchMentions!("", "file", "/remote"),
  ).toHaveLength(2)
  expect(
    await gateway.conversation.searchMentions!("needle", "grep", "/remote"),
  ).toMatchObject([{ path: "/remote/src/code.ts", detail: "1: remote needle" }])
  expect(
    await gateway.conversation.readMentionPreview!("/remote/src/code.ts"),
  ).toBe("remote needle\n")
  expect(reads).toEqual(["/remote/src/code.ts", "/remote/src/code.ts"])
  await gateway.connection.close()
})

test("remote traversal skips directory symlinks and honors cancellation", async () => {
  let calls = 0
  const mock = fakeClient({
    readHostDirectory: async () => {
      calls++
      return {
        entries: [{ fileName: "loop", isDirectory: true, isFile: false }],
      }
    },
    getHostMetadata: async () => ({ isSymlink: true }),
  })
  const gateway = createCodexGateways("/remote", "codex", () => mock.client, {
    machine: { id: "devbox", sshHost: "devbox" },
  })
  expect(
    await gateway.conversation.searchMentions!("", "file", "/remote"),
  ).toEqual([])
  const controller = new AbortController()
  controller.abort()
  await expect(
    gateway.conversation.searchMentions!(
      "",
      "file",
      "/remote",
      controller.signal,
    ),
  ).rejects.toThrow()
  expect(calls).toBe(1)
  await gateway.connection.close()
})

test("native handoff asks Codex to fork its checkpoint without starting a turn", async () => {
  const calls: unknown[] = []
  const mock = fakeClient({
    readThread: async () => ({
      thread: {
        id: "source",
        path: "/state/source.jsonl",
        cwd: "/repo",
        historyMode: "legacy",
        status: { type: "idle" },
        model: "test",
        modelProvider: "openai",
        cliVersion: "0.166.0",
      },
    }),
    forkThread: async (...args: unknown[]) => {
      calls.push(args)
      return { relation: {}, summary: { id: "destination" } }
    },
  })
  const gateway = createCodexGateways("/repo", "codex", () => mock.client)
  expect(await gateway.nativeHandoff.inspect("source")).toMatchObject({
    historyMode: "legacy",
    rolloutPath: "/state/source.jsonl",
  })
  await gateway.nativeHandoff.forkFromPath(
    "source",
    "/transfer/source.jsonl",
    "/destination",
  )
  expect(calls).toEqual([
    [
      "source",
      undefined,
      {
        path: "/transfer/source.jsonl",
        cwd: "/destination",
        runtimeWorkspaceRoots: ["/destination"],
        deferGoalContinuation: true,
      },
    ],
  ])
  await gateway.connection.close()
})

test("remote image input is uploaded before turn submission and uses the remote path", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const directory = await mkdtemp(join(tmpdir(), "vimex-upload-"))
  const imagePath = join(directory, "picture.png")
  await writeFile(imagePath, "image-bytes")
  const order: string[] = []
  let uploadedPath = ""
  let sent: unknown
  const mock = fakeClient({
    serverInfo: { codexHome: "/remote/.codex" },
    createHostDirectory: async (path: string) => {
      order.push("mkdir")
      expect(path).toBe("/remote/.codex/vimex-attachments")
    },
    writeHostFile: async (path: string, base64: string) => {
      order.push("upload")
      uploadedPath = path
      expect(Buffer.from(base64, "base64").toString()).toBe("image-bytes")
    },
    startTurn: async (_id: string, input: unknown) => {
      order.push("turn")
      sent = input
      return { turn: { id: "t", status: "completed", items: [] } }
    },
  })
  const gateway = createCodexGateways("/remote", "codex", () => mock.client, {
    machine: { id: "devbox", sshHost: "devbox" },
  })
  try {
    await gateway.conversation.startTurn(threadId("a"), "", "message", [
      { type: "image", path: imagePath },
    ])
    expect(order).toEqual(["mkdir", "upload", "turn"])
    expect(uploadedPath).toStartWith("/remote/.codex/vimex-attachments/")
    expect(sent).toEqual([{ type: "localImage", path: uploadedPath }])
  } finally {
    await gateway.connection.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("native handoff requires a verifiable ChatGPT account and workspace identity", async () => {
  let account: unknown = { type: "chatgpt", email: " Person@Example.com " }
  let accountId: string | null = "workspace-a"
  const mock = fakeClient({
    readAccount: async () => ({ account }),
    getAccountRateLimits: async () => ({ accountId }),
  })
  const gateway = createCodexGateways("/repo", "codex", () => mock.client)
  expect(await gateway.nativeHandoff.accountIdentity()).toBe(
    JSON.stringify(["chatgpt", "workspace-a", "person@example.com"]),
  )
  accountId = "workspace-b"
  expect(await gateway.nativeHandoff.accountIdentity()).not.toContain(
    "workspace-a",
  )
  accountId = null
  await expect(gateway.nativeHandoff.accountIdentity()).rejects.toThrow(
    "Unable to verify",
  )
  account = { type: "apiKey" }
  await expect(gateway.nativeHandoff.accountIdentity()).rejects.toThrow(
    "identifiable ChatGPT account",
  )
  await gateway.connection.close()
})

test("gateway connect coalesces handshake and remains idempotent for handoff adoption", async () => {
  let connects = 0
  let finish!: () => void
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  const mock = fakeClient({
    connect: async () => {
      connects++
      await wait
    },
  })
  const gateway = createCodexGateways("/repo", "codex", () => mock.client, {
    machine: { id: "local" },
  })
  const first = gateway.connection.connect()
  const second = gateway.connection.connect()
  finish()
  await Promise.all([first, second])
  await gateway.connection.connect()
  expect(connects).toBe(1)
  await gateway.connection.close()
})

test("initial handshake failure is recoverable without manual restart", async () => {
  let creations = 0
  const gateway = createCodexGateways(
    "/repo",
    "codex",
    () => {
      creations++
      return fakeClient({
        connect: async () => {
          if (creations === 1) throw new Error("offline")
        },
      }).client
    },
    { machine: { id: "local" }, reconnect: { initialDelayMs: 1 } },
  )
  const events: RuntimeEvent[] = []
  gateway.connection.subscribe((event) => events.push(event))
  await expect(gateway.connection.connect()).rejects.toThrow("offline")
  await eventually(() => events.some((event) => event.type === "reconnected"))
  expect(creations).toBe(2)
  await gateway.connection.close()
})

test("disconnect during handshake does not produce false reconnected state", async () => {
  let creations = 0
  let second!: ReturnType<typeof fakeClient>
  const first = fakeClient()
  second = fakeClient({
    connect: async () => {
      second.emit({ type: "connection", status: "disconnected" })
    },
  })
  const third = fakeClient()
  const gateway = createCodexGateways(
    "/repo",
    "codex",
    () => [first, second, third][creations++]!.client,
    { machine: { id: "local" }, reconnect: { initialDelayMs: 1 } },
  )
  const reconnectCreations: number[] = []
  gateway.connection.subscribe((event) => {
    if (event.type === "reconnected") reconnectCreations.push(creations)
  })
  await gateway.connection.connect()
  first.emit({ type: "connection", status: "disconnected" })
  await eventually(() => reconnectCreations.length > 0)
  expect(reconnectCreations).toEqual([3])
  await gateway.connection.close()
})

test("native history verification reads every page and rejects repeated cursors", async () => {
  const cursors: unknown[] = []
  let repeat = false
  const mock = fakeClient({
    listTurns: async (params: { cursor?: string }) => {
      cursors.push(params.cursor)
      return {
        data: [{ id: params.cursor ? "second" : "first", items: [] }],
        nextCursor: !params.cursor || repeat ? "next" : null,
      }
    },
  })
  const gateway = createCodexGateways("/repo", "codex", () => mock.client)
  expect(await gateway.nativeHandoff.historyDigest("source")).toStartWith("2:")
  expect(cursors).toEqual([undefined, "next"])
  repeat = true
  await expect(gateway.nativeHandoff.historyDigest("source")).rejects.toThrow(
    "did not advance",
  )
  await gateway.connection.close()
})

test("native portability checks refuse active sessions and persisted goals before hydration", async () => {
  let status = "active"
  let goal: unknown = undefined
  const mock = fakeClient({
    readThread: async () => ({ thread: { status: { type: status } } }),
    getGoal: async () => goal,
  })
  const gateway = createCodexGateways("/repo", "codex", () => mock.client)
  await expect(gateway.nativeHandoff.assertPortable("source")).rejects.toThrow(
    "active",
  )
  status = "idle"
  goal = { status: "complete" }
  await expect(gateway.nativeHandoff.assertPortable("source")).rejects.toThrow(
    "persisted goal",
  )
  goal = undefined
  await gateway.nativeHandoff.assertPortable("source")
  await gateway.connection.close()
})

test("unloaded native IDs are resolved through normal and archived native listings before declaring absence", async () => {
  const requests: Array<{ archived?: boolean; cursor?: string }> = []
  const mock = fakeClient({
    readThread: async () => {
      throw new Error("thread/read: thread not loaded")
    },
    listThreads: async (params: { archived?: boolean; cursor?: string }) => {
      requests.push(params)
      const data = params.archived
        ? [
            {
              id: "saved",
              path: "/archive/saved.jsonl",
              status: { type: "notLoaded" },
            },
          ]
        : []
      return { raw: { data }, nextCursor: null }
    },
  })
  const gateway = createCodexGateways("/repo", "codex", () => mock.client)
  expect(await gateway.nativeHandoff.locate("saved")).toBe(
    "/archive/saved.jsonl",
  )
  expect(requests.map((r) => r.archived)).toEqual([false, true])
  expect(await gateway.nativeHandoff.locate("missing")).toBeUndefined()
  await gateway.connection.close()
})

test("native hydration uses a disposable ephemeral fork without rewriting source settings", async () => {
  const calls: unknown[] = []
  const mock = fakeClient({
    forkThread: async (...args: unknown[]) => {
      calls.push(args)
      return { summary: { id: "temporary" } }
    },
    unsubscribeThread: async (id: string) => {
      calls.push(["unsubscribe", id])
    },
  })
  const gateway = createCodexGateways("/repo", "codex", () => mock.client)
  await gateway.nativeHandoff.hydrateHistory("source", "/destination")
  expect(calls).toEqual([
    [
      "source",
      undefined,
      {
        cwd: "/destination",
        runtimeWorkspaceRoots: ["/destination"],
        ephemeral: true,
        excludeTurns: true,
      },
    ],
    ["unsubscribe", "temporary"],
  ])
  await gateway.connection.close()
})

test("read-only ancestry checks do not query or reactivate an archived ancestor goal", async () => {
  let goalReads = 0
  const mock = fakeClient({
    readThread: async () => ({ thread: { status: { type: "notLoaded" } } }),
    getGoal: async () => {
      goalReads++
      throw new Error("thread not found")
    },
  })
  const gateway = createCodexGateways("/repo", "codex", () => mock.client)
  await gateway.nativeHandoff.assertPortable("archived-ancestor", false)
  expect(goalReads).toBe(0)
  await expect(
    gateway.nativeHandoff.assertPortable("selected-thread"),
  ).rejects.toThrow("thread not found")
  expect(goalReads).toBe(1)
  await gateway.connection.close()
})
