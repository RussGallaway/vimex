import { expect, test } from "bun:test"
import {
  itemId,
  threadId,
  turnId,
  type ConversationItem,
} from "@vimex/conversation"
import { VimexController } from "./workbench-controller"

const thread = threadId("folded")
const turn = turnId("turn")
const tool = itemId("tool")
function harness() {
  const copied: string[] = []
  const controller = new VimexController({
    conversation: {} as never,
    approvals: {} as never,
    connection: {} as never,
    models: {} as never,
    resolveDirectory: (_, path) => path,
    clipboard: {
      writeText: async (text) => {
        copied.push(text)
      },
    },
    openUrl: async () => {},
    quit() {},
  })
  controller.dispatch({
    type: "thread.open",
    summary: {
      id: thread,
      title: "Folded",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  })
  controller.dispatch({
    type: "conversation.event",
    event: { type: "turn.started", threadId: thread, turnId: turn },
  })
  const items: ConversationItem[] = [
    {
      id: itemId("before"),
      turnId: turn,
      kind: "assistant",
      markdown: "before",
      status: "complete",
    },
    {
      id: tool,
      turnId: turn,
      kind: "command",
      title: "Tool summary",
      detail: "hidden details\nmore output",
      status: "complete",
    },
    {
      id: itemId("after"),
      turnId: turn,
      kind: "assistant",
      markdown: "after",
      status: "complete",
    },
  ]
  for (const item of items)
    controller.dispatch({
      type: "conversation.event",
      event: { type: "item.completed", threadId: thread, item },
    })
  controller.transcript({ type: "fold.set", itemId: tool, folded: true })
  controller.dispatchInteraction({ type: "focus.set", surface: "transcript" })
  const move = (id: string, offset = 0) =>
    controller.transcript({
      type: "cursor.move",
      target: { itemId: itemId(id), graphemeOffset: offset },
      preferredScreenRow: 0,
      extend: false,
    })
  const state = () => controller.getSnapshot().workspaces[thread]!
  return { controller, copied, move, state }
}

test("word navigation and first-content keep collapsed tool closed while extending Visual selection", () => {
  const h = harness()
  h.move("before")
  h.controller.transcript({ type: "selection.begin", shape: "character" })
  h.controller.dispatchInteraction({ type: "mode.visual" })
  h.controller.transcript({ type: "navigate", motion: "word-next" })
  expect(h.state().transcript.cursor).toEqual({
    itemId: tool,
    graphemeOffset: 0,
  })
  expect(h.state().transcript.folded[tool]).toBe(true)
  expect(h.state().transcript.selection?.head.itemId).toBe(tool)
  h.controller.transcript({ type: "navigate", motion: "first-content" })
  expect(h.state().transcript.folded[tool]).toBe(true)
  h.controller.transcript({ type: "navigate", motion: "word-next" })
  expect(h.state().transcript.cursor?.itemId).toBe(itemId("after"))
  expect(h.state().transcript.folded[tool]).toBe(true)
  expect(h.state().transcript.jumps.back).toHaveLength(0)
})

test("single folded plain copy accepts its visible summary without opening the tool", async () => {
  const h = harness()
  h.move("tool")
  h.controller.transcript({ type: "selection.begin", shape: "character" })
  h.controller.dispatchInteraction({ type: "mode.visual" })
  h.controller.transcript({
    type: "copy",
    format: "plain",
    presentationId: "main",
    renderedSummary: { itemId: tool, text: "Tool summary" },
  })
  await h.controller.settle()
  expect(h.copied).toEqual(["Tool summary"])
  expect(h.state().interaction.unnamedRegister.text).toBe("Tool summary")
  expect(h.state().transcript.folded[tool]).toBe(true)
})

for (const scenario of [
  "wrong-item",
  "source",
  "expanded",
  "cross-item",
] as const) {
  test(`rendered summary cannot override ${scenario} semantic copy`, async () => {
    const h = harness()
    h.move("tool")
    if (scenario === "expanded")
      h.controller.transcript({ type: "fold.set", itemId: tool, folded: false })
    h.controller.transcript({ type: "selection.begin", shape: "character" })
    h.controller.dispatchInteraction({ type: "mode.visual" })
    if (scenario === "cross-item") h.move("after")
    h.controller.transcript({
      type: "copy",
      format: scenario === "source" ? "source" : "plain",
      presentationId: "main",
      renderedSummary: {
        itemId: scenario === "wrong-item" ? itemId("after") : tool,
        text: "WRONG OVERRIDE",
      },
    })
    await h.controller.settle()
    expect(h.copied).toHaveLength(1)
    expect(h.copied[0]).not.toBe("WRONG OVERRIDE")
  })
}
