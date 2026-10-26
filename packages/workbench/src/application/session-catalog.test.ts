import { expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  threadId,
  type ConversationGateway,
  type ThreadSummary,
} from "@vimex/conversation"
import { VimexController } from "./workbench-controller"
import { transitionWorkbench } from "./reduce-workbench"
import { initialWorkbench } from "./workbench-state"

const summary = (id: string): ThreadSummary => ({
  id: threadId(id),
  title: id,
  cwd: "/tmp",
  model: "test",
  reasoningEffort: "high",
  status: "idle",
})
function harness(listThreads: ConversationGateway["listThreads"]) {
  const resumed: string[] = []
  const controller = new VimexController({
    conversation: {
      listThreads,
      startThread: async () => ({ summary: summary("active"), events: [] }),
      resumeThread: async (id) => {
        resumed.push(id)
        return { summary: summary(id), events: [] }
      },
      forkThread: async () => {
        throw new Error("Unexpected fork")
      },
      startTurn: async () => {
        throw new Error("Unexpected submit")
      },
      steerTurn: async () => {},
      interruptTurn: async () => {},
      renameThread: async () => {},
      updateSettings: async () => {},
    },
    connection: {
      connect: async () => {},
      restart: async () => {},
      subscribe: () => () => {},
      close: async () => {},
    },
    approvals: {} as never,
    models: {} as never,
    resolveDirectory: resolve,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
  })
  return { controller, resumed }
}

test("direct resume does not depend on catalog discovery", async () => {
  const h = harness(async () => {
    throw new Error("Catalog unavailable")
  })
  await h.controller.initialize("/tmp", undefined, "known")
  expect(h.resumed).toEqual(["known"])
  expect(h.controller.getSnapshot().activeThreadId).toBe(threadId("known"))
  await h.controller.close()
})

test("catalog page publishes atomically and completion does not replay stale page summaries", async () => {
  const page = Array.from({ length: 100 }, (_, index) =>
    summary(`session-${index}`),
  )
  const gate = Promise.withResolvers<readonly ThreadSummary[]>()
  let publish!: (rows: readonly ThreadSummary[]) => void
  const h = harness(async (onPage) => {
    publish = onPage!
    return gate.promise
  })
  await h.controller.initialize("/tmp")
  h.controller.dispatchInteraction({
    type: "overlay.open",
    overlay: "sessions",
  })
  let publications = 0
  const stop = h.controller.subscribe(() => {
    publications++
  })
  publish(page)
  expect(publications).toBe(1)
  expect(h.controller.getSnapshot().threadOrder).toHaveLength(101)
  h.controller.dispatch({
    type: "thread.summary.patch",
    threadId: page[0]!.id,
    patch: { status: "working" },
  })
  gate.resolve(page.map((row) => ({ ...row })))
  await h.controller.settle()
  expect(h.controller.getSnapshot().summaries[page[0]!.id]!.status).toBe(
    "working",
  )
  stop()
  await h.controller.close()
})

test("batch registration preserves workspaces and deduplicates order", () => {
  const first = summary("one")
  const initial = transitionWorkbench(initialWorkbench(), {
    type: "thread.register",
    summary: first,
  }).state
  const next = transitionWorkbench(initial, {
    type: "threads.register",
    summaries: [{ ...first, title: "Updated" }, summary("two"), summary("two")],
  }).state
  expect(next.threadOrder).toEqual([threadId("one"), threadId("two")])
  expect(next.workspaces.one).toBe(initial.workspaces.one)
  expect(initial.summaries.one!.title).toBe("one")
  expect(next.summaries.one!.title).toBe("Updated")
})

test("duplicate page rows preserve named titles and known capabilities", async () => {
  const named = {
    ...summary("duplicate"),
    title: "Named",
    titleSource: "name" as const,
    canAcceptDirectInput: false,
  }
  const untitled = { ...summary("duplicate"), titleSource: "untitled" as const }
  const h = harness(async (onPage) => {
    onPage?.([named, untitled])
    return [named, untitled]
  })
  await h.controller.initialize("/tmp")
  h.controller.dispatchInteraction({
    type: "overlay.open",
    overlay: "sessions",
  })
  await h.controller.settle()
  const row = h.controller.getSnapshot().summaries.duplicate!
  expect(row.title).toBe("Named")
  expect(row.titleSource).toBe("name")
  expect(row.canAcceptDirectInput).toBe(false)
  expect(
    h.controller.getSnapshot().threadOrder.filter((id) => id === "duplicate"),
  ).toHaveLength(1)
  await h.controller.close()
})
