import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useSyncExternalStore } from "react"
import {
  itemId,
  threadId,
  turnId,
  type ConversationGateway,
} from "@vimex/conversation"
import type { ApprovalGateway } from "@vimex/approvals"
import {
  VimexController,
  type ModelCatalog,
  type RuntimeConnection,
  type RuntimeEvent,
} from "@vimex/workbench"
import { VimexRoot } from "../index"

const thread = threadId("visual-thread")
const answer = itemId("visual-answer")

async function visualHarness() {
  let emit: (event: RuntimeEvent) => void = () => {}
  const copied: string[] = []
  const interrupted: { thread: string; turn: string }[] = []
  const summary = {
    id: thread,
    title: "Visual interaction",
    cwd: "/work",
    model: "test",
    reasoningEffort: "high",
    status: "idle" as const,
  }
  const runtime: ConversationGateway &
    ApprovalGateway &
    RuntimeConnection &
    ModelCatalog = {
    connect: async () => {},
    restart: async () => {},
    close: async () => {},
    subscribe(listener) {
      emit = listener
      return () => {
        emit = () => {}
      }
    },
    listThreads: async () => [summary],
    startThread: async () => ({ summary, events: [] }),
    resumeThread: async () => ({ summary, events: [] }),
    forkThread: async () => ({ summary, events: [] }),
    startTurn: async () => [],
    steerTurn: async () => {},
    interruptTurn: async (thread, turn) => {
      interrupted.push({ thread, turn })
    },
    updateSettings: async () => {},
    renameThread: async () => {},
    resolveApproval: async () => {},
    listModels: async () => [],
  }
  const controller = new VimexController({
    conversation: runtime,
    approvals: runtime,
    connection: runtime,
    models: runtime,
    resolveDirectory: (value) => value,
    clipboard: {
      writeText: async (text) => {
        copied.push(text)
      },
    },
    openUrl: async () => {},
    quit() {},
  })
  await controller.initialize("/work")
  emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: thread,
      item: {
        id: answer,
        turnId: turnId("visual-turn"),
        kind: "assistant",
        markdown:
          "Alpha **bold** text.\n\nSecond line with a [link](https://example.com).",
        status: "running",
      },
    },
  })
  function Harness() {
    const state = useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
    )
    return <VimexRoot state={state} controller={controller} />
  }
  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    setup = await testRender(<Harness />, { width: 80, height: 24 })
    await setup.flush()
  })
  for (
    let count = 0;
    count < 20 && !setup.captureCharFrame().includes("Alpha bold text.");
    count++
  ) {
    await act(async () => {
      await Bun.sleep(5)
      await setup.flush()
      await setup.renderOnce()
    })
  }
  expect(setup.captureCharFrame()).toContain("Alpha bold text.")
  const workspace = () => controller.getSnapshot().workspaces[thread]!
  const keys = async (value: string) => {
    await act(async () => {
      await setup.mockInput.typeText(value)
      await setup.flush()
    })
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
  }
  const close = async () => {
    await act(async () => setup.renderer.destroy())
    await controller.close()
  }
  return {
    ...setup,
    controller,
    copied,
    interrupted,
    emit: (event: RuntimeEvent) => {
      emit(event)
      void controller.settle()
    },
    workspace,
    keys,
    close,
  }
}

test("brace browsing preserves compact tool groups in both directions and explicit targets reveal output", async () => {
  const h = await visualHarness()
  const first = itemId("browse-tool-a"),
    second = itemId("browse-tool-b"),
    after = itemId("browse-after")
  try {
    await act(async () => {
      for (const id of [first, second])
        h.emit({
          type: "conversation",
          event: {
            type: "item.started",
            threadId: thread,
            item: {
              id,
              turnId: turnId("visual-turn"),
              kind: "tool",
              title: "Web search",
              detail: `First result ${id}\n\nSecond result https://example.org/${id}`,
              activity: { family: "web-research" },
              status: "complete",
            },
          },
        })
      h.emit({
        type: "conversation",
        event: {
          type: "item.started",
          threadId: thread,
          item: {
            id: after,
            turnId: turnId("visual-turn"),
            kind: "assistant",
            markdown: "After tools",
            status: "complete",
          },
        },
      })
      await h.controller.settle()
      for (const id of [first, second])
        h.controller.transcript({ type: "fold.set", itemId: id, folded: true })
      h.controller.dispatchInteraction({ type: "mode.normal" })
      h.controller.dispatchInteraction({
        type: "focus.set",
        surface: "transcript",
      })
      h.controller.transcript({
        type: "cursor.move",
        target: { itemId: answer, graphemeOffset: 20 },
        preferredScreenRow: 0,
        extend: false,
      })
      await h.flush()
    })
    const frame = () => h.controller.transcriptRuntime("main")!.getSnapshot()
    const compact = () =>
      Object.values(frame().window.activityPresentation).filter(
        (p) => p.kind === "activity-lead",
      ).length
    expect(compact()).toBe(1)
    // First assistant has two paragraphs; start at its final paragraph.
    await h.keys("}")
    expect(h.workspace().transcript.cursor).toEqual({
      itemId: first,
      graphemeOffset: 0,
    })
    expect(h.workspace().transcript.folded[first]).toBe(true)
    expect(compact()).toBe(1)
    await h.keys("}")
    expect(h.workspace().transcript.cursor?.itemId).toBe(after)
    await h.keys("{")
    expect(h.workspace().transcript.cursor).toEqual({
      itemId: first,
      graphemeOffset: 0,
    })
    expect(h.workspace().transcript.folded[second]).toBe(true)
    expect(compact()).toBe(1)
    await h.keys("{")
    expect(h.workspace().transcript.cursor?.itemId).toBe(answer)
    expect(compact()).toBe(1)
    await h.keys("2}")
    expect(h.workspace().transcript.cursor?.itemId).toBe(after)
    expect(compact()).toBe(1)

    await act(async () => {
      h.controller.transcript({
        type: "search",
        query: `Second result https://example.org/${second}`,
        direction: "backward",
      })
      await h.flush()
    })
    expect(h.workspace().transcript.cursor?.itemId).toBe(second)
    expect(h.workspace().transcript.cursor!.graphemeOffset).toBeGreaterThan(0)
    expect(h.workspace().transcript.folded[second]).toBe(false)
    expect(compact()).toBe(0)
    await act(async () => {
      h.controller.transcript({
        type: "fold.set",
        itemId: second,
        folded: true,
      })
      h.controller.transcript({
        type: "cursor.move",
        target: { itemId: after, graphemeOffset: 0 },
        preferredScreenRow: 0,
        extend: false,
      })
      h.controller.transcript({ type: "navigate", motion: "url-previous" })
      await h.flush()
    })
    expect(h.workspace().transcript.cursor?.itemId).toBe(second)
    expect(h.workspace().transcript.folded[second]).toBe(false)
    // URL is within the last paragraph: return to its beginning, then header.
    await h.keys("2{")
    expect(h.workspace().transcript.cursor).toEqual({
      itemId: second,
      graphemeOffset: 0,
    })
    await h.keys("}")
    expect(h.workspace().transcript.cursor!.graphemeOffset).toBeGreaterThan(0)
  } finally {
    await h.close()
  }
})
