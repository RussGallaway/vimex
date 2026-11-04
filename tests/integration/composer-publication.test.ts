import { expect, test } from "bun:test"
import {
  VimexController,
  type RuntimeEvent,
  type RuntimeConnection,
} from "@vimex/workbench"
import {
  threadId,
  turnId,
  type ConversationGateway,
  type ThreadSummary,
} from "@vimex/conversation"

const id = threadId("composer-session"),
  other = threadId("other-session"),
  turn = turnId("compact-turn")
const summary = (value = id): ThreadSummary => ({
  id: value,
  title: value,
  cwd: "/tmp",
  model: "test",
  reasoningEffort: "medium",
  status: "idle",
})
async function harness() {
  let listener: (event: RuntimeEvent) => void = () => {}
  const published: string[] = [],
    requests: string[] = [],
    sends: string[] = [],
    steers: string[] = []
  const runtime: ConversationGateway & RuntimeConnection = {
    connect: async () => {},
    restart: async () => {},
    close: async () => {},
    subscribe: (fn) => {
      listener = fn
      return () => {}
    },
    listThreads: async () => [summary(), summary(other)],
    startThread: async () => ({ summary: summary(), events: [] }),
    resumeThread: async (value) => ({ summary: summary(value), events: [] }),
    forkThread: async () => ({ summary: summary(other), events: [] }),
    compactThread: async (value) => {
      requests.push(value)
    },
    startTurn: async (_, text) => {
      sends.push(text)
      return []
    },
    steerTurn: async (_, __, text) => {
      steers.push(text)
    },
    interruptTurn: async () => {},
    renameThread: async () => {},
    updateSettings: async () => {},
  }
  const controller = new VimexController({
    conversation: runtime,
    connection: runtime,
    models: { listModels: async () => [] },
    resolveDirectory: (_, path) => path,
    approvals: { resolveApproval: async () => {} },
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit: () => {},
    onLocalState(state) {
      published.push(state.threads[id]?.draft ?? "")
    },
  })
  await controller.initialize("/tmp")
  return {
    controller,
    runtime,
    requests,
    published,
    sends,
    steers,
    emit: (event: RuntimeEvent) => listener(event),
  }
}

test("native draft edits are authoritative immediately and coalesce pane/persistence publication", async () => {
  const h = await harness()
  let notifications = 0
  const unsubscribe = h.controller.subscribePresentation(
    "main",
    () => notifications++,
  )
  h.published.length = 0
  try {
    for (const text of ["a", "ab", "abc"])
      h.controller.changeDraft(text, text.length, "deferred")
    expect(h.controller.getSnapshot().workspaces[id]?.composer.text).toBe("abc")
    expect(
      h.controller.getPresentationSnapshot("main").workspaces[id]?.composer
        .text,
    ).toBe("")
    expect(notifications).toBe(0)
    expect(h.published).toEqual([])
    h.controller.flushDraft()
    expect(notifications).toBe(1)
    expect(h.published).toEqual(["abc"])
    expect(
      h.controller.getPresentationSnapshot("main").workspaces[id]?.composer
        .text,
    ).toBe("abc")
    h.controller.flushDraft()
    expect(notifications).toBe(1)
  } finally {
    unsubscribe()
    await h.controller.close()
  }
})

test("submit consumes the newest unpublished draft exactly once", async () => {
  const h = await harness()
  try {
    h.controller.changeDraft("newest input", 12, "deferred")
    expect(h.controller.submit("next-turn")).toBe(true)
    h.controller.changeDraft("next draft", 10, "deferred")
    await h.controller.settle()
    expect(h.sends).toEqual(["newest input"])
    expect(h.controller.getSnapshot().workspaces[id]?.composer.text).toBe(
      "next draft",
    )
  } finally {
    await h.controller.close()
  }
})

test("switching sessions preserves unpublished source edits without applying them to the destination", async () => {
  const h = await harness()
  try {
    h.controller.changeDraft("source draft", 12, "deferred")
    h.controller.openThread(other)
    await h.controller.settle()
    expect(h.controller.getSnapshot().activeThreadId).toBe(other)
    expect(h.controller.getSnapshot().workspaces[id]?.composer.text).toBe(
      "source draft",
    )
    expect(h.controller.getSnapshot().workspaces[other]?.composer.text).toBe("")
    expect(h.published).toContain("source draft")
  } finally {
    await h.controller.close()
  }
})

test("shutdown persists the latest native draft without waiting for a renderer", async () => {
  const h = await harness()
  h.controller.changeDraft("save before closing", 19, "deferred")
  await h.controller.close()
  expect(h.published.at(-1)).toBe("save before closing")
})

test("fallback publication is bounded and cannot restore an overwritten draft", async () => {
  const h = await harness()
  try {
    h.controller.changeDraft("native", 6, "deferred")
    await Bun.sleep(80)
    expect(
      h.controller.getPresentationSnapshot("main").workspaces[id]?.composer
        .text,
    ).toBe("native")
    h.controller.changeDraft("older", 5, "deferred")
    h.controller.changeDraft("replacement", 11)
    await Bun.sleep(80)
    expect(
      h.controller.getPresentationSnapshot("main").workspaces[id]?.composer
        .text,
    ).toBe("replacement")
  } finally {
    await h.controller.close()
  }
})
