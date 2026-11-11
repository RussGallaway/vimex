import { expect, test } from "bun:test"
import { threadId } from "@vimex/conversation"
import { VimexController, type ControllerPorts } from "./workbench-controller"
import {
  captureLocalState,
  emptyLocalState,
  type SavedThreadView,
} from "./local-state"
import { createWorkspace, initialWorkbench } from "./workbench-state"

test("a provisional checkpoint hydrates unsent work without submitting it", async () => {
  const saved: SavedThreadView = {
    draft: "offline draft",
    cursorOffset: 4,
    folded: {},
    viewport: { kind: "tail" },
    surface: "composer",
    outbox: [
      {
        id: "uncertain",
        text: "previous send",
        intent: "next-turn",
        status: "sending",
      },
    ],
  }
  // This test never connects. Any eager backend use must fail.
  const unused = new Proxy(
    {},
    {
      get() {
        throw new Error("Unexpected backend access")
      },
    },
  )
  const controller = new VimexController({
    conversation: unused as ControllerPorts["conversation"],
    approvals: unused as ControllerPorts["approvals"],
    connection: {
      connect: async () => {},
      restart: async () => {},
      close: async () => {},
      subscribe: () => () => {},
    },
    models: unused as ControllerPorts["models"],
    resolveDirectory: (_base, path) => path,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
  })
  controller.prepareDraft("/new-directory", "model", saved)
  const state = controller.getSnapshot()
  const id = state.activeThreadId!
  expect(state.summaries[id]?.cwd).toBe("/new-directory")
  expect(state.workspaces[id]?.composer.text).toBe("offline draft")
  expect(state.workspaces[id]?.composer.outbox[0]?.status).toBe("failed")
  await controller.close()
})

test("binding a provisional workspace removes its obsolete saved identity", () => {
  const provisional = threadId("local-provisional")
  const bound = threadId("actual-thread")
  const before = {
    ...initialWorkbench(),
    provisionalThreadIds: [provisional],
    workspaces: { [provisional]: createWorkspace(provisional) },
  }
  const previous = captureLocalState(before, emptyLocalState())
  const after = {
    ...before,
    provisionalThreadIds: [],
    workspaces: { [bound]: createWorkspace(bound) },
  }
  const saved = captureLocalState(after, previous, before)
  expect(saved.threads[provisional]).toBeUndefined()
  expect(saved.threads[bound]).toBeDefined()
})
