import { expect, test } from "bun:test"
import {
  itemId,
  threadId,
  type BackgroundTerminal,
  type ConversationGateway,
  type ThreadSummary,
} from "@vimex/conversation"
import { VimexController } from "./workbench-controller"

const summary = (id: string): ThreadSummary => ({
  id: threadId(id),
  title: id,
  cwd: "/work",
  model: "test",
  reasoningEffort: "high",
  status: "idle",
})
const terminal = (owner: string, processId: string): BackgroundTerminal => ({
  threadId: threadId(owner),
  itemId: itemId(`item-${processId}`),
  processId,
  command: "bun test",
  cwd: "/work",
  osPid: 123,
  cpuPercent: null,
  rssKb: null,
})

test("ps lists parent and child terminals and stops only the selected owner's process", async () => {
  const listed: string[] = []
  const stopped: string[] = []
  const rows = [terminal("parent", "p1"), terminal("child", "p2")]
  const conversation = {
    async listBackgroundTerminals(id: string) {
      listed.push(id)
      return rows.filter((row) => row.threadId === id)
    },
    async terminateBackgroundTerminal(id: string, processId: string) {
      stopped.push(`${id}:${processId}`)
      rows.splice(
        rows.findIndex(
          (row) => row.threadId === id && row.processId === processId,
        ),
        1,
      )
      return true
    },
  } as unknown as ConversationGateway
  const controller = new VimexController({
    conversation,
    approvals: {} as never,
    connection: {} as never,
    models: {} as never,
    resolveDirectory: (_, path) => path,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
  })
  controller.dispatch({ type: "thread.open", summary: summary("parent") })
  controller.dispatch({ type: "thread.register", summary: summary("child") })
  controller.dispatch({
    type: "agent.link",
    link: {
      parentId: threadId("parent"),
      childId: threadId("child"),
      itemId: itemId("spawn"),
      relation: "spawned",
    },
  })
  controller.executeNamedCommand("ps")
  await controller.settle()
  expect(controller.getSnapshot().backgroundTerminals.rows).toEqual(rows)
  expect(listed).toEqual(["parent", "child"])
  expect(controller.getSnapshot().workspaces.parent?.interaction.overlay).toBe(
    "processes",
  )
  controller.stopBackgroundTerminal(threadId("child"), "p2")
  await controller.settle()
  expect(stopped).toEqual(["child:p2"])
  expect(controller.getSnapshot().backgroundTerminals.rows).toEqual([
    terminal("parent", "p1"),
  ])
})
test("bare stop terminates every listed background terminal", async () => {
  const stopped: string[] = []
  const rows = [terminal("parent", "p1"), terminal("parent", "p2")]
  const conversation = {
    async listBackgroundTerminals() {
      return rows
    },
    async terminateBackgroundTerminal(id: string, processId: string) {
      stopped.push(`${id}:${processId}`)
      return true
    },
  } as unknown as ConversationGateway
  const controller = new VimexController({
    conversation,
    approvals: {} as never,
    connection: {} as never,
    models: {} as never,
    resolveDirectory: (_, path) => path,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
  })
  controller.dispatch({ type: "thread.open", summary: summary("parent") })
  controller.executeNamedCommand("ps")
  await controller.settle()
  controller.executeNamedCommand("stop")
  await controller.settle()
  expect(stopped).toEqual(["parent:p1", "parent:p2"])
})
