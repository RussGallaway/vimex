import { test, expect } from "bun:test"
import {
  incrementalConversationEventDamage,
  VimexController,
} from "@vimex/workbench"
import type {
  RuntimeEvent,
  RuntimeConnection,
  ModelCatalog,
  PreferenceStore,
  ConversationIngressScheduler,
  WorkbenchLifecycleSnapshot,
  WorkbenchState,
} from "@vimex/workbench"
import type { SessionSnapshot, ConversationGateway } from "@vimex/conversation"
import type { ApprovalGateway } from "@vimex/approvals"
import { resolve } from "node:path"
type TestRuntime = ConversationGateway &
  ApprovalGateway &
  RuntimeConnection &
  ModelCatalog
import {
  threadId,
  turnId,
  itemId,
  type ConversationEvent,
  type ThreadSummary,
} from "@vimex/conversation"
import { createConversation, reduceConversation } from "@vimex/conversation"
import type { LocalState } from "@vimex/workbench"
import { pointIsMaterialized, selectedText } from "@vimex/transcript"

const a = threadId("a"),
  b = threadId("b")
const summary = (id = a): ThreadSummary => ({
  id,
  title: id,
  cwd: "/tmp",
  model: "test",
  reasoningEffort: "high",
  status: "idle",
})
function harness(
  options: {
    localState?: LocalState
    onState?: (state: WorkbenchState) => void
    onLocalState?: (state: LocalState) => void
    onLifecycle?: (state: WorkbenchLifecycleSnapshot) => void
    preferences?: PreferenceStore
    conversationIngressScheduler?: ConversationIngressScheduler
  } = {},
) {
  let listener: (event: RuntimeEvent) => void = () => {}
  const starts: string[] = []
  const copied: string[] = []
  const opened: string[] = []
  const retired: string[] = []
  let turnCounter = 0
  const backend: TestRuntime = {
    restart: async () => {},
    connect: async () => {},
    subscribe: (fn) => {
      listener = fn
      return () => {
        listener = () => {}
      }
    },
    listThreads: async () => [summary(a), summary(b)],
    startThread: async () => ({ summary: summary(), events: [] }),
    resumeThread: async (id) => ({ summary: summary(id), events: [] }),
    forkThread: async () => ({
      summary: summary(threadId("fork")),
      events: [],
    }),
    forkSideThread: async () => ({
      summary: summary(threadId("side")),
      events: [],
    }),
    retireThread: async (id) => {
      retired.push(id)
    },
    startTurn: async (id, text) => {
      starts.push(text)
      return [
        {
          type: "turn.started",
          threadId: id,
          turnId: turnId(`turn-${++turnCounter}`),
        },
      ]
    },
    listModels: async () => [
      { id: "test", label: "Test", efforts: ["low", "high"] },
    ],
    updateSettings: async () => {},
    steerTurn: async () => {},
    interruptTurn: async () => {},
    resolveApproval: async () => {},
    renameThread: async () => {},
    close: async () => {},
  }
  const controller = new VimexController({
    conversation: backend,
    approvals: backend,
    connection: backend,
    models: backend,
    resolveDirectory: resolve,
    localState: options.localState,
    onState: options.onState,
    onLocalState: options.onLocalState,
    onLifecycle: options.onLifecycle,
    preferences: options.preferences,
    conversationIngressScheduler: options.conversationIngressScheduler,
    clipboard: {
      writeText: async (text) => {
        copied.push(text)
      },
    },
    openUrl: async (url) => {
      opened.push(url)
    },
    quit() {},
  })
  return {
    controller,
    backend,
    starts,
    copied,
    opened,
    retired,
    emit: (event: RuntimeEvent) => listener(event),
  }
}

function manualIngressScheduler() {
  const tasks: Array<{ task: () => void; cancelled: boolean }> = []
  const scheduler: ConversationIngressScheduler = {
    schedule(task) {
      const entry = { task, cancelled: false }
      tasks.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
  }
  return {
    scheduler,
    tasks,
    runNext() {
      const entry = tasks.shift()
      if (entry && !entry.cancelled) entry.task()
    },
  }
}

test("incremental completion damage requires exact pre-event item chronology", () => {
  const thread = threadId("damage"),
    turn = turnId("damage-turn"),
    id = itemId("damage-item")
  const running = {
    id,
    turnId: turn,
    kind: "assistant" as const,
    markdown: "partial",
    status: "running" as const,
  }
  let conversation = reduceConversation(createConversation(thread), {
    type: "turn.started",
    threadId: thread,
    turnId: turn,
  })
  conversation = reduceConversation(conversation, {
    type: "item.started",
    threadId: thread,
    item: running,
  })
  const completion = {
    type: "item.completed" as const,
    threadId: thread,
    item: { ...running, markdown: "complete", status: "complete" as const },
  }

  expect(incrementalConversationEventDamage(conversation, completion)).toEqual({
    kind: "blocks",
    itemIds: [id],
  })
  expect(
    incrementalConversationEventDamage(conversation, {
      type: "item.delta",
      threadId: thread,
      itemId: id,
      delta: " more",
    }),
  ).toEqual({ kind: "blocks", itemIds: [id] })
  expect(
    incrementalConversationEventDamage(
      {
        ...conversation,
        turns: {
          ...conversation.turns,
          [turn]: { ...conversation.turns[turn]!, itemIds: [] },
        },
      },
      completion,
    ),
  ).toBeUndefined()
  expect(
    incrementalConversationEventDamage(
      { ...conversation, turns: {} },
      completion,
    ),
  ).toBeUndefined()
  expect(
    incrementalConversationEventDamage(
      {
        ...conversation,
        items: {
          ...conversation.items,
          [id]: { ...running, turnId: turnId("other") },
        },
      },
      completion,
    ),
  ).toBeUndefined()
})

test("structural damage accepts only a new empty tail turn and its first semantic tail item", () => {
  const thread = threadId("structural-damage"),
    firstTurn = turnId("first-turn"),
    nextTurn = turnId("next-turn")
  const first = itemId("first-item"),
    next = itemId("next-item")
  let conversation = reduceConversation(createConversation(thread), {
    type: "turn.started",
    threadId: thread,
    turnId: firstTurn,
  })
  conversation = reduceConversation(conversation, {
    type: "item.started",
    threadId: thread,
    item: {
      id: first,
      turnId: firstTurn,
      kind: "assistant",
      markdown: "first",
      status: "running",
    },
  })

  expect(
    incrementalConversationEventDamage(conversation, {
      type: "turn.started",
      threadId: thread,
      turnId: nextTurn,
    }),
  ).toEqual({ kind: "blocks", itemIds: [] })
  expect(
    incrementalConversationEventDamage(conversation, {
      type: "turn.started",
      threadId: thread,
      turnId: firstTurn,
    }),
  ).toBeUndefined()

  const withTailTurn = reduceConversation(conversation, {
    type: "turn.started",
    threadId: thread,
    turnId: nextTurn,
  })
  const nextItem = {
    id: next,
    turnId: nextTurn,
    kind: "assistant" as const,
    markdown: "next",
    status: "running" as const,
  }
  expect(
    incrementalConversationEventDamage(withTailTurn, {
      type: "item.started",
      threadId: thread,
      item: nextItem,
    }),
  ).toEqual({ kind: "blocks", itemIds: [next] })
  expect(
    incrementalConversationEventDamage(withTailTurn, {
      type: "item.started",
      threadId: thread,
      item: { ...nextItem, id: first },
    }),
  ).toBeUndefined()
  expect(
    incrementalConversationEventDamage(withTailTurn, {
      type: "item.started",
      threadId: thread,
      item: { ...nextItem, id: itemId("non-tail"), turnId: firstTurn },
    }),
  ).toBeUndefined()

  expect(
    incrementalConversationEventDamage(withTailTurn, {
      type: "turn.completed",
      threadId: thread,
      turnId: nextTurn,
      outcome: "failed",
    }),
  ).toEqual({ kind: "blocks", itemIds: [] })
  const withTailItem = reduceConversation(withTailTurn, {
    type: "item.started",
    threadId: thread,
    item: nextItem,
  })
  expect(
    incrementalConversationEventDamage(withTailItem, {
      type: "turn.completed",
      threadId: thread,
      turnId: nextTurn,
      outcome: "complete",
      durationMs: 0,
    }),
  ).toEqual({ kind: "blocks", itemIds: [] })
  const withSecondItem = reduceConversation(withTailItem, {
    type: "item.started",
    threadId: thread,
    item: { ...nextItem, id: itemId("second-tail-item") },
  })
  expect(
    incrementalConversationEventDamage(withSecondItem, {
      type: "turn.completed",
      threadId: thread,
      turnId: nextTurn,
      outcome: "complete",
    }),
  ).toBeUndefined()
  expect(
    incrementalConversationEventDamage(withTailTurn, {
      type: "turn.completed",
      threadId: thread,
      turnId: firstTurn,
      outcome: "complete",
    }),
  ).toBeUndefined()
})

test("direct structural tail admission advances an empty turn without rematerializing and appends one block", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const seed = itemId("structural-direct-seed")
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: seed,
        turnId: turnId("structural-direct-seed-turn"),
        kind: "assistant",
        markdown: "seed",
        status: "complete",
      },
    },
  })
  const runtime = h.controller.transcriptRuntime("main")!
  const before = runtime.getSnapshot()
  const nextTurn = turnId("structural-direct-next-turn")
  const nextItem = itemId("structural-direct-next-item")
  let publications = 0
  runtime.subscribe(() => {
    publications++
  })

  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: nextTurn },
  })
  const emptyTurn = runtime.getSnapshot()
  expect(emptyTurn.displayedCanonicalRevision).toBe(
    before.displayedCanonicalRevision + 1,
  )
  expect(emptyTurn.blocks).toBe(before.blocks)
  expect(emptyTurn.window).toBe(before.window)
  expect(emptyTurn.geometry).toBe(before.geometry)
  expect(emptyTurn.transcript).toBe(before.transcript)

  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: nextItem,
        turnId: nextTurn,
        kind: "assistant",
        markdown: "tail",
        status: "running",
      },
    },
  })
  const admitted = runtime.getSnapshot()
  expect(publications).toBe(2)
  expect(admitted.displayedCanonicalRevision).toBe(
    emptyTurn.displayedCanonicalRevision + 1,
  )
  expect(admitted.blocks).toHaveLength(before.blocks.length + 1)
  expect(admitted.blocks[0]).toBe(before.blocks[0])
  expect(admitted.blocks.at(-1)?.key).toMatchObject({
    kind: "item",
    itemId: nextItem,
  })
  expect(admitted.window.blocks.length).toBeLessThanOrEqual(72)
  expect(admitted.transcript.order.at(-1)).toBe(nextItem)
  await h.controller.close()
})

test("initializes session catalog without selecting background sessions; restores drafts on round-trip", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("draft A", 7)
  h.emit({ type: "summary", summary: summary(b) })
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  h.controller.openThread(b)
  await h.controller.settle()
  h.controller.changeDraft("draft B", 7)
  h.controller.openThread(a)
  await h.controller.settle()
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe(
    "draft A",
  )
  expect(h.controller.getSnapshot().workspaces[b]?.composer.text).toBe(
    "draft B",
  )
  await h.controller.close()
})

test("queued next turn drains once when active turn completes", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("first", 5)
  h.controller.submit("next-turn")
  h.controller.changeDraft("second", 6)
  h.controller.submit("next-turn")
  await h.controller.settle()
  expect(h.starts).toEqual(["first"])
  const completed: ConversationEvent = {
    type: "turn.completed",
    threadId: a,
    turnId: turnId("turn-1"),
    outcome: "complete",
  }
  h.emit({ type: "conversation", event: completed })
  h.emit({ type: "conversation", event: completed })
  await h.controller.settle()
  expect(h.starts).toEqual(["first", "second"])
})

test("backend output leaves composer focus and semantic reading anchor intact", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const turn = turnId("turn"),
    id = itemId("message")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id,
        turnId: turn,
        kind: "assistant",
        markdown: "Reading here",
        status: "running",
      },
    },
  })
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: id, graphemeOffset: 3 },
    preferredScreenRow: 4,
    extend: false,
  })
  h.controller.dispatchInteraction({ type: "mode.insert" })
  h.controller.changeDraft("reply", 5)
  const anchor = h.controller.getSnapshot().workspaces[a]?.transcript.viewport
  h.emit({
    type: "conversation",
    event: {
      type: "item.delta",
      threadId: a,
      itemId: id,
      delta: " while output grows",
    },
  })
  await h.controller.settle()
  expect(
    h.controller.getSnapshot().workspaces[a]?.conversation.items[id],
  ).toMatchObject({ markdown: "Reading here while output grows" })
  expect(h.controller.getSnapshot().workspaces[a]?.transcript.viewport).toEqual(
    anchor,
  )
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe("reply")
  expect(h.controller.getSnapshot().workspaces[a]?.interaction.mode).toBe(
    "insert",
  )
})

test("streaming ingress bounds canonical settlements by cadence", async () => {
  const manual = manualIngressScheduler()
  let updates = 0
  const h = harness({
    conversationIngressScheduler: manual.scheduler,
    onState: () => {
      updates++
    },
  })
  await h.controller.initialize("/tmp")
  const turn = turnId("settled"),
    id = itemId("answer")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id,
        turnId: turn,
        kind: "assistant",
        markdown: "",
        status: "running",
      },
    },
  })
  updates = 0
  for (let index = 0; index < 100; index++)
    h.emit({
      type: "conversation",
      event: {
        type: "item.delta",
        threadId: a,
        itemId: id,
        delta: String(index % 10),
      },
    })
  expect(
    h.controller.getSnapshot().workspaces[a]?.conversation.items[id],
  ).toMatchObject({ markdown: "" })
  expect(manual.tasks).toHaveLength(1)
  expect(updates).toBe(0)
  manual.runNext()
  expect(
    h.controller.getSnapshot().workspaces[a]?.conversation.items[id],
  ).toMatchObject({ markdown: "0123456789".repeat(10) })
  expect(updates).toBe(1)
  await h.controller.close()
})

test("token cadence with an unchanged local view does not wake local-view or lifecycle observers", async () => {
  const manual = manualIngressScheduler()
  const local: LocalState[] = []
  const lifecycle: WorkbenchLifecycleSnapshot[] = []
  const h = harness({
    conversationIngressScheduler: manual.scheduler,
    onLocalState: (state) => {
      local.push(state)
    },
    onLifecycle: (state) => {
      lifecycle.push(state)
    },
  })
  await h.controller.initialize("/tmp")
  const turn = turnId("observed"),
    id = itemId("observed-answer")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id,
        turnId: turn,
        kind: "assistant",
        markdown: "",
        status: "running",
      },
    },
  })
  local.length = 0
  lifecycle.length = 0

  for (let index = 0; index < 100; index++)
    h.emit({
      type: "conversation",
      event: { type: "item.delta", threadId: a, itemId: id, delta: "x" },
    })
  manual.runNext()
  h.emit({
    type: "metadata",
    threadId: a,
    patch: { contextUsed: 500, contextLimit: 10_000 },
  })

  expect(local).toHaveLength(0)
  expect(lifecycle).toHaveLength(0)

  h.controller.changeDraft("persist me", 10)
  expect(local).toHaveLength(1)
  expect(local[0]?.threads[a]?.draft).toBe("persist me")
  h.emit({ type: "metadata", threadId: a, patch: { status: "blocked" } })
  expect(lifecycle).toHaveLength(1)
  expect(lifecycle[0]).toMatchObject({
    summary: { id: a, status: "blocked" },
    pendingApprovals: 0,
  })
  await h.controller.close()
})

test("Markdown re-projection publishes one changed local anchor without waking lifecycle", async () => {
  const manual = manualIngressScheduler()
  const local: LocalState[] = []
  const lifecycle: WorkbenchLifecycleSnapshot[] = []
  const h = harness({
    conversationIngressScheduler: manual.scheduler,
    onLocalState: (state) => {
      local.push(state)
    },
    onLifecycle: (state) => {
      lifecycle.push(state)
    },
  })
  await h.controller.initialize("/tmp")
  const turn = turnId("reproject"),
    id = itemId("reproject")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id,
        turnId: turn,
        kind: "assistant",
        markdown: "prefix **bold",
        status: "running",
      },
    },
  })
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: id, graphemeOffset: 11 },
    preferredScreenRow: 4,
    extend: false,
  })
  local.length = 0
  lifecycle.length = 0

  h.emit({
    type: "conversation",
    event: {
      type: "item.delta",
      threadId: a,
      itemId: id,
      delta: "** and more",
    },
  })
  manual.runNext()

  expect(local).toHaveLength(1)
  expect(local[0]?.threads[a]?.cursor).toEqual({
    itemId: id,
    graphemeOffset: 9,
  })
  expect(lifecycle).toHaveLength(0)
  await h.controller.close()
})

test("lifecycle stays blocked while an approval is resolving", async () => {
  const lifecycle: WorkbenchLifecycleSnapshot[] = []
  const h = harness({
    onLifecycle: (state) => {
      lifecycle.push(state)
    },
  })
  await h.controller.initialize("/tmp")
  lifecycle.length = 0
  h.emit({
    type: "approval",
    approval: {
      id: "approval",
      threadId: a,
      kind: "command",
      title: "Run",
      detail: "command",
      choices: [{ id: "yes", label: "Yes" }],
      status: "pending",
    },
  })
  expect(lifecycle.at(-1)?.pendingApprovals).toBe(1)
  lifecycle.length = 0
  h.controller.resolveApproval("approval", "yes")
  expect(h.controller.getSnapshot().approvals.byId.approval?.status).toBe(
    "resolving",
  )
  expect(lifecycle).toHaveLength(0)
  await h.controller.settle()
  expect(lifecycle.at(-1)?.pendingApprovals).toBe(0)
  await h.controller.close()
})

test("a faulty UI subscriber cannot suppress local-view publication", async () => {
  const local: LocalState[] = []
  const h = harness({
    onLocalState: (state) => {
      local.push(state)
    },
  })
  await h.controller.initialize("/tmp")
  let healthyCalls = 0
  h.controller.subscribe(() => {
    throw new Error("broken UI")
  })
  h.controller.subscribe(() => {
    healthyCalls++
  })
  expect(() => h.controller.changeDraft("still committed", 15)).not.toThrow()
  expect(healthyCalls).toBe(1)
  expect(local.at(-1)?.threads[a]?.draft).toBe("still committed")
  await h.controller.close()
})

test("one cadence publishes interleaved item deltas as one canonical settlement", async () => {
  const manual = manualIngressScheduler()
  let updates = 0
  const h = harness({
    conversationIngressScheduler: manual.scheduler,
    onState: () => {
      updates++
    },
  })
  await h.controller.initialize("/tmp")
  const turn = turnId("interleaved"),
    first = itemId("first"),
    second = itemId("second")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: first,
        turnId: turn,
        kind: "assistant",
        markdown: "",
        status: "running",
      },
    },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: second,
        turnId: turn,
        kind: "reasoning",
        markdown: "",
        status: "running",
      },
    },
  })
  updates = 0
  for (let index = 0; index < 100; index++) {
    const id = index % 2 ? second : first
    h.emit({
      type: "conversation",
      event: {
        type: "item.delta",
        threadId: a,
        itemId: id,
        delta: String(index % 10),
      },
    })
  }
  expect(updates).toBe(0)
  manual.runNext()
  expect(updates).toBe(1)
  expect(
    h.controller.getSnapshot().workspaces[a]?.conversation.items[first],
  ).toMatchObject({ markdown: "02468".repeat(10) })
  expect(
    h.controller.getSnapshot().workspaces[a]?.conversation.items[second],
  ).toMatchObject({ markdown: "13579".repeat(10) })
  await h.controller.close()
})

test("scheduled ingress yields to transcript navigation between bounded batches", async () => {
  const manual = manualIngressScheduler()
  const h = harness({ conversationIngressScheduler: manual.scheduler })
  await h.controller.initialize("/tmp")
  const turn = turnId("bounded-backlog")
  const ids = Array.from({ length: 70 }, (_, index) =>
    itemId(`bounded-${index}`),
  )
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  for (const id of ids)
    h.emit({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: a,
        item: {
          id,
          turnId: turn,
          kind: "assistant",
          markdown: "",
          status: "running",
        },
      },
    })
  for (const id of ids)
    h.emit({
      type: "conversation",
      event: { type: "item.delta", threadId: a, itemId: id, delta: id },
    })
  expect(manual.tasks).toHaveLength(1)

  manual.runNext()
  expect(
    h.controller.getSnapshot().workspaces[a]?.conversation.items[ids[63]!],
  ).toMatchObject({ markdown: ids[63] })
  expect(
    h.controller.getSnapshot().workspaces[a]?.conversation.items[ids[64]!],
  ).toMatchObject({ markdown: "" })
  expect(manual.tasks).toHaveLength(1)

  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: ids[0]!, graphemeOffset: 0 },
    preferredScreenRow: 2,
    extend: false,
  })
  expect(
    h.controller.getSnapshot().workspaces[a]?.transcript.cursor?.itemId,
  ).toBe(ids[0])
  const viewport = h.controller.getSnapshot().workspaces[a]?.transcript.viewport
  manual.runNext()
  expect(
    h.controller.getSnapshot().workspaces[a]?.conversation.items[ids[69]!],
  ).toMatchObject({ markdown: ids[69] })
  expect(
    h.controller.getSnapshot().workspaces[a]?.transcript.cursor?.itemId,
  ).toBe(ids[0])
  expect(h.controller.getSnapshot().workspaces[a]?.transcript.viewport).toEqual(
    viewport,
  )
  await h.controller.close()
})

test("controller-owned transcript runtime freezes detached content and follows latest once", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const runtime = h.controller.transcriptRuntime("main")!
  const turn = turnId("runtime"),
    id = itemId("runtime-answer")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id,
        turnId: turn,
        kind: "assistant",
        markdown: "visible",
        status: "running",
      },
    },
  })
  expect(runtime.getSnapshot().damage.kind).toBe("blocks")
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: id, graphemeOffset: 2 },
    preferredScreenRow: 3,
    extend: false,
  })
  const pinned = runtime.getSnapshot()
  h.emit({
    type: "conversation",
    event: {
      type: "item.delta",
      threadId: a,
      itemId: id,
      delta: " hidden tail",
    },
  })
  await h.controller.settle()
  expect(runtime.getSnapshot()).toBe(pinned)
  expect(runtime.getSnapshot().transcript.projectionById[id]?.source).toBe(
    "visible",
  )
  expect(
    h.controller.getSnapshot().workspaces[a]?.transcript.unseenEntries,
  ).toBe(1)
  h.controller.transcript({ type: "viewport.tail" })
  const followed = runtime.getSnapshot()
  expect(followed).not.toBe(pinned)
  expect(followed.transcript.projectionById[id]?.source).toBe(
    "visible hidden tail",
  )
  expect(followed.displayedCanonicalRevision).toBe(
    h.controller.getSnapshot().workspaces[a]!.canonicalRevision,
  )
  h.controller.transcript({ type: "viewport.tail" })
  expect(runtime.getSnapshot()).toBe(followed)
  await h.controller.close()
  expect(h.controller.transcriptRuntime("main")).toBeUndefined()
})

test("detached unseen membership publishes status once per item and resets for the next detach epoch", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const runtime = h.controller.transcriptRuntime("main")!
  const seed = itemId("unseen-seed"),
    first = itemId("unseen-first"),
    second = itemId("unseen-second")
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: seed,
        turnId: turnId("unseen-seed-turn"),
        kind: "assistant",
        markdown: "seed",
        status: "complete",
      },
    },
  })
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: seed, graphemeOffset: 0 },
    preferredScreenRow: 3,
    extend: false,
  })
  const pinned = runtime.getSnapshot()
  let presentationPublications = 0,
    runtimePublications = 0
  h.controller.subscribePresentation("main", () => {
    presentationPublications++
  })
  runtime.subscribe(() => {
    runtimePublications++
  })

  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: first,
        turnId: turnId("unseen-first-turn"),
        kind: "assistant",
        markdown: "first",
        status: "running",
      },
    },
  })
  expect(
    h.controller.getSnapshot().workspaces[a]!.transcript.unseenEntries,
  ).toBe(1)
  expect(presentationPublications).toBe(1)
  expect(runtimePublications).toBe(0)
  expect(runtime.getSnapshot()).toBe(pinned)

  presentationPublications = 0
  h.emit({
    type: "conversation",
    event: {
      type: "item.delta",
      threadId: a,
      itemId: first,
      delta: " repeated",
    },
  })
  await h.controller.settle()
  expect(
    h.controller.getSnapshot().workspaces[a]!.transcript.unseenEntries,
  ).toBe(1)
  expect(presentationPublications).toBe(0)
  expect(runtimePublications).toBe(0)
  expect(runtime.getSnapshot()).toBe(pinned)

  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: second,
        turnId: turnId("unseen-second-turn"),
        kind: "assistant",
        markdown: "second",
        status: "running",
      },
    },
  })
  expect(
    h.controller.getSnapshot().workspaces[a]!.transcript.unseenEntries,
  ).toBe(2)
  expect([
    ...h.controller.getSnapshot().workspaces[a]!.transcript.unseenItemIds,
  ]).toEqual([first, second])
  expect(presentationPublications).toBe(1)
  expect(runtimePublications).toBe(0)
  expect(runtime.getSnapshot()).toBe(pinned)

  presentationPublications = runtimePublications = 0
  h.controller.transcript({ type: "viewport.tail" })
  expect(
    h.controller.getSnapshot().workspaces[a]!.transcript.unseenEntries,
  ).toBe(0)
  expect(
    h.controller.getSnapshot().workspaces[a]!.transcript.unseenItemIds,
  ).toEqual([])
  expect(presentationPublications).toBe(1)
  expect(runtimePublications).toBe(1)

  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: seed, graphemeOffset: 0 },
    preferredScreenRow: 3,
    extend: false,
  })
  const secondPinned = runtime.getSnapshot()
  presentationPublications = runtimePublications = 0
  h.emit({
    type: "conversation",
    event: {
      type: "item.delta",
      threadId: a,
      itemId: first,
      delta: " next epoch",
    },
  })
  await h.controller.settle()
  expect(
    h.controller.getSnapshot().workspaces[a]!.transcript.unseenEntries,
  ).toBe(1)
  expect([
    ...h.controller.getSnapshot().workspaces[a]!.transcript.unseenItemIds,
  ]).toEqual([first])
  expect(presentationPublications).toBe(1)
  expect(runtimePublications).toBe(0)
  expect(runtime.getSnapshot()).toBe(secondPinned)
  await h.controller.close()
})

test("Workbench owns independent bounded main and side transcript runtime lifetimes", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  for (let index = 0; index < 100; index++)
    h.emit({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: a,
        item: {
          id: itemId(`main-${index}`),
          turnId: turnId(`main-turn-${index}`),
          kind: "assistant",
          markdown: `main ${index}`,
          status: "complete",
        },
      },
    })
  await h.controller.settle()
  const main = h.controller.transcriptRuntime("main")!
  expect(main.getSnapshot().window.blocks.length).toBe(48)

  h.controller.sideChat("open")
  await h.controller.settle()
  for (let index = 0; index < 100; index++)
    h.emit({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: threadId("side"),
        item: {
          id: itemId(`side-${index}`),
          turnId: turnId(`side-turn-${index}`),
          kind: "assistant",
          markdown: `side ${index}`,
          status: "complete",
        },
      },
    })
  await h.controller.settle()
  const side = h.controller.transcriptRuntime("side")!
  expect(side).not.toBe(main)
  expect(side.getSnapshot().window.blocks.length).toBe(48)

  let mainPublications = 0,
    sidePublications = 0
  const stopMain = main.subscribe(() => {
    mainPublications++
  })
  const stopSide = side.subscribe(() => {
    sidePublications++
  })
  const sideFrame = side.getSnapshot()
  main.setWindowViewport(4, 4)
  expect(main.getSnapshot().window.blocks.length).toBe(8)
  expect(side.getSnapshot()).toBe(sideFrame)
  expect([mainPublications, sidePublications]).toEqual([1, 0])

  const mainFrame = main.getSnapshot()
  side.setWindowViewport(6, 6)
  expect(side.getSnapshot().window.blocks.length).toBe(12)
  expect(main.getSnapshot()).toBe(mainFrame)
  expect([mainPublications, sidePublications]).toEqual([1, 1])

  mainPublications = 0
  sidePublications = 0
  const sideTarget = { itemId: itemId("side-5"), graphemeOffset: 0 }
  h.controller.transcript({
    type: "cursor.move",
    target: sideTarget,
    preferredScreenRow: 2,
    extend: false,
  })
  expect([mainPublications, sidePublications]).toEqual([0, 1])
  expect(
    pointIsMaterialized(side.getSnapshot().window.blocks, sideTarget),
  ).toBe(true)
  expect(main.getSnapshot()).toBe(mainFrame)
  stopMain()
  stopSide()

  h.controller.sideChat("quit")
  await h.controller.settle()
  expect(h.retired).toEqual(["side"])
  expect(h.controller.transcriptRuntime("side")).toBeUndefined()
  expect(h.controller.transcriptRuntime("main")).toBe(main)
  await h.controller.close()
})

test("reentrant runtime listeners cannot overwrite a newer side presentation", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const mainTurn = turnId("reentrant-main-turn"),
    mainItem = itemId("reentrant-main-item")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: mainTurn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: mainItem,
        turnId: mainTurn,
        kind: "assistant",
        markdown: "main",
        status: "running",
      },
    },
  })
  await h.controller.settle()
  // Preserve Map insertion order main -> side: the regression requires the
  // main publication to reenter before the older pass reaches side.
  const main = h.controller.transcriptRuntime("main")!

  h.controller.sideChat("open")
  await h.controller.settle()
  const sideThread = threadId("side"),
    sideTurn = turnId("reentrant-side-turn"),
    sideItem = itemId("reentrant-side-item")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: sideThread, turnId: sideTurn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: sideThread,
      item: {
        id: sideItem,
        turnId: sideTurn,
        kind: "assistant",
        markdown: "side",
        status: "running",
      },
    },
  })
  await h.controller.settle()
  const side = h.controller.transcriptRuntime("side")!
  const target = { itemId: sideItem, graphemeOffset: 0 }
  let sidePublications = 0
  let reentered = false
  const stopSide = side.subscribe(() => {
    sidePublications++
  })
  const stopMain = main.subscribe(() => {
    if (reentered) return
    reentered = true
    h.controller.transcript({
      type: "cursor.move",
      target,
      preferredScreenRow: 2,
      extend: false,
    })
  })

  h.emit({
    type: "conversation",
    event: {
      type: "item.delta",
      threadId: a,
      itemId: mainItem,
      delta: " updated",
    },
  })
  await h.controller.settle()

  const authority =
    h.controller.getSnapshot().workspaces[sideThread]!.transcript
  const frame = side.getSnapshot()
  expect(reentered).toBe(true)
  expect(sidePublications).toBe(1)
  expect(authority.viewport).toEqual({
    kind: "point",
    point: target,
    preferredScreenRow: 2,
  })
  expect(frame.transcript.viewport).toEqual(authority.viewport)
  expect(frame.mode).toBe("detached")
  expect(pointIsMaterialized(frame.window.blocks, target)).toBe(true)
  expect(main.getSnapshot().transcript.projectionById[mainItem]?.source).toBe(
    "main updated",
  )

  stopMain()
  stopSide()
  await h.controller.close()
})

test("controller reasoning ingress is canonical but publishes no transcript frames while following or detached", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const runtime = h.controller.transcriptRuntime("main")!
  const turn = turnId("reasoning-runtime"),
    visible = itemId("visible-answer")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: visible,
        turnId: turn,
        kind: "assistant",
        markdown: "visible",
        status: "complete",
      },
    },
  })

  let notifications = 0
  const unsubscribe = runtime.subscribe(() => {
    notifications++
  })
  const follow = runtime.getSnapshot()
  const first = itemId("follow-reasoning")
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: first,
        turnId: turn,
        kind: "reasoning",
        markdown: "private",
        status: "running",
      },
    },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.delta",
      threadId: a,
      itemId: first,
      delta: " thought",
    },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.completed",
      threadId: a,
      item: {
        id: first,
        turnId: turn,
        kind: "reasoning",
        markdown: "private thought",
        status: "complete",
      },
    },
  })
  await h.controller.settle()
  expect(runtime.getSnapshot()).toBe(follow)
  expect(notifications).toBe(0)

  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: visible, graphemeOffset: 1 },
    preferredScreenRow: 2,
    extend: false,
  })
  const detached = runtime.getSnapshot()
  notifications = 0
  const second = itemId("detached-reasoning")
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: second,
        turnId: turn,
        kind: "reasoning",
        markdown: "hidden",
        status: "running",
      },
    },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.delta",
      threadId: a,
      itemId: second,
      delta: " detail",
    },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.completed",
      threadId: a,
      item: {
        id: second,
        turnId: turn,
        kind: "reasoning",
        markdown: "hidden detail",
        status: "complete",
      },
    },
  })
  await h.controller.settle()
  const workspace = h.controller.getSnapshot().workspaces[a]!
  expect(runtime.getSnapshot()).toBe(detached)
  expect(notifications).toBe(0)
  expect(workspace.conversation.items[first]).toBeDefined()
  expect(workspace.conversation.items[second]).toBeDefined()
  expect(workspace.transcript.order).toEqual([visible])
  unsubscribe()
  await h.controller.close()
})

test("detached copy, reference, and URL reads use the displayed presentation until follow", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const runtime = h.controller.transcriptRuntime("main")!
  const turn = turnId("displayed-reads"),
    id = itemId("displayed-answer")
  const visible =
    "visible [shown](https://shown.test) and [second](https://second.test)"
  const latest = `${visible} hidden [secret](https://secret.test)`
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id,
        turnId: turn,
        kind: "assistant",
        markdown: visible,
        status: "running",
      },
    },
  })
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: id, graphemeOffset: 0 },
    preferredScreenRow: 2,
    extend: false,
  })
  h.controller.transcript({ type: "selection.begin", shape: "character" })
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: id, graphemeOffset: 6 },
    preferredScreenRow: 2,
    extend: true,
  })
  const pinnedRevision = runtime.getSnapshot().displayedCanonicalRevision

  h.emit({
    type: "conversation",
    event: {
      type: "item.completed",
      threadId: a,
      item: {
        id,
        turnId: turn,
        kind: "assistant",
        markdown: latest,
        status: "complete",
      },
    },
  })
  expect(
    h.controller.getSnapshot().workspaces[a]?.transcript.projectionById[id]
      ?.source,
  ).toBe(latest)
  expect(runtime.getSnapshot().transcript.projectionById[id]?.source).toBe(
    visible,
  )

  h.controller.transcript({
    type: "copy",
    format: "plain",
    presentationId: "main",
  })
  await h.controller.settle()
  expect(h.copied.at(-1)).toBe("visible")
  h.controller.executeCommand("copy markdown", "main")
  await h.controller.settle()
  expect(h.copied.at(-1)).toBe(visible)

  h.controller.changeDraft("note", 4)
  h.controller.transcript({ type: "reference", presentationId: "main" })
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe(
    `note\n\n> ${visible}\n\n`,
  )
  h.controller.transcript({ type: "url.open", presentationId: "main" })
  expect(
    h.controller.getSnapshot().urlChoices?.map((choice) => choice.url),
  ).toEqual(["https://shown.test", "https://second.test"])
  expect(
    h.controller
      .getSnapshot()
      .urlChoices?.some((choice) => choice.url === "https://secret.test"),
  ).toBe(false)
  h.controller.transcript({
    type: "url.open",
    url: "https://second.test",
    presentationId: "main",
  })
  await h.controller.settle()
  expect(h.opened).toEqual(["https://second.test"])
  expect(h.controller.getSnapshot().urlChoices).toBeUndefined()
  expect(runtime.getSnapshot()).toMatchObject({
    mode: "detached",
    displayedCanonicalRevision: pinnedRevision,
  })
  expect(runtime.getSnapshot().transcript.projectionById[id]?.source).toBe(
    visible,
  )

  h.controller.transcript({ type: "viewport.tail" })
  h.controller.executeCommand("copy markdown", "main")
  await h.controller.settle()
  expect(h.copied.at(-1)).toBe(latest)
  expect(runtime.getSnapshot().transcript.projectionById[id]?.source).toBe(
    latest,
  )
  await h.controller.close()
})

test("explicit navigation materializes an item created beyond a detached frame", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const runtime = h.controller.transcriptRuntime("main")!
  const turn = turnId("reveal"),
    first = itemId("first-visible"),
    hidden = itemId("hidden-target")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: first,
        turnId: turn,
        kind: "assistant",
        markdown: "first",
        status: "complete",
      },
    },
  })
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: first, graphemeOffset: 0 },
    preferredScreenRow: 2,
    extend: false,
  })
  const pinned = runtime.getSnapshot()
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: hidden,
        turnId: turn,
        kind: "assistant",
        markdown: "target",
        status: "complete",
      },
    },
  })
  expect(runtime.getSnapshot()).toBe(pinned)
  h.controller.transcript({
    type: "jump",
    target: { itemId: hidden, graphemeOffset: 0 },
  })
  expect(
    runtime
      .getSnapshot()
      .blocks.some(
        (block) => block.key.kind === "item" && block.key.itemId === hidden,
      ),
  ).toBe(true)
  expect(runtime.getSnapshot().mode).toBe("detached")
  await h.controller.close()
})

test("distant selection swap reveals one bounded endpoint and copy spans unmounted blocks", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const runtime = h.controller.transcriptRuntime("main")!
  const ids = Array.from({ length: 100 }, (_, index) =>
    itemId(`selection-${index}`),
  )
  for (let index = 0; index < ids.length; index++)
    h.emit({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: a,
        item: {
          id: ids[index]!,
          turnId: turnId(`selection-turn-${index}`),
          kind: "assistant",
          markdown: index === 50 ? "**item-50**" : `item-${index}`,
          status: "complete",
        },
      },
    })
  const start = { itemId: ids[5]!, graphemeOffset: 0 }
  const end = { itemId: ids[95]!, graphemeOffset: 0 }
  h.controller.transcript({
    type: "cursor.move",
    target: start,
    preferredScreenRow: 3,
    extend: false,
  })
  h.controller.transcript({ type: "selection.begin", shape: "character" })
  h.controller.transcript({
    type: "cursor.move",
    target: end,
    preferredScreenRow: 3,
    extend: true,
  })
  const before = runtime.getSnapshot()
  expect(pointIsMaterialized(before.window.blocks, start)).toBe(false)
  let publications = 0
  runtime.subscribe(() => {
    publications++
  })
  h.controller.transcript({ type: "selection.swap" })
  const swapped = runtime.getSnapshot()
  expect(publications).toBe(1)
  expect(swapped.window.blocks.length).toBeLessThanOrEqual(72)
  expect(pointIsMaterialized(swapped.window.blocks, start)).toBe(true)
  expect(swapped.transcript.selection).toEqual({
    anchor: end,
    head: start,
    shape: "character",
  })
  expect(swapped.transcript.viewport).toEqual({
    kind: "point",
    point: start,
    preferredScreenRow: 3,
  })

  const expectedPlain = ids
    .slice(5, 96)
    .map((_, index, selected) =>
      index === selected.length - 1 ? "i" : `item-${index + 5}`,
    )
    .join("\n")
  const expectedSource = ids
    .slice(5, 96)
    .map((_, index, selected) =>
      index === selected.length - 1
        ? "i"
        : index + 5 === 50
          ? "**item-50**"
          : `item-${index + 5}`,
    )
    .join("\n")
  expect(selectedText(swapped.transcript, "source")).toBe(expectedSource)
  const copiesBeforeSource = h.copied.length
  h.controller.transcript({
    type: "copy",
    format: "source",
    presentationId: "main",
  })
  await h.controller.settle()
  for (
    let attempt = 0;
    attempt < 10 && h.copied.length === copiesBeforeSource;
    attempt++
  )
    await Bun.sleep(1)
  expect(h.copied.at(-1)).toBe(expectedSource)

  h.controller.transcript({
    type: "cursor.move",
    target: start,
    preferredScreenRow: 3,
    extend: false,
  })
  h.controller.transcript({ type: "selection.begin", shape: "character" })
  h.controller.transcript({
    type: "cursor.move",
    target: end,
    preferredScreenRow: 3,
    extend: true,
  })
  const blocks = runtime.getSnapshot().blocks
  h.controller.transcript({
    type: "copy",
    format: "plain",
    presentationId: "main",
  })
  await h.controller.settle()
  expect(h.copied.at(-1)).toBe(expectedPlain)
  expect(runtime.getSnapshot().blocks).toBe(blocks)
  expect(runtime.getSnapshot().window.blocks.length).toBeLessThanOrEqual(72)
  await h.controller.close()
})

test("off-window search adopts hidden content in one bounded coherent publication", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const runtime = h.controller.transcriptRuntime("main")!
  const ids = Array.from({ length: 100 }, (_, index) =>
    itemId(`search-window-${index}`),
  )
  for (let index = 0; index < ids.length; index++)
    h.emit({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: a,
        item: {
          id: ids[index]!,
          turnId: turnId(`search-window-turn-${index}`),
          kind: "assistant",
          markdown: `settled ${index}`,
          status: "complete",
        },
      },
    })
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: ids[5]!, graphemeOffset: 0 },
    preferredScreenRow: 3,
    extend: false,
  })
  const pinned = runtime.getSnapshot()
  const hidden = itemId("search-window-hidden")
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: hidden,
        turnId: turnId("search-window-hidden-turn"),
        kind: "tool",
        title: "",
        detail: "hidden unique-needle target",
        status: "complete",
      },
    },
  })
  expect(runtime.getSnapshot()).toBe(pinned)
  h.controller.transcript({ type: "fold.set", itemId: hidden, folded: true })
  h.controller.dispatchInteraction({ type: "mode.insert" })
  let statePublications = 0,
    runtimePublications = 0,
    presentationPublications = 0
  h.controller.subscribe(() => {
    statePublications++
  })
  runtime.subscribe(() => {
    runtimePublications++
  })
  h.controller.subscribePresentation("main", () => {
    presentationPublications++
  })
  h.controller.executeCommand("/unique-needle")
  const frame = runtime.getSnapshot()
  const target = frame.transcript.cursor!
  expect(statePublications).toBe(1)
  expect(runtimePublications).toBe(1)
  expect(presentationPublications).toBe(1)
  expect(frame.displayedCanonicalRevision).toBe(
    h.controller.getSnapshot().workspaces[a]!.canonicalRevision,
  )
  expect(frame.transcript.search).toEqual({
    query: "unique-needle",
    direction: "forward",
  })
  expect(target).toEqual({ itemId: hidden, graphemeOffset: 7 })
  expect(frame.transcript.viewport).toEqual({
    kind: "point",
    point: target,
    preferredScreenRow: 2,
  })
  expect(frame.transcript.folded[hidden]).toBe(false)
  expect(pointIsMaterialized(frame.window.blocks, target)).toBe(true)
  expect(frame.window.blocks.length).toBeLessThanOrEqual(72)
  expect(h.controller.getSnapshot().workspaces[a]!.interaction).toMatchObject({
    mode: "normal",
    surface: "transcript",
  })
  h.controller.dispatchInteraction({ type: "mode.insert" })
  h.controller.executeCommand("/not-present")
  expect(h.controller.getSnapshot().workspaces[a]!.transcript.search).toEqual({
    query: "not-present",
    direction: "forward",
  })
  expect(h.controller.getSnapshot().workspaces[a]!.interaction).toMatchObject({
    mode: "normal",
    surface: "transcript",
  })
  await h.controller.close()
})

test("off-window mark and clamped explicit jump each publish one complete target frame", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const runtime = h.controller.transcriptRuntime("main")!
  const ids = Array.from({ length: 100 }, (_, index) =>
    itemId(`jump-window-${index}`),
  )
  for (let index = 0; index < ids.length; index++)
    h.emit({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: a,
        item: {
          id: ids[index]!,
          turnId: turnId(`jump-window-turn-${index}`),
          kind: "tool",
          title: "",
          detail: `entry-${index}`,
          status: "complete",
        },
      },
    })

  const marked = { itemId: ids[8]!, graphemeOffset: 2 }
  h.controller.transcript({
    type: "cursor.move",
    target: marked,
    preferredScreenRow: 4,
    extend: false,
  })
  h.controller.transcript({ type: "mark.set", name: "a" })
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: ids[95]!, graphemeOffset: 0 },
    preferredScreenRow: 3,
    extend: false,
  })
  h.controller.transcript({
    type: "fold.set",
    itemId: marked.itemId,
    folded: true,
  })
  let statePublications = 0,
    publications = 0
  h.controller.subscribe(() => {
    statePublications++
  })
  runtime.subscribe(() => {
    publications++
  })
  h.controller.transcript({ type: "mark.jump", name: "a" })
  let frame = runtime.getSnapshot()
  expect(statePublications).toBe(1)
  expect(publications).toBe(1)
  expect(frame.transcript.cursor).toEqual(marked)
  expect(frame.transcript.viewport).toEqual({
    kind: "point",
    point: marked,
    preferredScreenRow: 4,
  })
  expect(frame.transcript.folded[marked.itemId]).toBe(false)
  expect(pointIsMaterialized(frame.window.blocks, marked)).toBe(true)
  expect(frame.window.blocks.length).toBeLessThanOrEqual(72)

  const selectionStart = { itemId: ids[90]!, graphemeOffset: 0 }
  const selectionEnd = { itemId: ids[95]!, graphemeOffset: 2 }
  h.controller.transcript({
    type: "cursor.move",
    target: selectionStart,
    preferredScreenRow: 3,
    extend: false,
  })
  h.controller.transcript({ type: "selection.begin", shape: "character" })
  h.controller.transcript({
    type: "cursor.move",
    target: selectionEnd,
    preferredScreenRow: 3,
    extend: true,
  })
  statePublications = 0
  publications = 0
  const rawTarget = { itemId: ids[5]!, graphemeOffset: 999 }
  h.controller.transcript({ type: "jump", target: rawTarget })
  frame = runtime.getSnapshot()
  const clamped = {
    itemId: rawTarget.itemId,
    graphemeOffset:
      frame.transcript.projectionById[rawTarget.itemId]!.sourceSpans.length,
  }
  expect(statePublications).toBe(1)
  expect(publications).toBe(1)
  expect(frame.transcript.selection).toBeUndefined()
  expect(frame.transcript.cursor).toEqual(clamped)
  expect(frame.transcript.viewport).toEqual({
    kind: "point",
    point: clamped,
    preferredScreenRow: 2,
  })
  expect(pointIsMaterialized(frame.window.blocks, clamped)).toBe(true)
  expect(frame.window.blocks.length).toBeLessThanOrEqual(72)
  await h.controller.close()
})

test("off-window URL motion unfolds one target and picker ownership settles atomically", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const runtime = h.controller.transcriptRuntime("main")!
  const ids = Array.from({ length: 100 }, (_, index) =>
    itemId(`url-window-${index}`),
  )
  for (let index = 0; index < ids.length; index++)
    h.emit({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: a,
        item: {
          id: ids[index]!,
          turnId: turnId(`url-window-turn-${index}`),
          kind: "tool",
          title: "",
          detail:
            index === 5
              ? "https://five.test and https://other.test"
              : `https://url-${index}.test`,
          status: "complete",
        },
      },
    })
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: ids[50]!, graphemeOffset: 0 },
    preferredScreenRow: 4,
    extend: false,
  })
  const blocks = runtime.getSnapshot().blocks
  let statePublications = 0,
    runtimePublications = 0,
    mainPublications = 0,
    sidePublications = 0
  h.controller.subscribe(() => {
    statePublications++
  })
  runtime.subscribe(() => {
    runtimePublications++
  })
  h.controller.subscribePresentation("main", () => {
    mainPublications++
  })
  h.controller.subscribePresentation("side", () => {
    sidePublications++
  })

  h.controller.transcript({ type: "fold.set", itemId: ids[50]!, folded: true })
  statePublications =
    runtimePublications =
    mainPublications =
    sidePublications =
      0
  h.controller.transcript({ type: "navigate", motion: "first-content" })
  expect(statePublications).toBe(1)
  expect(runtimePublications).toBe(1)
  expect(mainPublications).toBe(0)
  expect(sidePublications).toBe(0)
  expect(runtime.getSnapshot().transcript.cursor).toEqual({
    itemId: ids[50]!,
    graphemeOffset: 0,
  })
  expect(runtime.getSnapshot().transcript.folded[ids[50]!]).toBe(false)
  expect(
    pointIsMaterialized(
      runtime.getSnapshot().window.blocks,
      runtime.getSnapshot().transcript.cursor!,
    ),
  ).toBe(true)
  statePublications =
    runtimePublications =
    mainPublications =
    sidePublications =
      0
  h.controller.transcript({ type: "fold.set", itemId: ids[5]!, folded: true })
  expect(statePublications).toBe(1)
  expect(runtimePublications).toBe(1)
  expect(mainPublications).toBe(0)
  expect(sidePublications).toBe(0)
  expect(runtime.getSnapshot().blocks).toBe(blocks)
  expect(runtime.getSnapshot().window.blocks.length).toBeLessThanOrEqual(72)

  statePublications =
    runtimePublications =
    mainPublications =
    sidePublications =
      0
  h.controller.transcript({
    type: "navigate",
    motion: "url-previous",
    count: 46,
  })
  const frame = runtime.getSnapshot()
  expect(statePublications).toBe(1)
  expect(runtimePublications).toBe(1)
  expect(mainPublications).toBe(0)
  expect(sidePublications).toBe(0)
  expect(frame.transcript.cursor).toEqual({
    itemId: ids[5]!,
    graphemeOffset: 0,
  })
  expect(frame.transcript.folded[ids[5]!]).toBe(false)
  expect(
    pointIsMaterialized(frame.window.blocks, frame.transcript.cursor!),
  ).toBe(true)
  expect(frame.window.blocks.length).toBeLessThanOrEqual(72)

  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: ids[5]!, graphemeOffset: 17 },
    preferredScreenRow: 2,
    extend: false,
  })
  statePublications =
    runtimePublications =
    mainPublications =
    sidePublications =
      0
  h.controller.transcript({ type: "url.open", presentationId: "main" })
  const picker = h.controller.getSnapshot()
  expect(statePublications).toBe(1)
  expect(runtimePublications).toBe(0)
  expect(mainPublications).toBe(1)
  expect(sidePublications).toBe(0)
  expect(picker.workspaces[a]!.interaction.overlay).toBe("urls")
  expect(picker.urlChoiceOwner).toEqual({
    threadId: a,
    presentationId: "main",
    displayedCanonicalRevision: frame.displayedCanonicalRevision,
    scope: "current-item",
  })
  expect(picker.urlChoices?.map((choice) => choice.url)).toEqual([
    "https://five.test",
    "https://other.test",
  ])
  const choice = picker.urlChoices![1]!
  statePublications =
    runtimePublications =
    mainPublications =
    sidePublications =
      0
  h.controller.transcript({
    type: "url.open",
    url: choice.url,
    candidate: choice,
    presentationId: "main",
  })
  await h.controller.settle()
  expect(statePublications).toBe(1)
  expect(runtimePublications).toBe(0)
  expect(mainPublications).toBe(1)
  expect(sidePublications).toBe(0)
  expect(h.controller.getSnapshot().urlChoices).toBeUndefined()
  expect(h.controller.getSnapshot().urlChoiceOwner).toBeUndefined()
  expect(
    h.controller.getSnapshot().workspaces[a]!.interaction.overlay,
  ).toBeNull()
  expect(h.opened.at(-1)).toBe("https://other.test")
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: ids[5]!, graphemeOffset: 0 },
    preferredScreenRow: 2,
    extend: false,
  })
  statePublications =
    runtimePublications =
    mainPublications =
    sidePublications =
      0
  h.controller.transcript({ type: "url.open", presentationId: "main" })
  await h.controller.settle()
  expect(statePublications).toBe(0)
  expect(runtimePublications).toBe(0)
  expect(mainPublications).toBe(0)
  expect(sidePublications).toBe(0)
  expect(h.opened.at(-1)).toBe("https://five.test")

  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: ids[5]!, graphemeOffset: 17 },
    preferredScreenRow: 2,
    extend: false,
  })
  h.controller.transcript({ type: "url.open", presentationId: "main" })
  const staleChoice = h.controller.getSnapshot().urlChoices![1]!
  const openedBeforeStaleChoice = h.opened.length
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: ids[6]!, graphemeOffset: 0 },
    preferredScreenRow: 2,
    extend: false,
  })
  h.controller.transcript({
    type: "url.open",
    url: staleChoice.url,
    candidate: staleChoice,
    presentationId: "main",
  })
  await h.controller.settle()
  expect(h.opened).toHaveLength(openedBeforeStaleChoice)
  expect(h.controller.getSnapshot().error).toBe(
    "That URL is no longer available in the active picker",
  )
  h.controller.dispatchInteraction({ type: "overlay.close" })
  expect(h.controller.getSnapshot().urlChoices).toBeUndefined()
  expect(h.controller.getSnapshot().urlChoiceOwner).toBeUndefined()
  expect(
    h.controller.getSnapshot().workspaces[a]!.interaction.overlay,
  ).toBeNull()
  h.controller.transcript({
    type: "url.open",
    url: staleChoice.url,
    candidate: staleChoice,
    presentationId: "main",
  })
  await h.controller.settle()
  expect(h.opened).toHaveLength(openedBeforeStaleChoice)
  await h.controller.close()
})

test("configured default fold joins a newly admitted item in one semantic and runtime publication", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const runtime = h.controller.transcriptRuntime("main")!
  h.controller.transcript({
    type: "fold.defaults",
    reasoning: false,
    tools: true,
  })
  let statePublications = 0,
    runtimePublications = 0
  h.controller.subscribe(() => {
    statePublications++
  })
  runtime.subscribe(() => {
    runtimePublications++
  })
  const id = itemId("default-fold-arrival")
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id,
        turnId: turnId("default-fold-arrival-turn"),
        kind: "tool",
        title: "",
        detail: "private",
        status: "complete",
      },
    },
  })
  expect(statePublications).toBe(1)
  expect(runtimePublications).toBe(1)
  expect(h.controller.getSnapshot().workspaces[a]!.transcript.folded[id]).toBe(
    true,
  )
  expect(runtime.getSnapshot().transcript.folded[id]).toBe(true)
  await h.controller.close()
})

test("cross-thread history atomically materializes the restored viewport rather than its distant cursor", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const runtime = h.controller.transcriptRuntime("main")!
  const ids = Array.from({ length: 100 }, (_, index) =>
    itemId(`history-window-${index}`),
  )
  for (let index = 0; index < ids.length; index++)
    h.emit({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: a,
        item: {
          id: ids[index]!,
          turnId: turnId(`history-window-turn-${index}`),
          kind: "assistant",
          markdown: `history ${index}`,
          status: "complete",
        },
      },
    })
  const cursor = { itemId: ids[5]!, graphemeOffset: 1 }
  const anchor = { itemId: ids[80]!, graphemeOffset: 2 }
  h.controller.transcript({
    type: "cursor.move",
    target: cursor,
    preferredScreenRow: 3,
    extend: false,
  })
  h.controller.transcript({
    type: "viewport.anchor",
    point: anchor,
    preferredScreenRow: 7,
  })
  h.controller.openThread(b)
  await h.controller.settle()
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: b,
      item: {
        id: itemId("history-window-b"),
        turnId: turnId("history-window-b-turn"),
        kind: "assistant",
        markdown: "thread b",
        status: "complete",
      },
    },
  })
  let statePublications = 0,
    runtimePublications = 0,
    presentationPublications = 0
  h.controller.subscribe(() => {
    statePublications++
  })
  runtime.subscribe(() => {
    runtimePublications++
  })
  h.controller.subscribePresentation("main", () => {
    presentationPublications++
  })
  h.controller.transcript({ type: "jump.back" })
  await h.controller.settle()
  const frame = runtime.getSnapshot()
  expect(statePublications).toBe(1)
  expect(runtimePublications).toBe(1)
  expect(presentationPublications).toBe(1)
  expect(frame.threadId).toBe(a)
  expect(frame.transcript.cursor).toEqual(cursor)
  expect(frame.transcript.viewport).toEqual({
    kind: "point",
    point: anchor,
    preferredScreenRow: 7,
  })
  expect(pointIsMaterialized(frame.window.blocks, anchor)).toBe(true)
  expect(pointIsMaterialized(frame.window.blocks, cursor)).toBe(false)
  expect(frame.window.blocks.length).toBeLessThanOrEqual(72)
  await h.controller.close()
})

test("thread navigation closes the source overlay without turning an old follow cursor into a reveal", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const runtime = h.controller.transcriptRuntime("main")!
  const first = itemId("thread-tail-first")
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: first,
        turnId: turnId("thread-tail-turn-0"),
        kind: "assistant",
        markdown: "first",
        status: "complete",
      },
    },
  })
  h.controller.transcript({ type: "viewport.tail" })
  const ids = [first]
  for (let index = 1; index < 100; index++) {
    const id = itemId(`thread-tail-${index}`)
    ids.push(id)
    h.emit({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: a,
        item: {
          id,
          turnId: turnId(`thread-tail-turn-${index}`),
          kind: "assistant",
          markdown: `tail ${index}`,
          status: "complete",
        },
      },
    })
  }
  expect(h.controller.getSnapshot().workspaces[a]!.transcript).toMatchObject({
    viewport: { kind: "tail" },
    cursor: { itemId: first },
  })
  h.controller.dispatchInteraction({ type: "overlay.open", overlay: "help" })
  h.controller.openThread(b)
  await h.controller.settle()
  expect(
    h.controller.getSnapshot().workspaces[a]!.interaction.overlay,
  ).toBeNull()
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: b,
      item: {
        id: itemId("thread-tail-b"),
        turnId: turnId("thread-tail-b-turn"),
        kind: "assistant",
        markdown: "thread b",
        status: "complete",
      },
    },
  })
  let publications = 0
  runtime.subscribe(() => {
    publications++
  })
  h.controller.openThread(a)
  await h.controller.settle()
  const frame = runtime.getSnapshot()
  const tail = {
    itemId: ids.at(-1)!,
    graphemeOffset:
      frame.transcript.projectionById[ids.at(-1)!]!.sourceSpans.length,
  }
  expect(publications).toBe(1)
  expect(frame.threadId).toBe(a)
  expect(frame.mode).toBe("follow")
  expect(frame.transcript.viewport).toEqual({ kind: "tail" })
  expect(pointIsMaterialized(frame.window.blocks, tail)).toBe(true)
  expect(
    pointIsMaterialized(frame.window.blocks, {
      itemId: first,
      graphemeOffset: 0,
    }),
  ).toBe(false)
  expect(frame.window.blocks.length).toBeLessThanOrEqual(72)
  await h.controller.close()
})

test("cached layout and pane publications ignore canonical token content", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const runtime = h.controller.transcriptRuntime("main")!
  const turn = turnId("publication"),
    id = itemId("publication-answer")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id,
        turnId: turn,
        kind: "assistant",
        markdown: "before",
        status: "running",
      },
    },
  })
  const layout = h.controller.getLayoutSnapshot()
  const main = h.controller.getPresentationSnapshot("main")
  const side = h.controller.getPresentationSnapshot("side")
  const frame = runtime.getSnapshot()
  let layoutCalls = 0,
    mainCalls = 0,
    sideCalls = 0
  h.controller.subscribeLayout(() => {
    layoutCalls++
  })
  h.controller.subscribePresentation("main", () => {
    mainCalls++
  })
  h.controller.subscribePresentation("side", () => {
    sideCalls++
  })

  h.emit({
    type: "conversation",
    event: { type: "item.delta", threadId: a, itemId: id, delta: " after" },
  })
  await h.controller.settle()
  expect(runtime.getSnapshot()).not.toBe(frame)
  expect(h.controller.getLayoutSnapshot()).toBe(layout)
  expect(h.controller.getPresentationSnapshot("main")).toBe(main)
  expect(h.controller.getPresentationSnapshot("side")).toBe(side)
  expect([layoutCalls, mainCalls, sideCalls]).toEqual([0, 0, 0])

  h.controller.changeDraft("pane input", 10)
  expect(h.controller.getPresentationSnapshot("main")).not.toBe(main)
  expect(h.controller.getPresentationSnapshot("side")).toBe(side)
  expect([layoutCalls, mainCalls, sideCalls]).toEqual([0, 1, 0])
  await h.controller.close()
})

test("publication callbacks observe one coherent canonical revision across stores", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const runtime = h.controller.transcriptRuntime("main")!
  const turn = turnId("coherent")
  const observations: Array<{
    working: boolean
    presentationRevision?: number
    runtimeRevision: number
  }> = []
  const observe = () =>
    observations.push({
      working: h.controller.getLayoutSnapshot().parentActivity.working,
      presentationRevision:
        h.controller.getPresentationSnapshot("main").workspaces[a]
          ?.canonicalRevision,
      runtimeRevision: runtime.getSnapshot().displayedCanonicalRevision,
    })
  const unsubscribers = [
    runtime.subscribe(observe),
    h.controller.subscribeLayout(observe),
    h.controller.subscribePresentation("main", observe),
  ]

  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  expect(observations.length).toBeGreaterThan(0)
  expect(
    observations.every(
      (observation) =>
        observation.working &&
        observation.presentationRevision === observation.runtimeRevision,
    ),
  ).toBe(true)

  observations.length = 0
  h.emit({
    type: "conversation",
    event: {
      type: "turn.completed",
      threadId: a,
      turnId: turn,
      outcome: "complete",
    },
  })
  expect(observations.length).toBeGreaterThan(0)
  expect(
    observations.every(
      (observation) =>
        !observation.working &&
        observation.presentationRevision === observation.runtimeRevision,
    ),
  ).toBe(true)

  for (const unsubscribe of unsubscribers) unsubscribe()
  await h.controller.close()
})

test("cached main presentation publishes global status before a workspace exists", async () => {
  const h = harness()
  const before = h.controller.getPresentationSnapshot("main")
  let calls = 0
  h.controller.subscribePresentation("main", () => {
    calls++
  })
  h.controller.dispatch({
    type: "connection.changed",
    connection: "error",
    error: "offline",
  })
  expect(h.controller.getPresentationSnapshot("main")).not.toBe(before)
  expect(h.controller.getPresentationSnapshot("main")).toMatchObject({
    connection: "error",
    error: "offline",
  })
  expect(calls).toBe(1)
  h.controller.dispatch({
    type: "approval.received",
    approval: {
      id: "early-approval",
      threadId: a,
      kind: "command",
      title: "Run",
      detail: "command",
      choices: [{ id: "yes", label: "Yes" }],
      status: "pending",
    },
  })
  expect(h.controller.getPresentationSnapshot("main").approvals.order).toEqual([
    "early-approval",
  ])
  expect(calls).toBe(2)
  h.controller.dispatch({
    type: "question.received",
    request: {
      id: "early-question",
      threadId: a,
      turnId: turnId("early-turn"),
      questions: [
        {
          id: "choice",
          header: "Choose",
          question: "Choose",
          allowOther: false,
          secret: false,
          options: [
            { label: "A", description: "First" },
            { label: "B", description: "Second" },
          ],
        },
      ],
    },
  })
  expect(
    Object.keys(h.controller.getPresentationSnapshot("main").questions),
  ).toEqual(["early-question"])
  expect(calls).toBe(3)
  await h.controller.close()
})

test("conversation boundaries, disconnect, restart, and close cannot strand pending deltas", async () => {
  const setup = async (suffix: string) => {
    const manual = manualIngressScheduler()
    const h = harness({ conversationIngressScheduler: manual.scheduler })
    await h.controller.initialize("/tmp")
    const turn = turnId(`turn-${suffix}`),
      id = itemId(`item-${suffix}`)
    h.emit({
      type: "conversation",
      event: { type: "turn.started", threadId: a, turnId: turn },
    })
    h.emit({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: a,
        item: {
          id,
          turnId: turn,
          kind: "assistant",
          markdown: "base",
          status: "running",
        },
      },
    })
    h.emit({
      type: "conversation",
      event: {
        type: "item.delta",
        threadId: a,
        itemId: id,
        delta: `-${suffix}`,
      },
    })
    return { h, id, turn }
  }

  const boundary = await setup("boundary")
  boundary.h.emit({
    type: "conversation",
    event: {
      type: "turn.completed",
      threadId: a,
      turnId: boundary.turn,
      outcome: "complete",
    },
  })
  expect(
    boundary.h.controller.getSnapshot().workspaces[a]?.conversation.items[
      boundary.id
    ],
  ).toMatchObject({ markdown: "base-boundary" })
  await boundary.h.controller.close()

  const disconnected = await setup("disconnect")
  disconnected.h.emit({ type: "disconnected", message: "gone" })
  expect(
    disconnected.h.controller.getSnapshot().workspaces[a]?.conversation.items[
      disconnected.id
    ],
  ).toMatchObject({ markdown: "base-disconnect" })
  await disconnected.h.controller.close()

  const restarted = await setup("restart")
  restarted.h.controller.restart()
  expect(
    restarted.h.controller.getSnapshot().workspaces[a]?.conversation.items[
      restarted.id
    ],
  ).toMatchObject({ markdown: "base-restart" })
  await restarted.h.controller.settle()
  await restarted.h.controller.close()

  const closed = await setup("close")
  await closed.h.controller.close()
  expect(
    closed.h.controller.getSnapshot().workspaces[a]?.conversation.items[
      closed.id
    ],
  ).toMatchObject({ markdown: "base-close" })
})

test("shutdown publishes its final ingress drain to persistence observers", async () => {
  let observed: WorkbenchState | undefined
  const h = harness({
    onState: (state) => {
      observed = state
    },
  })
  await h.controller.initialize("/tmp")
  const turn = turnId("close-observed"),
    id = itemId("close-observed")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id,
        turnId: turn,
        kind: "assistant",
        markdown: "before",
        status: "running",
      },
    },
  })
  h.emit({
    type: "conversation",
    event: { type: "item.delta", threadId: a, itemId: id, delta: " after" },
  })
  await h.controller.close()
  expect(observed?.workspaces[a]?.conversation.items[id]).toMatchObject({
    markdown: "before after",
  })
})

test("shutdown publishes a persisted anchor reprojected by its final Markdown delta", async () => {
  const local: LocalState[] = []
  const h = harness({
    onLocalState: (state) => {
      local.push(state)
    },
  })
  await h.controller.initialize("/tmp")
  const turn = turnId("close-anchor"),
    id = itemId("close-anchor")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id,
        turnId: turn,
        kind: "assistant",
        markdown: "prefix **bold",
        status: "running",
      },
    },
  })
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: id, graphemeOffset: 11 },
    preferredScreenRow: 4,
    extend: false,
  })
  local.length = 0
  h.emit({
    type: "conversation",
    event: {
      type: "item.delta",
      threadId: a,
      itemId: id,
      delta: "** and more",
    },
  })
  await h.controller.close()
  expect(local.at(-1)?.threads[a]?.cursor).toEqual({
    itemId: id,
    graphemeOffset: 9,
  })
  expect(local.at(-1)?.threads[a]?.viewport).toEqual({
    kind: "point",
    point: { itemId: id, graphemeOffset: 9 },
    preferredScreenRow: 4,
  })
})

test("stale resume response cannot steal focus after a newer navigation", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  let finish!: (snapshot: SessionSnapshot) => void
  h.backend.resumeThread = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  h.controller.openThread(b)
  h.controller.openThread(a)
  finish({ summary: summary(b), events: [] })
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
})

test("turn-start response cannot replay an older snapshot over completed live output", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.backend.startTurn = async () => {
    const turn = turnId("fast-turn")
    h.emit({
      type: "conversation",
      event: { type: "turn.started", threadId: a, turnId: turn },
    })
    h.emit({
      type: "conversation",
      event: {
        type: "turn.completed",
        threadId: a,
        turnId: turn,
        outcome: "complete",
      },
    })
    return [{ type: "turn.started", threadId: a, turnId: turn }]
  }
  h.controller.changeDraft("quick", 5)
  h.controller.submit("next-turn")
  await h.controller.settle()
  expect(
    h.controller.getSnapshot().workspaces[a]?.conversation.activeTurnId,
  ).toBeUndefined()
})

test("resume buffers live deltas until history is hydrated and coalesces concurrent resumes", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  let finish!: (snapshot: SessionSnapshot) => void
  let calls = 0
  h.backend.resumeThread = () => {
    calls++
    return new Promise((resolve) => {
      finish = resolve
    })
  }
  h.controller.openThread(b)
  h.controller.openThread(b)
  const turn = turnId("resume-turn"),
    id = itemId("resume-message")
  h.emit({
    type: "conversation",
    event: { type: "item.delta", threadId: b, itemId: id, delta: " new" },
  })
  finish({
    summary: summary(b),
    events: [
      { type: "turn.started", threadId: b, turnId: turn },
      {
        type: "item.started",
        threadId: b,
        item: {
          id,
          turnId: turn,
          kind: "assistant",
          markdown: "old",
          status: "running",
        },
      },
    ],
  })
  await h.controller.settle()
  expect(calls).toBe(1)
  const item = h.controller.getSnapshot().workspaces[b]?.conversation.items[id]
  expect(item && "markdown" in item ? item.markdown : undefined).toBe("old new")
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
})

test("reasoning settings validate against the model and publish only after backend acknowledgement", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const updates: unknown[] = []
  h.backend.updateSettings = async (_, settings) => {
    updates.push(settings)
  }
  h.controller.executeCommand(":thinking low")
  await h.controller.settle()
  expect(updates).toEqual([{ effort: "low" }])
  expect(h.controller.getSnapshot().summaries[a]?.reasoningEffort).toBe("low")
  h.controller.executeCommand(":thinking invented")
  await h.controller.settle()
  expect(updates).toHaveLength(1)
  expect(h.controller.getSnapshot().error).toContain(
    "Unsupported reasoning effort",
  )
  h.backend.updateSettings = async () => {
    throw new Error("backend denied")
  }
  h.controller.executeCommand(":thinking high")
  await h.controller.settle()
  expect(h.controller.getSnapshot().summaries[a]?.reasoningEffort).toBe("low")
})

test("disconnect invalidates transport-scoped approvals and direct copy uses the clipboard port", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.emit({
    type: "approval",
    approval: {
      id: "approval",
      threadId: a,
      kind: "command",
      title: "Run",
      detail: "danger",
      choices: [{ id: "accept", label: "Accept" }],
      status: "pending",
    },
  })
  expect(h.controller.getSnapshot().approvals.order).toEqual(["approval"])
  h.emit({ type: "disconnected", message: "server exited" })
  expect(h.controller.getSnapshot().approvals.order).toEqual([])
  expect(h.controller.getSnapshot().connection).toBe("disconnected")
  h.controller.copyText("rendered selection")
  await h.controller.settle()
  expect(h.copied).toEqual(["rendered selection"])
})

test("closing during initialization prevents late hydration and is idempotent", async () => {
  let releaseConnect!: () => void
  let listCalls = 0
  let stateChanges = 0
  const h = harness({
    onState: () => {
      stateChanges++
    },
  })
  h.backend.connect = () =>
    new Promise((resolve) => {
      releaseConnect = resolve
    })
  h.backend.listThreads = async () => {
    listCalls++
    return [summary(a)]
  }
  h.backend.close = async () => {
    releaseConnect()
  }
  const initialization = h.controller.initialize("/tmp")
  const closing = h.controller.close()
  expect(h.controller.close()).toBe(closing)
  await closing
  await initialization
  expect(listCalls).toBe(0)
  expect(stateChanges).toBe(0)
  expect(h.controller.getSnapshot().activeThreadId).toBeUndefined()
})

test("restored outbox is never resent until the user explicitly retries", async () => {
  const localState: LocalState = {
    version: 1,
    threads: {
      a: {
        draft: "",
        cursorOffset: 0,
        folded: {},
        viewport: { kind: "tail" },
        surface: "composer",
        outbox: [
          {
            id: "uncertain",
            text: "possibly delivered",
            intent: "next-turn",
            status: "sending",
          },
        ],
      },
    },
  }
  const h = harness({ localState })
  await h.controller.initialize("/tmp")
  expect(h.starts).toEqual([])
  expect(
    h.controller.getSnapshot().workspaces[a]?.composer.outbox[0],
  ).toMatchObject({ id: "uncertain", status: "failed" })
  h.controller.retryOutgoing("uncertain")
  await h.controller.settle()
  expect(h.starts).toEqual(["possibly delivered"])
})

test("runtime questions and child relationships reach owned state and requests expire on disconnect", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const request = {
    id: "question",
    threadId: a,
    turnId: turnId("turn"),
    questions: [
      {
        id: "choice",
        header: "Choice",
        question: "Which option?",
        allowOther: true,
        secret: false,
      },
    ],
  }
  const link = {
    parentId: a,
    childId: b,
    itemId: itemId("agent"),
    relation: "spawned" as const,
  }
  h.emit({ type: "question.requested", request })
  h.emit({ type: "subagent.link", link })
  h.emit({ type: "subagent.link", link })
  expect(h.controller.getSnapshot().questions.question).toEqual(request)
  expect(h.controller.getSnapshot().agentRelationships).toEqual([link])
  h.emit({ type: "question.resolved", id: request.id })
  expect(h.controller.getSnapshot().questions).toEqual({})
  h.emit({ type: "question.requested", request })
  h.emit({ type: "disconnected", message: "closed" })
  expect(h.controller.getSnapshot().questions).toEqual({})
  expect(h.controller.getSnapshot().agentRelationships).toEqual([link])
})

test("fork requires explicit confirmation and resolves assistant cursor to its user-message boundary", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const turn = turnId("completed"),
    user = itemId("question"),
    answer = itemId("answer")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  for (const [id, kind, markdown] of [
    [user, "user", "Original prompt"],
    [answer, "assistant", "Original response"],
  ] as const)
    h.emit({
      type: "conversation",
      event: {
        type: "item.completed",
        threadId: a,
        item: { id, turnId: turn, kind, markdown, status: "complete" },
      },
    })
  h.emit({
    type: "conversation",
    event: {
      type: "turn.completed",
      threadId: a,
      turnId: turn,
      outcome: "complete",
    },
  })
  let forks = 0
  h.backend.forkThread = async (id, through) => {
    expect(id).toBe(a)
    expect(through).toBe(turn)
    forks++
    return { summary: summary(threadId("fork")), events: [] }
  }
  h.controller.requestFork(answer)
  expect(h.controller.getSnapshot().pendingFork?.itemId).toBe(user)
  expect(h.controller.getSnapshot().workspaces[a]?.interaction.overlay).toBe(
    "fork",
  )
  expect(forks).toBe(0)
  h.controller.cancelFork()
  expect(h.controller.getSnapshot().pendingFork).toBeUndefined()
  h.controller.requestFork(answer)
  h.controller.confirmFork()
  await h.controller.settle()
  expect(forks).toBe(1)
  expect(h.controller.getSnapshot().activeThreadId).toBe(threadId("fork"))
})

test("agent navigation returns to the exact parent draft and transcript state", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("Parent draft", 5)
  const parent = h.controller.getSnapshot().workspaces[a]!
  h.emit({
    type: "subagent.link",
    link: {
      parentId: a,
      childId: b,
      itemId: itemId("agent"),
      relation: "spawned",
    },
  })
  h.controller.openChildThread(b)
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  h.controller.changeDraft("Child draft", 4)
  h.controller.returnToParent()
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  expect(h.controller.getSnapshot().workspaces[a]?.composer).toEqual(
    parent.composer,
  )
  expect(h.controller.getSnapshot().workspaces[a]?.transcript).toEqual(
    parent.transcript,
  )
  expect(h.controller.getSnapshot().workspaces[b]?.composer.text).toBe(
    "Child draft",
  )
})

test("question answers validate options, retain failed requests, and clear only after success", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const request = {
    id: "request",
    threadId: a,
    turnId: turnId("turn"),
    questions: [
      {
        id: "q",
        header: "Choice",
        question: "Pick one",
        allowOther: false,
        secret: false,
        options: [{ label: "Yes", description: "Proceed" }],
      },
    ],
  }
  h.emit({ type: "question.requested", request })
  let calls = 0,
    fail = true
  h.backend.respondToQuestions = async (_, answers) => {
    calls++
    expect(answers).toEqual({ q: "Yes" })
    if (fail) throw new Error("Disconnected")
  }
  h.controller.answerQuestions(request.id, { q: "invalid" })
  await h.controller.settle()
  expect(calls).toBe(0)
  h.controller.answerQuestions(request.id, { q: "Yes" })
  await h.controller.settle()
  expect(h.controller.getSnapshot().questions.request).toEqual(request)
  fail = false
  h.controller.answerQuestions(request.id, { q: "Yes" })
  await h.controller.settle()
  expect(calls).toBe(2)
  expect(h.controller.getSnapshot().questions).toEqual({})
})

test("controlled restart rehydrates the active thread and preserves drafts without sending", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("Keep this draft", 4)
  let restarts = 0
  h.backend.restart = async () => {
    restarts++
    h.emit({
      type: "disconnected",
      message: "Restarting Codex app server",
      reason: "restart",
    })
    expect(h.controller.getSnapshot().connection).toBe("connecting")
  }
  h.emit({ type: "disconnected", message: "Server exited" })
  h.controller.restart()
  h.controller.restart()
  await h.controller.settle()
  expect(restarts).toBe(1)
  expect(h.controller.getSnapshot().connection).toBe("connected")
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe(
    "Keep this draft",
  )
  expect(h.starts).toEqual([])
})

test("semantic search unfolds its target, URL choice resolves through the port, and reference preserves draft", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const id = itemId("rich"),
    turn = turnId("rich-turn")
  h.emit({
    type: "conversation",
    event: {
      type: "item.completed",
      threadId: a,
      item: {
        id,
        turnId: turn,
        kind: "tool",
        title: "",
        status: "complete",
        detail:
          "First paragraph\n\nneedle https://one.test and https://two.test\n\nLast paragraph",
      },
    },
  })
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: id, graphemeOffset: 0 },
    preferredScreenRow: 2,
    extend: false,
  })
  h.controller.transcript({ type: "fold.set", itemId: id, folded: true })
  h.controller.executeCommand("/needle")
  let transcript = h.controller.getSnapshot().workspaces[a]!.transcript
  expect(transcript.search).toEqual({ query: "needle", direction: "forward" })
  expect(transcript.cursor?.graphemeOffset).toBe(17)
  expect(transcript.folded[id]).toBe(false)
  h.controller.transcript({ type: "url.open", presentationId: "main" })
  expect(
    h.controller.getSnapshot().urlChoices?.map((candidate) => candidate.url),
  ).toEqual(["https://one.test", "https://two.test"])
  h.controller.transcript({
    type: "url.open",
    url: "https://two.test",
    presentationId: "main",
  })
  await h.controller.settle()
  expect(h.opened).toEqual(["https://two.test"])
  h.controller.changeDraft("My note", 7)
  h.controller.transcript({ type: "reference", presentationId: "main" })
  expect(h.controller.getSnapshot().workspaces[a]!.composer.text).toContain(
    "My note\n\n> needle https://one.test",
  )
  expect(h.controller.getSnapshot().workspaces[a]!.interaction.mode).toBe(
    "insert",
  )
})

test("restart quarantines stale turn and resume responses and keeps uncertain text retryable", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  let finishTurn!: (events: ConversationEvent[]) => void
  h.backend.startTurn = () =>
    new Promise((resolve) => {
      finishTurn = resolve
    })
  h.controller.changeDraft("uncertain", 9)
  h.controller.submit("next-turn")

  const staleItem = itemId("stale-item"),
    staleTurn = turnId("stale-turn")
  let finishResume!: (snapshot: SessionSnapshot) => void
  h.backend.resumeThread = (id) =>
    id === b
      ? new Promise((resolve) => {
          finishResume = resolve
        })
      : Promise.resolve({ summary: summary(id), events: [] })
  h.controller.openThread(b)
  h.emit({ type: "disconnected", message: "old runtime exited" })
  h.controller.restart()
  finishResume({
    summary: summary(b),
    events: [
      { type: "turn.started", threadId: b, turnId: staleTurn },
      {
        type: "item.completed",
        threadId: b,
        item: {
          id: staleItem,
          turnId: staleTurn,
          kind: "assistant",
          markdown: "stale",
          status: "complete",
        },
      },
    ],
  })
  finishTurn([
    { type: "turn.started", threadId: a, turnId: staleTurn },
    {
      type: "item.completed",
      threadId: a,
      item: {
        id: staleItem,
        turnId: staleTurn,
        kind: "assistant",
        markdown: "stale",
        status: "complete",
      },
    },
  ])
  await h.controller.settle()

  expect(
    h.controller.getSnapshot().workspaces[a]?.conversation.items[staleItem],
  ).toBeUndefined()
  expect(
    h.controller.getSnapshot().workspaces[b]?.conversation.items[staleItem],
  ).toBeUndefined()
  expect(
    h.controller.getSnapshot().workspaces[a]?.composer.outbox[0],
  ).toMatchObject({ text: "uncertain", status: "failed" })
})

test("a stale question completion cannot delete a same-id request from the restarted runtime", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  let finish!: () => void
  h.backend.respondToQuestions = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const old = {
    id: "same",
    threadId: a,
    turnId: turnId("old"),
    questions: [
      {
        id: "q",
        header: "Old",
        question: "Old?",
        allowOther: true,
        secret: false,
      },
    ],
  }
  h.emit({ type: "question.requested", request: old })
  h.controller.answerQuestions(old.id, { q: "yes" })
  h.emit({ type: "disconnected", message: "restart" })
  h.controller.restart()
  const current = {
    ...old,
    turnId: turnId("new"),
    questions: [{ ...old.questions[0]!, header: "New" }],
  }
  h.emit({ type: "question.requested", request: current })
  finish()
  await h.controller.settle()
  expect(h.controller.getSnapshot().questions.same).toEqual(current)
})

test("approval commands are active-session scoped and successful RPC acknowledgement clears state", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const resolved: string[] = []
  h.backend.resolveApproval = async (id) => {
    resolved.push(id)
  }
  h.emit({
    type: "approval",
    approval: {
      id: "background",
      threadId: b,
      kind: "command",
      title: "B",
      detail: "B",
      choices: [{ id: "accept", label: "Accept" }],
      status: "pending",
    },
  })
  h.emit({
    type: "approval",
    approval: {
      id: "active",
      threadId: a,
      kind: "command",
      title: "A",
      detail: "A",
      choices: [{ id: "accept", label: "Accept" }],
      status: "pending",
    },
  })
  h.controller.executeCommand(":approve")
  await h.controller.settle()
  expect(resolved).toEqual(["active"])
  expect(h.controller.getSnapshot().approvals.byId.active).toBeUndefined()
  expect(h.controller.getSnapshot().approvals.byId.background?.status).toBe(
    "pending",
  )
  h.controller.resolveApproval("background", "accept")
  await h.controller.settle()
  expect(resolved).toEqual(["active"])
})

test("a queued steer waits for turn.started when start RPC acknowledges without events", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const steers: string[] = []
  h.backend.startTurn = async (_id, text) => {
    h.starts.push(text)
    return []
  }
  h.backend.steerTurn = async (_id, _turn, text) => {
    steers.push(text)
  }
  h.controller.changeDraft("start", 5)
  h.controller.submit("next-turn")
  h.controller.changeDraft("steer", 5)
  h.controller.submit("steer")
  await h.controller.settle()
  expect(h.starts).toEqual(["start"])
  expect(steers).toEqual([])
  expect(
    h.controller.getSnapshot().workspaces[a]?.composer.outbox[0],
  ).toMatchObject({ text: "steer", status: "queued" })

  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turnId("real") },
  })
  await h.controller.settle()
  expect(steers).toEqual(["steer"])
})

test("RPC replay admits unseen items after a live turn start without regressing live items", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const turn = turnId("raced"),
    live = itemId("live"),
    returned = itemId("returned")
  h.backend.startTurn = async () => {
    h.emit({
      type: "conversation",
      event: { type: "turn.started", threadId: a, turnId: turn },
    })
    h.emit({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: a,
        item: {
          id: live,
          turnId: turn,
          kind: "assistant",
          markdown: "live newer",
          status: "running",
        },
      },
    })
    return [
      { type: "turn.started", threadId: a, turnId: turn },
      {
        type: "item.started",
        threadId: a,
        item: {
          id: live,
          turnId: turn,
          kind: "assistant",
          markdown: "old",
          status: "running",
        },
      },
      {
        type: "item.completed",
        threadId: a,
        item: {
          id: returned,
          turnId: turn,
          kind: "user",
          markdown: "prompt",
          status: "complete",
        },
      },
    ]
  }
  h.controller.changeDraft("go", 2)
  h.controller.submit("next-turn")
  await h.controller.settle()
  const conversation = h.controller.getSnapshot().workspaces[a]!.conversation
  expect(conversation.items[returned]).toMatchObject({
    markdown: "prompt",
    status: "complete",
  })
  expect(conversation.items[live]).toMatchObject({
    markdown: "live newer",
    status: "running",
  })
})

test("preference and thread-setting mutations preserve command order", async () => {
  let releasePreference!: () => void
  const preferenceGate = new Promise<void>((resolve) => {
    releasePreference = resolve
  })
  const saved: Array<{ theme: string; syntaxTheme: string }> = []
  const h = harness({
    preferences: {
      initial: { theme: "ember-tide", syntaxTheme: "theme" },
      async save(value) {
        saved.push(value)
        if (saved.length === 1) await preferenceGate
      },
    },
  })
  await h.controller.initialize("/tmp")
  h.controller.executeCommand(":theme nord")
  h.controller.executeCommand(":syntax kanagawa")
  await Promise.resolve()
  await Promise.resolve()
  expect(saved).toEqual([{ theme: "nord", syntaxTheme: "theme" }])
  releasePreference()
  await h.controller.settle()
  expect(saved).toEqual([
    { theme: "nord", syntaxTheme: "theme" },
    { theme: "nord", syntaxTheme: "kanagawa" },
  ])
  expect(h.controller.getSnapshot().preferences).toEqual({
    theme: "nord",
    syntaxTheme: "kanagawa",
  })

  let releaseModel!: () => void
  let markModelStarted!: () => void
  const modelGate = new Promise<void>((resolve) => {
    releaseModel = resolve
  })
  const modelStarted = new Promise<void>((resolve) => {
    markModelStarted = resolve
  })
  const updates: unknown[] = []
  h.backend.listModels = async () => [
    { id: "test", label: "Test", efforts: ["low"] },
    { id: "next", label: "Next", efforts: ["medium"] },
  ]
  h.backend.updateSettings = async (_id, settings) => {
    updates.push(settings)
    if (updates.length === 1) {
      markModelStarted()
      await modelGate
    }
  }
  h.controller.executeCommand(":model next")
  h.controller.executeCommand(":thinking medium")
  await modelStarted
  expect(updates).toEqual([{ model: "next" }])
  releaseModel()
  await h.controller.settle()
  expect(updates).toEqual([{ model: "next" }, { effort: "medium" }])
  expect(h.controller.getSnapshot().summaries[a]).toMatchObject({
    model: "next",
    reasoningEffort: "medium",
  })
})

test("late fork cannot steal focus and stale URL picker choices cannot open after a session switch", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const turn = turnId("forkable"),
    user = itemId("fork-user"),
    rich = itemId("links")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.completed",
      threadId: a,
      item: {
        id: user,
        turnId: turn,
        kind: "user",
        markdown: "fork me",
        status: "complete",
      },
    },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.completed",
      threadId: a,
      item: {
        id: rich,
        turnId: turn,
        kind: "assistant",
        markdown: "[one](https://one.test) [two](https://two.test)",
        status: "complete",
      },
    },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "turn.completed",
      threadId: a,
      turnId: turn,
      outcome: "complete",
    },
  })
  let finishFork!: (snapshot: SessionSnapshot) => void
  h.backend.forkThread = () =>
    new Promise((resolve) => {
      finishFork = resolve
    })
  h.controller.requestFork(user)
  h.controller.confirmFork()
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: rich, graphemeOffset: 3 },
    preferredScreenRow: 0,
    extend: false,
  })
  h.controller.transcript({ type: "url.open", presentationId: "main" })
  expect(h.controller.getSnapshot().urlChoices).toHaveLength(2)
  h.controller.openThread(b)
  await Promise.resolve()
  await Promise.resolve()
  expect(h.controller.getSnapshot().urlChoices).toBeUndefined()
  h.controller.transcript({
    type: "url.open",
    url: "https://one.test",
    presentationId: "main",
  })
  finishFork({ summary: summary(threadId("fork")), events: [] })
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  expect(h.opened).toEqual([])
})

test("a completed turn arriving before its start acknowledgment still drains the queued prompt", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  let resolveFirst!: (events: readonly ConversationEvent[]) => void
  h.backend.startTurn = async (_id, text) => {
    h.starts.push(text)
    return h.starts.length === 1
      ? new Promise((resolve) => {
          resolveFirst = resolve
        })
      : [{ type: "turn.started", threadId: a, turnId: turnId("second-turn") }]
  }
  h.controller.changeDraft("first", 5)
  h.controller.submit("next-turn")
  h.controller.changeDraft("second", 6)
  h.controller.submit("next-turn")
  const turn = turnId("fast-turn")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "turn.completed",
      threadId: a,
      turnId: turn,
      outcome: "complete",
    },
  })
  resolveFirst([{ type: "turn.started", threadId: a, turnId: turn }])
  await h.controller.settle()
  expect(h.starts).toEqual(["first", "second"])
  await h.controller.close()
})

test("rejected stale item events cannot regress the displayed transcript", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const item = {
    id: itemId("finished"),
    turnId: turnId("done-turn"),
    kind: "assistant" as const,
    status: "complete" as const,
    markdown: "Final answer",
  }
  h.emit({
    type: "conversation",
    event: { type: "item.completed", threadId: a, item },
  })
  const before =
    h.controller.getSnapshot().workspaces[a]!.transcript.projectionById[item.id]
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: { ...item, status: "running", markdown: "stale partial" },
    },
  })
  const workspace = h.controller.getSnapshot().workspaces[a]!
  expect(workspace.conversation.items[item.id]).toEqual(item)
  expect(workspace.transcript.projectionById[item.id]).toBe(before)
  await h.controller.close()
})

test("favorites restore independently of history and selected-session rename does not switch threads", async () => {
  const h = harness({
    localState: { version: 1, threads: {}, favoriteThreadIds: [b, b] },
  })
  const renamed: [string, string][] = []
  h.backend.renameThread = async (id, title) => {
    renamed.push([id, title])
  }
  await h.controller.initialize("/tmp")
  expect(h.controller.getSnapshot().favoriteThreadIds).toEqual([b])
  h.controller.toggleFavorite(a)
  h.controller.toggleFavorite(b)
  expect(h.controller.getSnapshot().favoriteThreadIds).toEqual([a])
  h.controller.renameThread(b, "  Saved research  ")
  await h.controller.settle()
  expect(renamed).toEqual([[b, "Saved research"]])
  expect(h.controller.getSnapshot().summaries[b]?.title).toBe("Saved research")
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  h.backend.renameThread = async () => {
    throw new Error("rename denied")
  }
  h.controller.renameThread(b, "Rejected name")
  await h.controller.settle()
  expect(h.controller.getSnapshot().summaries[b]?.title).toBe("Saved research")
  await h.controller.close()
})

test("model command completion and picker share a catalog while direct model selection preserves the draft", async () => {
  const h = harness()
  let loads = 0
  const changes: unknown[] = []
  h.backend.listModels = async () => {
    loads++
    return [
      { id: "test", label: "Test", efforts: ["high"] },
      { id: "next", label: "Next", efforts: ["high"] },
    ]
  }
  h.backend.updateSettings = async (_, settings) => {
    changes.push(settings)
  }
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("keep my draft", 4)
  h.controller.dispatchInteraction({ type: "mode.command" })
  await h.controller.settle()
  expect(
    h.controller.getSnapshot().availableModels?.map((model) => model.id),
  ).toEqual(["test", "next"])
  h.controller.executeCommand(":model next")
  await h.controller.settle()
  expect(changes).toEqual([{ model: "next" }])
  expect(
    h.controller.getSnapshot().workspaces[a]?.interaction.overlay,
  ).toBeNull()
  h.controller.executeNamedCommand("model")
  await h.controller.settle()
  expect(h.controller.getSnapshot().workspaces[a]?.interaction.overlay).toBe(
    "models",
  )
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe(
    "keep my draft",
  )
  expect(loads).toBe(1)
  await h.controller.close()
})

test("stale model catalog cannot mutate settings after disconnect", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  let release!: (
    models: Awaited<ReturnType<ModelCatalog["listModels"]>>,
  ) => void
  let started!: () => void
  const requested = new Promise<void>((resolve) => {
    started = resolve
  })
  h.backend.listModels = () => {
    started()
    return new Promise((resolve) => {
      release = resolve
    })
  }
  const updates: unknown[] = []
  h.backend.updateSettings = async (_, settings) => {
    updates.push(settings)
  }
  h.controller.executeCommand(":model next")
  await requested
  h.emit({ type: "disconnected", message: "connection lost" })
  release([{ id: "next", label: "Next", efforts: [] }])
  await h.controller.settle()
  expect(updates).toEqual([])
  expect(h.controller.getSnapshot().availableModels).toBeUndefined()
  await h.controller.close()
})

test("failed model discovery exposes an error and can be retried", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.backend.listModels = async () => {
    throw new Error("Catalog unavailable")
  }
  h.controller.executeNamedCommand("model")
  await h.controller.settle()
  expect(h.controller.getSnapshot().modelCatalogError).toBe(
    "Catalog unavailable",
  )
  h.backend.listModels = async () => [
    { id: "test", label: "Test", efforts: [] },
  ]
  h.controller.executeNamedCommand("model")
  await h.controller.settle()
  expect(h.controller.getSnapshot().modelCatalogError).toBeUndefined()
  expect(h.controller.getSnapshot().availableModels).toHaveLength(1)
  await h.controller.close()
})

test("model and thinking level apply together only after both arguments validate", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.backend.listModels = async () => [
    { id: "sol-5.6", label: "Sol", efforts: ["low", "medium"] },
  ]
  const updates: unknown[] = []
  h.backend.updateSettings = async (_, settings) => {
    updates.push(settings)
  }
  h.controller.changeDraft("draft stays", 5)
  h.controller.executeCommand(":model sol-5.6 medium")
  await h.controller.settle()
  expect(updates).toEqual([{ model: "sol-5.6", effort: "medium" }])
  expect(h.controller.getSnapshot().summaries[a]).toMatchObject({
    model: "sol-5.6",
    reasoningEffort: "medium",
  })
  h.controller.executeCommand(":model sol-5.6 ultra")
  await h.controller.settle()
  expect(h.controller.getSnapshot().error).toContain(
    "Unsupported reasoning effort",
  )
  h.controller.executeCommand(":model sol-5.6 low extra")
  await h.controller.settle()
  expect(h.controller.getSnapshot().error).toContain("Usage:")
  expect(updates).toHaveLength(1)
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe(
    "draft stays",
  )
  await h.controller.close()
})

test("session commands switch exactly, favorite idempotently, and preserve drafts", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("Keep this draft", 4)
  h.controller.executeCommand("favorite on")
  h.controller.executeCommand("favorite on")
  expect(h.controller.getSnapshot().favoriteThreadIds).toEqual([a])
  h.controller.executeCommand("favorite off")
  expect(h.controller.getSnapshot().favoriteThreadIds).toEqual([])
  h.controller.executeCommand("sessions b")
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  expect(h.controller.getSnapshot().workspaces[a]!.composer.text).toBe(
    "Keep this draft",
  )
  h.backend.resumeThread = async () => {
    throw new Error("Unknown session: missing")
  }
  h.controller.executeCommand("sessions missing")
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  expect(h.controller.getSnapshot().error).toContain("Unknown session")
  h.controller.executeCommand("sessions")
  expect(h.controller.getSnapshot().workspaces[b]!.interaction.overlay).toBe(
    "sessions",
  )
  await h.controller.close()
})

test("command validation reports usage without sending or changing preferences", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("Unsent draft", 5)
  for (const command of [
    "submit accidental",
    "favorite maybe",
    "stop extra",
    "rename",
    "yank html",
    "theme nord extra",
  ]) {
    h.controller.executeCommand(command)
    expect(h.controller.getSnapshot().error).toContain("Usage:")
    expect(h.controller.getSnapshot().workspaces[a]!.composer.text).toBe(
      "Unsent draft",
    )
  }
  expect(h.starts).toEqual([])
  expect(h.controller.getSnapshot().preferences).toBeUndefined()
  h.controller.executeCommand("help model")
  expect(h.controller.getSnapshot().error).toContain(
    "model [model-id] [thinking-level]",
  )
  await h.controller.close()
})

test("follow resumes the live tail and slash model text loads argument choices", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const id = itemId("follow-answer")
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id,
        turnId: turnId("turn"),
        kind: "assistant",
        markdown: "Reading here",
        status: "complete",
      },
    },
  })
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: id, graphemeOffset: 3 },
    preferredScreenRow: 2,
    extend: false,
  })
  h.controller.executeCommand("follow")
  expect(h.controller.getSnapshot().workspaces[a]!.transcript.viewport).toEqual(
    { kind: "tail" },
  )
  expect(
    h.controller.getSnapshot().workspaces[a]!.transcript.cursor,
  ).toMatchObject({ itemId: id })
  h.controller.changeDraft("/model ", 7)
  await h.controller.settle()
  expect(
    h.controller.getSnapshot().availableModels?.map((model) => model.id),
  ).toEqual(["test"])
  expect(h.starts).toEqual([])
  await h.controller.close()
})

test("submit commands explicitly steer or queue the current draft", async () => {
  const h = harness()
  const steered: string[] = []
  h.backend.steerTurn = async (_thread, _turn, text) => {
    steered.push(text)
  }
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("First", 5)
  h.controller.executeCommand("submit queue")
  await h.controller.settle()
  h.controller.changeDraft("Steering", 8)
  h.controller.executeCommand("submit steer")
  await h.controller.settle()
  expect(steered).toEqual(["Steering"])
  h.controller.changeDraft("Next turn", 9)
  h.controller.executeCommand("submit queue")
  await h.controller.settle()
  expect(h.starts).toEqual(["First"])
  expect(
    h.controller.getSnapshot().workspaces[a]!.composer.outbox,
  ).toContainEqual(
    expect.objectContaining({
      text: "Next turn",
      intent: "next-turn",
      status: "queued",
    }),
  )
  await h.controller.close()
})

test("visual command initializes a transcript selection and preserves the composer", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const id = itemId("selectable")
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id,
        turnId: turnId("select-turn"),
        kind: "assistant",
        markdown: "Select this",
        status: "complete",
      },
    },
  })
  h.controller.changeDraft("Keep draft", 4)
  h.controller.executeCommand("visual")
  const workspace = h.controller.getSnapshot().workspaces[a]!
  expect(workspace.interaction).toMatchObject({
    surface: "transcript",
    mode: "visual",
  })
  expect(workspace.transcript.selection).toMatchObject({
    anchor: workspace.transcript.cursor,
    head: workspace.transcript.cursor,
    shape: "character",
  })
  expect(workspace.composer.text).toBe("Keep draft")
  await h.controller.close()
})

test("copy command yanks the current block without requiring a Visual selection", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const id = itemId("copy-block")
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id,
        turnId: turnId("copy-turn"),
        kind: "assistant",
        markdown: "A **clear** answer",
        status: "complete",
      },
    },
  })
  h.controller.executeCommand("copy markdown")
  await h.controller.settle()
  expect(h.copied).toEqual(["A **clear** answer"])
  expect(
    h.controller.getSnapshot().workspaces[a]!.interaction.unnamedRegister.text,
  ).toBe("A **clear** answer")
  h.controller.executeCommand("yank text")
  await h.controller.settle()
  expect(h.copied.at(-1)).toBe("A clear answer")
  await h.controller.close()
})

test("sessions command can resume an exact ID absent from the listed catalog", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const unlisted = threadId("0198d809-5492-7eb7-bbd5-dc531334eb9b")
  expect(h.controller.getSnapshot().summaries[unlisted]).toBeUndefined()
  h.controller.executeCommand(`sessions ${unlisted}`)
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(unlisted)
  await h.controller.close()
})

test("public jump and mark actions keep history per thread and normalize non-Visual focus", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const first = itemId("jump-a"),
    second = itemId("jump-b")
  for (const [id, markdown] of [
    [first, "first"],
    [second, "second"],
  ] as const)
    h.emit({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: a,
        item: {
          id,
          turnId: turnId("jump-turn"),
          kind: "assistant",
          markdown,
          status: "complete",
        },
      },
    })
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: first, graphemeOffset: 1 },
    preferredScreenRow: 4,
    extend: false,
  })
  h.controller.transcript({
    type: "viewport.anchor",
    point: { itemId: second, graphemeOffset: 0 },
    preferredScreenRow: 8,
  })
  h.controller.transcript({ type: "mark.set", name: "a" })
  expect(h.controller.getSnapshot().workspaces[a]!.transcript.marks.a).toEqual({
    point: { itemId: first, graphemeOffset: 1 },
    preferredScreenRow: 0,
  })
  h.controller.dispatchInteraction({ type: "mode.insert" })
  h.controller.transcript({ type: "jump.back" })
  expect(h.controller.getSnapshot().workspaces[a]!.interaction.mode).toBe(
    "insert",
  )
  h.controller.transcript({
    type: "viewport.anchor",
    point: { itemId: first, graphemeOffset: 1 },
    preferredScreenRow: 7,
  })
  h.controller.transcript({
    type: "jump",
    target: { itemId: second, graphemeOffset: 2 },
    origin: { itemId: first, graphemeOffset: 1 },
    originPreferredScreenRow: 11,
  })
  let workspace = h.controller.getSnapshot().workspaces[a]!
  expect(workspace.interaction).toMatchObject({
    mode: "normal",
    surface: "transcript",
  })
  expect(workspace.transcript.cursor).toEqual({
    itemId: second,
    graphemeOffset: 2,
  })
  expect(workspace.transcript.jumps.back.at(-1)?.preferredScreenRow).toBe(11)
  h.controller.transcript({ type: "jump.back" })
  expect(h.controller.getSnapshot().workspaces[a]!.transcript.cursor).toEqual({
    itemId: first,
    graphemeOffset: 1,
  })
  h.controller.transcript({ type: "mark.jump", name: "a" })
  workspace = h.controller.getSnapshot().workspaces[a]!
  expect(workspace.transcript.cursor).toEqual(
    workspace.transcript.marks.a?.point,
  )
  await h.controller.close()
})

test("interrupt deduplicates pending requests, retries failures, and waits for authoritative completion", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const turn = turnId("interrupt-lifecycle")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  h.controller.changeDraft("keep this draft", 4)
  let attempts = 0
  h.backend.interruptTurn = async () => {
    if (++attempts === 1) throw new Error("temporary stop failure")
  }
  h.controller.interrupt()
  h.controller.interrupt()
  await h.controller.settle()
  expect(attempts).toBe(1)
  expect(h.controller.getSnapshot().interruptingTurns[a]).toBeUndefined()
  expect(
    h.controller.getSnapshot().workspaces[a]?.conversation.activeTurnId,
  ).toBe(turn)
  h.controller.interrupt()
  await h.controller.settle()
  h.controller.interrupt()
  await h.controller.settle()
  expect(attempts).toBe(2)
  expect(h.controller.getSnapshot().interruptingTurns[a]).toBe(turn)
  expect(
    h.controller.getSnapshot().workspaces[a]?.conversation.activeTurnId,
  ).toBe(turn)
  h.emit({
    type: "conversation",
    event: {
      type: "turn.completed",
      threadId: a,
      turnId: turn,
      outcome: "interrupted",
    },
  })
  expect(h.controller.getSnapshot().interruptingTurns[a]).toBeUndefined()
  expect(
    h.controller.getSnapshot().workspaces[a]?.conversation.activeTurnId,
  ).toBeUndefined()
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe(
    "keep this draft",
  )
  await h.controller.close()
})

test("jump history interleaves parent and child positions, restores independent anchors, and branches", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const first = itemId("parent-output"),
    second = itemId("child-output")
  const add = (thread: typeof a, id: typeof first) =>
    h.emit({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: thread,
        item: {
          id,
          turnId: turnId("history"),
          kind: "assistant",
          markdown: "0123456789",
          status: "complete",
        },
      },
    })
  add(a, first)
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: first, graphemeOffset: 1 },
    preferredScreenRow: 3,
    extend: false,
  })
  h.controller.transcript({
    type: "viewport.anchor",
    point: { itemId: first, graphemeOffset: 0 },
    preferredScreenRow: 7,
  })
  h.controller.changeDraft("parent draft", 4)
  h.emit({
    type: "subagent.link",
    link: {
      parentId: a,
      childId: b,
      itemId: itemId("spawn"),
      relation: "spawned",
    },
  })
  h.controller.openChildThread(b)
  await h.controller.settle()
  add(b, second)
  h.controller.changeDraft("child draft", 2)
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: second, graphemeOffset: 2 },
    preferredScreenRow: 4,
    extend: false,
  })
  h.controller.transcript({
    type: "jump",
    target: { itemId: second, graphemeOffset: 8 },
  })
  h.controller.transcript({ type: "jump.back" })
  expect(
    h.controller.getSnapshot().workspaces[b]!.transcript.cursor?.graphemeOffset,
  ).toBe(2)
  h.controller.transcript({ type: "jump.back" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  expect(h.controller.getSnapshot().workspaces[a]!.transcript).toMatchObject({
    cursor: { itemId: first, graphemeOffset: 1 },
    viewport: {
      kind: "point",
      point: { itemId: first, graphemeOffset: 0 },
      preferredScreenRow: 7,
    },
  })
  h.controller.transcript({ type: "jump.forward" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  expect(
    h.controller.getSnapshot().workspaces[b]!.transcript.cursor?.graphemeOffset,
  ).toBe(2)
  h.controller.transcript({ type: "jump.forward" })
  expect(
    h.controller.getSnapshot().workspaces[b]!.transcript.cursor?.graphemeOffset,
  ).toBe(8)
  h.controller.transcript({ type: "jump.back" })
  h.controller.transcript({
    type: "jump",
    target: { itemId: second, graphemeOffset: 5 },
  })
  h.controller.transcript({ type: "jump.forward" })
  expect(
    h.controller.getSnapshot().workspaces[b]!.transcript.cursor?.graphemeOffset,
  ).toBe(5)
  expect(h.controller.getSnapshot().workspaces[a]!.composer.text).toBe(
    "parent draft",
  )
  expect(h.controller.getSnapshot().workspaces[b]!.composer.text).toBe(
    "child draft",
  )
  await h.controller.close()
})

test("agent family cycling includes parent and siblings, wraps, and returns to immediate parent", async () => {
  const h = harness(),
    c = threadId("c"),
    grandchild = threadId("grandchild")
  await h.controller.initialize("/tmp")
  for (const [parentId, childId] of [
    [a, b],
    [a, c],
    [b, grandchild],
  ] as const)
    h.emit({
      type: "subagent.link",
      link: {
        parentId,
        childId,
        itemId: itemId(`spawn-${childId}`),
        relation: "spawned",
      },
    })
  // A child's reply to its parent and messages to siblings must not reparent them.
  for (const childId of [a, c])
    h.emit({
      type: "subagent.link",
      link: {
        parentId: b,
        childId,
        itemId: itemId(`reply-${childId}`),
        relation: "target",
      },
    })
  h.controller.returnToParent()
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  for (const expected of [b, c, a]) {
    h.controller.cycleAgent("next")
    await h.controller.settle()
    expect(h.controller.getSnapshot().activeThreadId).toBe(expected)
  }
  h.controller.cycleAgent("previous")
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(c)
  h.controller.openThread(grandchild)
  await h.controller.settle()
  h.controller.returnToParent()
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  await h.controller.close()
})

test("failed and superseded session requests do not introduce ghost jump entries", async () => {
  const h = harness(),
    c = threadId("c")
  await h.controller.initialize("/tmp")
  let release!: (snapshot: SessionSnapshot) => void
  h.backend.resumeThread = (id) =>
    id === b
      ? new Promise((resolve) => {
          release = resolve
        })
      : Promise.resolve({ summary: summary(id), events: [] })
  h.controller.openThread(b)
  h.controller.openThread(c)
  release({ summary: summary(b), events: [] })
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(c)
  h.controller.transcript({ type: "jump.back" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  h.controller.transcript({ type: "jump.back" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  h.backend.resumeThread = async () => {
    throw new Error("resume denied")
  }
  h.controller.openThread(threadId("failure"))
  await h.controller.settle()
  h.controller.transcript({ type: "jump.forward" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(c)
  await h.controller.close()
})

test("failed history resume after restart retains the entry for retry", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.openThread(b)
  await h.controller.settle()
  h.controller.restart()
  await h.controller.settle()
  const resume = h.backend.resumeThread
  h.backend.resumeThread = async (id) => {
    if (id === a) throw new Error("temporary resume failure")
    return resume(id)
  }
  h.controller.transcript({ type: "jump.back" })
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  h.backend.resumeThread = resume
  h.controller.transcript({ type: "jump.back" })
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  h.controller.transcript({ type: "jump.forward" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  await h.controller.close()
})

test("stream settlement preserves an in-flight history navigation target identity", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.openThread(b)
  await h.controller.settle()
  h.controller.restart()
  await h.controller.settle()
  let release!: (snapshot: SessionSnapshot) => void
  const resume = h.backend.resumeThread
  h.backend.resumeThread = (id) =>
    id === a
      ? new Promise((resolve) => {
          release = resolve
        })
      : resume(id)
  h.controller.transcript({ type: "jump.back" })
  h.emit({
    type: "conversation",
    event: {
      type: "turn.started",
      threadId: b,
      turnId: turnId("while-navigating"),
    },
  })
  release({ summary: summary(a), events: [] })
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  await h.controller.close()
})

test("background streamed Markdown reprojects cross-agent history to the same source text", async () => {
  const h = harness(),
    output = itemId("stream-history")
  await h.controller.initialize("/tmp")
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: output,
        turnId: turnId("stream"),
        kind: "assistant",
        markdown: "**hello",
        status: "running",
      },
    },
  })
  const before =
    h.controller.getSnapshot().workspaces[a]!.transcript.projectionById[output]!
  const offset = before.plain.indexOf("h")
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: output, graphemeOffset: offset },
    preferredScreenRow: 5,
    extend: false,
  })
  h.controller.openThread(b)
  await h.controller.settle()
  h.emit({
    type: "conversation",
    event: { type: "item.delta", threadId: a, itemId: output, delta: "**" },
  })
  await h.controller.settle()
  h.controller.transcript({ type: "jump.back" })
  const transcript = h.controller.getSnapshot().workspaces[a]!.transcript
  expect(
    transcript.projectionById[output]!.plain[transcript.cursor!.graphemeOffset],
  ).toBe("h")
  expect(transcript.viewport).toMatchObject({
    kind: "point",
    preferredScreenRow: 5,
    point: transcript.cursor,
  })
  await h.controller.close()
})

test("repeated history keys during a slow resume traverse distinct entries in order", async () => {
  const h = harness(),
    c = threadId("c")
  await h.controller.initialize("/tmp")
  h.controller.openThread(b)
  await h.controller.settle()
  h.controller.openThread(c)
  await h.controller.settle()
  h.controller.restart()
  await h.controller.settle()
  const resume = h.backend.resumeThread
  let release!: (snapshot: SessionSnapshot) => void
  h.backend.resumeThread = (id) =>
    id === b
      ? new Promise((resolve) => {
          release = resolve
        })
      : resume(id)
  h.controller.transcript({ type: "jump.back" })
  h.controller.transcript({ type: "jump.back" })
  release({ summary: summary(b), events: [] })
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  h.controller.transcript({ type: "jump.forward" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  h.controller.transcript({ type: "jump.forward" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(c)
  await h.controller.close()
})

test("history safely restores a session whose old transcript point no longer exists", async () => {
  const h = harness(),
    output = itemId("removed-output")
  await h.controller.initialize("/tmp")
  h.emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: a,
      item: {
        id: output,
        turnId: turnId("removed-turn"),
        kind: "assistant",
        markdown: "removed",
        status: "complete",
      },
    },
  })
  h.controller.transcript({
    type: "cursor.move",
    target: { itemId: output, graphemeOffset: 3 },
    preferredScreenRow: 4,
    extend: false,
  })
  h.controller.openThread(b)
  await h.controller.settle()
  h.controller.restart()
  await h.controller.settle()
  h.controller.transcript({ type: "jump.back" })
  await h.controller.settle()
  const workspace = h.controller.getSnapshot().workspaces[a]!
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  expect(workspace.transcript.cursor).toBeUndefined()
  expect(workspace.transcript.viewport).toEqual({ kind: "tail" })
  await h.controller.close()
})

test("goal commands use server state, serialize mutations, and preserve draft without invented prompts", async () => {
  const h = harness()
  const calls: unknown[] = []
  let goal: import("@vimex/conversation").ThreadGoal | null = null
  h.backend.getGoal = async (id) => {
    calls.push(["get", id])
    return goal
  }
  h.backend.setGoal = async (id, update) => {
    calls.push(["set", id, update])
    goal = {
      objective: "old",
      status: "active",
      tokenBudget: null,
      tokensUsed: 42,
      timeUsedSeconds: 3,
      ...goal,
      ...update,
    }
    return goal
  }
  h.backend.clearGoal = async (id) => {
    calls.push(["clear", id])
    goal = null
    return true
  }
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("keep my draft", 4)
  h.controller.executeCommand("goal Fix tests")
  h.controller.executeCommand("goal pause")
  await h.controller.settle()
  expect(calls).toEqual([
    ["set", a, { objective: "Fix tests", status: "active" }],
    ["set", a, { status: "paused" }],
  ])
  expect(h.controller.getSnapshot().error).toContain("Goal [paused]: Fix tests")
  h.controller.executeCommand("goal")
  await h.controller.settle()
  expect(h.controller.getSnapshot().error).toContain("42 tokens")
  h.controller.executeCommand("goal --budget 30000 Improve parser")
  await h.controller.settle()
  expect(calls.at(-1)).toEqual([
    "set",
    a,
    { objective: "Improve parser", status: "active", tokenBudget: 30000 },
  ])
  h.controller.executeCommand("goal clear")
  await h.controller.settle()
  expect(h.controller.getSnapshot().error).toBe("Goal cleared")
  expect(h.controller.getSnapshot().workspaces[a]!.composer.text).toBe(
    "keep my draft",
  )
  expect(h.starts).toEqual([])
  await h.controller.close()
})

test("manual aliases open the offline guide without changing the draft", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("Preserve this", 4)
  for (const command of ["manual", "man", "help manual"]) {
    h.controller.executeCommand(command)
    expect(h.controller.getSnapshot().workspaces[a]?.interaction.overlay).toBe(
      "manual",
    )
    expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe(
      "Preserve this",
    )
    h.controller.dispatchInteraction({ type: "overlay.close" })
  }
  await h.controller.close()
})

test("CLI resume last and picker scope existing sessions by cwd without creating threads", async () => {
  for (const mode of ["last", "picker"] as const) {
    const h = harness()
    const calls: string[] = []
    h.backend.listThreads = async () => [
      { ...summary(a), updatedAt: 10 },
      { ...summary(b), cwd: "/elsewhere", updatedAt: 50 },
      { ...summary(threadId("latest")), updatedAt: 20 },
    ]
    h.backend.startThread = async () => {
      throw new Error("must not create")
    }
    h.backend.resumeThread = async (id) => {
      calls.push(id)
      return { summary: summary(id), events: [] }
    }
    await h.controller.initialize("/tmp", undefined, undefined, mode)
    expect(calls).toEqual(["latest"])
    expect(
      h.controller.getSnapshot().workspaces.latest!.interaction.overlay,
    ).toBe(mode === "picker" ? "sessions" : null)
    await h.controller.close()
  }
})
test("CLI resume reports an empty cwd catalog without creating a server thread", async () => {
  const h = harness()
  h.backend.listThreads = async () => []
  h.backend.startThread = async () => {
    throw new Error("must not create")
  }
  await expect(
    h.controller.initialize("/tmp", undefined, undefined, "last"),
  ).rejects.toThrow("No sessions found for /tmp")
  expect(h.controller.getSnapshot().activeThreadId).toBeUndefined()
  await expect(h.controller.close()).rejects.toThrow(
    "Vimex controller shutdown failed",
  )
})

test("child lifecycle refreshes an existing transcript task and gc opens it without losing the parent draft", async () => {
  const h = harness(),
    turn = turnId("delegation"),
    spawnId = itemId("spawn-child")
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("Keep this draft", 4)
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: a, turnId: turn },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.completed",
      threadId: a,
      item: {
        id: spawnId,
        turnId: turn,
        kind: "agent",
        action: "spawn",
        detail: "Investigate token refresh",
        agentThreadIds: [b],
        agentStates: [{ threadId: b, status: "running" }],
        status: "complete",
      },
    },
  })
  await h.controller.settle()
  const runtime = h.controller.transcriptRuntime("main")!
  const task = () =>
    runtime
      .getSnapshot()
      .blocks.find(
        (block) => block.key.kind === "item" && block.key.itemId === spawnId,
      )
  expect(task()).toMatchObject({
    item: { childTasks: [{ status: "running" }] },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "item.completed",
      threadId: a,
      item: {
        id: itemId("child-result"),
        turnId: turn,
        kind: "agent",
        action: "wait",
        detail: "",
        agentThreadIds: [b],
        agentStates: [
          { threadId: b, status: "complete", message: "Refresh fixed" },
        ],
        status: "complete",
      },
    },
  })
  await h.controller.settle()
  expect(task()).toMatchObject({
    item: { childTasks: [{ status: "complete", message: "Refresh fixed" }] },
  })
  h.controller.transcript({
    type: "jump",
    target: { itemId: spawnId, graphemeOffset: 0 },
  })
  h.controller.transcript({ type: "child.open", presentationId: "main" })
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  h.controller.returnToParent()
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  expect(h.controller.getSnapshot().workspaces[a]!.composer.text).toBe(
    "Keep this draft",
  )
  await h.controller.close()
})
