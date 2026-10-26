import { expect, test } from "bun:test"
import {
  itemId,
  threadId,
  turnId,
  type ConversationEvent,
  type ConversationGateway,
} from "@vimex/conversation"
import { VimexController, type ControllerPorts } from "./workbench-controller"
import { transitionWorkbench } from "./reduce-workbench"
import { initialWorkbench, type WorkbenchState } from "./workbench-state"
import { submissionConversation } from "./submission-presentation"
import {
  buildTranscriptBlocks,
  type TranscriptRuntimeDiagnostics,
} from "@vimex/transcript"
import { buildTranscriptStructuralScalingFixture } from "@vimex/testkit"

const id = threadId("instant-submit")
const turn = turnId("server-turn")
const summary = {
  id,
  title: "Test",
  cwd: "/tmp",
  model: "test",
  reasoningEffort: "high",
  status: "idle" as const,
}
const echo = (messageId = "message-1"): ConversationEvent => ({
  type: "item.started",
  threadId: id,
  item: {
    id: itemId(`server-${messageId}`),
    clientMessageId: messageId,
    turnId: turn,
    kind: "user",
    markdown: "hello",
    status: "running",
  },
})

function controllerWithHistory(count: number) {
  const fixture = buildTranscriptStructuralScalingFixture(count)
  const thread = fixture.threadId
  const controller = new VimexController({
    conversation: {
      startTurn: async () => new Promise(() => {}),
      steerTurn: async () => new Promise(() => {}),
    } as never,
    approvals: {} as never,
    connection: {} as never,
    models: {} as never,
    resolveDirectory: (_, path) => path,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
  })
  controller.dispatch({
    type: "thread.open",
    summary: { ...summary, id: thread },
  })
  // Seed immutable history directly; the benchmark measures admission, not loading.
  const state = controller.getSnapshot()
  ;(controller as unknown as { state: WorkbenchState }).state = {
    ...state,
    connection: "connected",
    workspaces: {
      ...state.workspaces,
      [thread]: { ...state.workspaces[thread]!, ...fixture.before },
    },
  }
  ;(controller as unknown as { loaded: Set<string> }).loaded.add(thread)
  const runtime = controller.transcriptRuntime("main")!
  const event = (event: ConversationEvent) =>
    controller.dispatch({ type: "conversation.event", event })
  const warm = turnId("warm")
  event({ type: "turn.started", threadId: thread, turnId: warm })
  event({
    type: "item.started",
    threadId: thread,
    item: {
      id: itemId("warm-user"),
      turnId: warm,
      kind: "user",
      markdown: "warm",
      status: "complete",
    },
  })
  event({
    type: "turn.completed",
    threadId: thread,
    turnId: warm,
    outcome: "complete",
  })
  const counters = new Proxy({} as TranscriptRuntimeDiagnostics, {
    get(target, key) {
      return target[key as keyof TranscriptRuntimeDiagnostics] ?? 0
    },
  })
  ;(
    runtime as unknown as { diagnostics: TranscriptRuntimeDiagnostics }
  ).diagnostics = counters
  return { controller, runtime, thread, event, counters }
}

test("optimistic submit, start, echo, and following deltas avoid full history rebuilds", () => {
  for (const count of [100, 1000, 10000, 100000]) {
    const { controller, runtime, thread, event, counters } =
      controllerWithHistory(count)
    const before = runtime.getSnapshot()
    controller.changeDraft("hello", 5)
    expect(controller.submit("next-turn")).toBe(true)
    expect(runtime.getSnapshot().blocks.length).toBe(before.blocks.length + 1)
    const pending =
      controller.getSnapshot().workspaces[thread]!.pendingSubmissions![0]!
    const nextTurn = turnId("next")
    event({ type: "turn.started", threadId: thread, turnId: nextTurn })
    expect(runtime.getSnapshot().damage.kind).toBe("none")
    event({
      type: "item.started",
      threadId: thread,
      item: {
        id: itemId("server-echo"),
        clientMessageId: pending.id,
        turnId: nextTurn,
        kind: "user",
        markdown: "hello",
        status: "complete",
      },
    })
    expect(runtime.getSnapshot().blocks.at(-1)?.key).toMatchObject({
      itemId: "server-echo",
    })
    expect(
      runtime.getSnapshot().transcript.projectionById[pending.id],
    ).toBeUndefined()
    event({
      type: "item.started",
      threadId: thread,
      item: {
        id: itemId("answer"),
        turnId: nextTurn,
        kind: "assistant",
        markdown: "Hi",
        status: "running",
      },
    })
    event({
      type: "item.delta",
      threadId: thread,
      itemId: itemId("answer"),
      delta: " there",
    })
    expect(
      runtime.getSnapshot().transcript.projectionById["answer"]?.source,
    ).toBe("Hi there")
    expect(runtime.getSnapshot().blocks[0]).toBe(before.blocks[0])
    expect(counters.completePlanBuilds).toBe(0)
    expect(counters.heightIndexBuilds).toBe(0)
    expect(counters.changedItemBuilds).toBeLessThan(10)
    runtime.dispose()
    Bun.gc(true)
  }
}, 60000)

test("failed optimistic tail is removed without rebuilding history", () => {
  const { controller, runtime, thread, counters } = controllerWithHistory(1000)
  const before = runtime.getSnapshot()
  controller.changeDraft("hello", 5)
  controller.submit("next-turn")
  const pending =
    controller.getSnapshot().workspaces[thread]!.pendingSubmissions![0]!
  controller.dispatch({
    type: "composer.fail",
    threadId: thread,
    clientMessageId: pending.id,
    reason: "offline",
  })
  expect(runtime.getSnapshot().blocks.length).toBe(before.blocks.length)
  expect(runtime.getSnapshot().blocks[0]).toBe(before.blocks[0])
  expect(
    runtime.getSnapshot().transcript.projectionById[pending.id],
  ).toBeUndefined()
  expect(counters.completePlanBuilds).toBe(0)
  runtime.dispose()
})

test("following deltas remain incremental while a steering echo is pending", () => {
  const { controller, runtime, thread, event, counters } =
    controllerWithHistory(1000)
  const active = turnId("active")
  event({ type: "turn.started", threadId: thread, turnId: active })
  event({
    type: "item.started",
    threadId: thread,
    item: {
      id: itemId("stream"),
      turnId: active,
      kind: "assistant",
      markdown: "First",
      status: "running",
    },
  })
  controller.changeDraft("steer", 5)
  controller.submit("steer")
  const before = counters.completePlanBuilds
  const pending =
    controller.getSnapshot().workspaces[thread]!.pendingSubmissions![0]!
  event({
    type: "item.delta",
    threadId: thread,
    itemId: itemId("stream"),
    delta: " second",
  })
  expect(counters.completePlanBuilds).toBe(before)
  expect(
    runtime.getSnapshot().transcript.projectionById["stream"]?.source,
  ).toBe("First second")
  expect(runtime.getSnapshot().blocks.at(-1)?.key).toMatchObject({
    itemId: pending.id,
  })
  runtime.dispose()
})

test("echo before turn admission uses the conservative rebuild and retains canonical content", () => {
  const { controller, runtime, thread, event, counters } =
    controllerWithHistory(100)
  controller.changeDraft("hello", 5)
  controller.submit("next-turn")
  const pending =
    controller.getSnapshot().workspaces[thread]!.pendingSubmissions![0]!
  event({
    type: "item.started",
    threadId: thread,
    item: {
      id: itemId("early-echo"),
      clientMessageId: pending.id,
      turnId: turnId("early"),
      kind: "user",
      markdown: "hello",
      status: "complete",
    },
  })
  expect(counters.completePlanBuilds).toBe(1)
  expect(runtime.getSnapshot().blocks.at(-1)?.key).toMatchObject({
    itemId: "early-echo",
  })
  expect(
    runtime.getSnapshot().transcript.projectionById[pending.id],
  ).toBeUndefined()
  runtime.dispose()
})

test("many send/echo cycles retain bounded height overlay depth with a safe rebuild", () => {
  const { controller, runtime, thread, event, counters } =
    controllerWithHistory(100)
  for (let i = 0; i < 130; i++) {
    controller.changeDraft("hello", 5)
    controller.submit("next-turn")
    const pending =
      controller.getSnapshot().workspaces[thread]!.pendingSubmissions![0]!
    const turn = turnId(`cycle-${i}`)
    event({ type: "turn.started", threadId: thread, turnId: turn })
    event({
      type: "item.started",
      threadId: thread,
      item: {
        id: itemId(`echo-${i}`),
        clientMessageId: pending.id,
        turnId: turn,
        kind: "user",
        markdown: "hello",
        status: "complete",
      },
    })
    controller.dispatch({
      type: "composer.ack",
      threadId: thread,
      clientMessageId: pending.id,
      turnId: turn,
    })
    event({
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "complete",
    })
    expect(runtime.getSnapshot().blocks.at(-1)?.key).toMatchObject({
      itemId: `echo-${i}`,
    })
  }
  expect(counters.completePlanBuilds).toBeLessThanOrEqual(2)
  expect(runtime.getSnapshot().blocks.length).toBe(231)
  runtime.dispose()
})

test("detached pending echo preserves its displayed snapshot until follow resumes", () => {
  const { controller, runtime, thread, event } = controllerWithHistory(100)
  controller.changeDraft("hello", 5)
  controller.submit("next-turn")
  const pending =
    controller.getSnapshot().workspaces[thread]!.pendingSubmissions![0]!
  const first = runtime.getSnapshot().transcript.order[0]!
  controller.transcript({
    type: "viewport.anchor",
    point: { itemId: first, graphemeOffset: 0 },
    preferredScreenRow: 0,
  })
  const detached = runtime.getSnapshot()
  const nextTurn = turnId("next")
  event({ type: "turn.started", threadId: thread, turnId: nextTurn })
  event({
    type: "item.started",
    threadId: thread,
    item: {
      id: itemId("server-echo"),
      clientMessageId: pending.id,
      turnId: nextTurn,
      kind: "user",
      markdown: "hello",
      status: "complete",
    },
  })
  expect(runtime.getSnapshot().blocks === detached.blocks).toBe(true)
  expect(runtime.getSnapshot().displayedCanonicalRevision).toBe(
    detached.displayedCanonicalRevision,
  )
  expect(runtime.getSnapshot().transcript.viewport).toEqual(
    detached.transcript.viewport,
  )
  controller.transcript({ type: "viewport.tail" })
  expect(
    runtime.getSnapshot().transcript.projectionById[pending.id],
  ).toBeUndefined()
  expect(runtime.getSnapshot().blocks.at(-1)?.key).toMatchObject({
    itemId: "server-echo",
  })
  runtime.dispose()
})
function setup() {
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary,
  }).state
  const dispatch = (command: Parameters<typeof transitionWorkbench>[1]) => {
    state = transitionWorkbench(state, command).state
    return state.workspaces[id]!
  }
  dispatch({ type: "composer.change", text: "hello" })
  dispatch({
    type: "composer.submit",
    intent: "next-turn",
    clientMessageId: "message-1",
  })
  return { dispatch, workspace: () => state.workspaces[id]! }
}

test("submission publishes a navigable message without changing canonical conversation", () => {
  const { workspace } = setup()
  const current = workspace()
  expect(current.composer.text).toBe("")
  expect(current.conversation.turnIds).toHaveLength(0)
  expect(current.conversation.items["message-1"]).toBeUndefined()
  expect(current.transcript.projectionById["message-1"]?.source).toBe("hello")
  const conversation = submissionConversation(current)
  expect(submissionConversation(current)).toBe(conversation)
  const blocks = buildTranscriptBlocks({
    conversation,
    transcript: current.transcript,
  })
  expect(blocks).toHaveLength(1)
  expect(blocks[0]?.key).toMatchObject({ kind: "item", itemId: "message-1" })
})

for (const echoFirst of [true, false]) {
  test(`server echo reconciles exactly once (${echoFirst ? "echo" : "ack"} first)`, () => {
    const { dispatch, workspace } = setup()
    const ack = () =>
      dispatch({
        type: "composer.ack",
        threadId: id,
        clientMessageId: "message-1",
        turnId: turn,
      })
    if (echoFirst) dispatch({ type: "conversation.event", event: echo() })
    ack()
    expect(workspace().transcript.order).toEqual([
      itemId(echoFirst ? "server-message-1" : "message-1"),
    ])
    if (!echoFirst) {
      expect(workspace().pendingSubmissions).toHaveLength(1)
      dispatch({ type: "conversation.event", event: echo() })
    }
    dispatch({ type: "conversation.event", event: echo() })
    expect(workspace().pendingSubmissions).toHaveLength(0)
    expect(workspace().transcript.order).toEqual([itemId("server-message-1")])
    expect(submissionConversation(workspace())).toBe(workspace().conversation)
  })
}

test("failure removes the local entry and retry restores it once", () => {
  const { dispatch, workspace } = setup()
  dispatch({
    type: "composer.fail",
    threadId: id,
    clientMessageId: "message-1",
    reason: "offline",
  })
  expect(workspace().transcript.order).toHaveLength(0)
  expect(workspace().composer.outbox[0]?.status).toBe("failed")
  dispatch({ type: "composer.retry", clientMessageId: "message-1" })
  expect(workspace().transcript.order).toEqual([itemId("message-1")])
  expect(workspace().pendingSubmissions).toHaveLength(1)
})

test("an echo before turn.started keeps subsequent submissions serialized", () => {
  const { dispatch, workspace } = setup()
  dispatch({ type: "conversation.event", event: echo() })
  expect(workspace().composer.outbox[0]?.status).toBe("sending")
  dispatch({ type: "composer.change", text: "second" })
  dispatch({
    type: "composer.submit",
    intent: "next-turn",
    clientMessageId: "message-2",
  })
  dispatch({
    type: "composer.ack",
    threadId: id,
    clientMessageId: "message-1",
    turnId: turn,
  })
  expect(workspace().composer.outbox[0]?.status).toBe("queued")
  expect(workspace().pendingSubmissions).toHaveLength(0)
})

test("a new provisional thread shows its first message immediately and removes an unqueued draft", () => {
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary,
  }).state
  state = { ...state, provisionalThreadIds: [id] }
  state = transitionWorkbench(state, {
    type: "composer.change",
    text: "hello",
  }).state
  state = transitionWorkbench(state, {
    type: "composer.submit",
    intent: "next-turn",
    clientMessageId: "provisional-message",
  }).state
  expect(state.workspaces[id]!.transcript.order).toEqual([
    itemId("provisional-message"),
  ])
  state = transitionWorkbench(state, {
    type: "composer.unqueue",
    clientMessageId: "provisional-message",
  }).state
  expect(state.workspaces[id]!.transcript.order).toHaveLength(0)
  expect(state.workspaces[id]!.composer.text).toBe("hello")
})

test("image-only submissions have a visible local message", () => {
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary,
  }).state
  state = transitionWorkbench(state, {
    type: "composer.image.attach",
    image: { id: "image", label: "image.png", path: "/tmp/image.png" },
  }).state
  state = transitionWorkbench(state, {
    type: "composer.submit",
    intent: "next-turn",
    clientMessageId: "image-message",
  }).state
  expect(
    state.workspaces[id]!.transcript.projectionById["image-message"]?.source,
  ).toBe("[Image 1]")
})

test("queued next turns remain queued until they are actually sent", () => {
  const { dispatch, workspace } = setup()
  dispatch({ type: "composer.change", text: "second" })
  dispatch({
    type: "composer.submit",
    intent: "next-turn",
    clientMessageId: "message-2",
  })
  expect(workspace().pendingSubmissions).toHaveLength(1)
  expect(workspace().transcript.order).toEqual([itemId("message-1")])
  dispatch({
    type: "conversation.event",
    event: { type: "turn.started", threadId: id, turnId: turn },
  })
  dispatch({ type: "conversation.event", event: echo() })
  dispatch({
    type: "composer.ack",
    threadId: id,
    clientMessageId: "message-1",
    turnId: turn,
  })
  dispatch({
    type: "conversation.event",
    event: {
      type: "turn.completed",
      threadId: id,
      turnId: turn,
      outcome: "complete",
    },
  })
  expect(workspace().pendingSubmissions?.map((message) => message.id)).toEqual([
    "message-2",
  ])
  expect(workspace().transcript.order).toEqual([
    itemId("server-message-1"),
    itemId("message-2"),
  ])
})

test("controller publishes the local frame before invoking a delayed server", async () => {
  let resolve!: (events: readonly ConversationEvent[]) => void
  let sentId = ""
  const response = new Promise<readonly ConversationEvent[]>((done) => {
    resolve = done
  })
  let controller: VimexController
  const startTurn: ConversationGateway["startTurn"] = (
    _thread,
    _text,
    messageId,
  ) => {
    sentId = messageId
    expect(
      controller.transcriptRuntime("main")!.getSnapshot().blocks[0]?.key,
    ).toMatchObject({ kind: "item", itemId: messageId })
    return response
  }
  const ports: ControllerPorts = {
    conversation: { startTurn } as never,
    approvals: {} as never,
    connection: {} as never,
    models: {} as never,
    resolveDirectory: (_, path) => path,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
  }
  controller = new VimexController(ports)
  controller.dispatch({ type: "thread.open", summary })
  controller.dispatch({ type: "connection.changed", connection: "connected" })
  ;(controller as unknown as { loaded: Set<string> }).loaded.add(id)
  const runtime = controller.transcriptRuntime("main")!
  controller.changeDraft("hello", 5)
  expect(controller.submit("next-turn")).toBe(true)
  expect(runtime.getSnapshot().blocks).toHaveLength(1)
  expect(
    controller.getSnapshot().workspaces[id]!.conversation.turnIds,
  ).toHaveLength(0)
  resolve([{ type: "turn.started", threadId: id, turnId: turn }, echo(sentId)])
  await controller.settle()
  expect(
    runtime.getSnapshot().blocks.filter((block) => block.key.kind === "item"),
  ).toHaveLength(1)
  expect(
    controller.getSnapshot().workspaces[id]!.pendingSubmissions,
  ).toHaveLength(0)
})
