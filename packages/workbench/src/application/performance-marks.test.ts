import { expect, test } from "bun:test"
import {
  itemId,
  threadId,
  turnId,
  type ConversationGateway,
  type ThreadSummary,
} from "@vimex/conversation"
import type { RuntimeEvent } from "./runtime-connection"
import { VimexController, type ControllerPorts } from "./workbench-controller"

test("submission marks span state publication, successful request write, and server content", async () => {
  const id = threadId("profile-thread")
  const turn = turnId("profile-turn")
  const summary: ThreadSummary = {
    id,
    title: "Profile",
    cwd: "/tmp",
    model: "test",
    reasoningEffort: "high",
    status: "idle",
  }
  let receive: (event: RuntimeEvent) => void = () => {}
  const marks: Array<{ phase: string; operationId?: string; atMs: number }> = []
  const startTurn: ConversationGateway["startTurn"] = async (
    _id,
    _text,
    _messageId,
    _input,
    onRequestSent,
  ) => {
    onRequestSent?.()
    receive({
      type: "conversation",
      event: { type: "turn.started", threadId: id, turnId: turn },
    })
    receive({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: id,
        item: {
          id: itemId("answer"),
          turnId: turn,
          kind: "assistant",
          markdown: "hello",
          status: "running",
        },
      },
    })
    receive({
      type: "conversation",
      event: {
        type: "turn.completed",
        threadId: id,
        turnId: turn,
        outcome: "complete",
      },
    })
    return []
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
    onPerformanceMark(mark) {
      marks.push(mark)
      if (mark.phase === "accepted") throw new Error("observer failed")
    },
  }
  const controller = new VimexController(ports)
  receive = (
    controller as unknown as { receive(event: RuntimeEvent): void }
  ).receive.bind(controller)
  controller.dispatch({ type: "thread.open", summary })
  controller.dispatch({ type: "connection.changed", connection: "connected" })
  const loaded = (controller as unknown as { loaded: Set<string> }).loaded
  loaded.add(id)
  controller.changeDraft("hello", 5)
  expect(controller.submit("next-turn")).toBe(true)
  await controller.settle()
  expect(marks.map((mark) => mark.phase)).toEqual([
    "attempted",
    "accepted",
    "state_published",
    "adapter_start",
    "request_sent",
    "next_thread_activity",
    "next_thread_content",
    "next_thread_content_committed",
  ])
  expect(new Set(marks.map((mark) => mark.operationId)).size).toBe(1)
  expect(marks.every((mark) => Number.isFinite(mark.atMs))).toBe(true)
  expect(
    (controller as unknown as { pendingSubmitActivity: Map<string, unknown> })
      .pendingSubmitActivity.size,
  ).toBe(0)
})

test("navigation marks exclude non-navigation and unchanged transcript commands", () => {
  const marks: Array<
    Parameters<NonNullable<ControllerPorts["onPerformanceMark"]>>[0]
  > = []
  const controller = new VimexController({
    conversation: {} as never,
    approvals: {} as never,
    connection: {} as never,
    models: {} as never,
    resolveDirectory: (_, path) => path,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
    onPerformanceMark(mark) {
      marks.push(mark)
    },
  })
  controller.dispatch({
    type: "transcript.command",
    command: { type: "selection.clear" },
  })
  expect(marks).toEqual([])
  controller.performanceNavigationInput("line_up")
  controller.dispatch({
    type: "transcript.command",
    command: { type: "tail.attach" },
  })
  expect(marks.map((mark) => mark.phase)).toEqual(["input", "accepted"])
  expect(marks[0]?.operationId).toBe(marks[1]?.operationId)
  expect(marks[0]?.burstId).toBe(marks[1]?.burstId)
  expect(marks[0]?.burstId).toBeTruthy()
  expect(marks[0]?.detail?.action).toBe("line_up")
  controller.performanceNavigationInput("line_down")
  controller.dispatch({
    type: "transcript.command",
    command: { type: "tail.attach" },
  })
  expect(marks[2]?.burstId).toBe(marks[0]?.burstId)
  expect(marks[3]?.burstId).toBe(marks[0]?.burstId)
})

test("rejected submission records an attempt without acceptance or publication", () => {
  const phases: string[] = []
  const controller = new VimexController({
    conversation: {} as never,
    approvals: {} as never,
    connection: {} as never,
    models: {} as never,
    resolveDirectory: (_, path) => path,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
    onPerformanceMark(mark) {
      phases.push(mark.phase)
    },
  })
  controller.dispatch({
    type: "composer.submit",
    intent: "next-turn",
    clientMessageId: "rejected",
  })
  expect(phases).toEqual(["attempted"])
})
