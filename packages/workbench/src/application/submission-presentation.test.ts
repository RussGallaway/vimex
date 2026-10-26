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
import { initialWorkbench } from "./workbench-state"
import { submissionConversation } from "./submission-presentation"
import { buildTranscriptBlocks } from "@vimex/transcript"

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
