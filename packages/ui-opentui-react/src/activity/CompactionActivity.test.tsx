import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useSyncExternalStore } from "react"
import {
  threadId,
  turnId,
  type ConversationGateway,
  type ThreadSummary,
} from "@vimex/conversation"
import {
  VimexController,
  type RuntimeConnection,
  type RuntimeEvent,
} from "@vimex/workbench"
import { VimexRoot } from "../index"

const parent = threadId("compact-parent"),
  child = threadId("compact-side")
async function harness() {
  let emit: (event: RuntimeEvent) => void = () => {}
  let acknowledge!: () => void
  const summary = (id = parent): ThreadSummary => ({
    id,
    title: id === parent ? "Parent" : "Side",
    cwd: "/work",
    model: "test",
    reasoningEffort: "medium",
    status: "idle",
  })
  const runtime: ConversationGateway & RuntimeConnection = {
    connect: async () => {},
    restart: async () => {},
    close: async () => {},
    subscribe: (listener) => {
      emit = listener
      return () => {}
    },
    compactThread: () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve
      }),
    listThreads: async () => [summary()],
    startThread: async () => ({ summary: summary(), events: [] }),
    resumeThread: async (id) => ({ summary: summary(id), events: [] }),
    forkSideThread: async () => ({ summary: summary(child), events: [] }),
    forkThread: async () => ({ summary: summary(child), events: [] }),
    retireThread: async () => {},
    startTurn: async () => [],
    steerTurn: async () => {},
    interruptTurn: async () => {},
    renameThread: async () => {},
    updateSettings: async () => {},
  }
  const controller = new VimexController({
    conversation: runtime,
    connection: runtime,
    approvals: { resolveApproval: async () => {} },
    models: { listModels: async () => [] },
    resolveDirectory: (value) => value,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
  })
  await controller.initialize("/work")
  function Harness() {
    const state = useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
    )
    return <VimexRoot state={state} controller={controller} />
  }
  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    setup = await testRender(<Harness />, { width: 140, height: 30 })
    await setup.flush()
    await setup.renderOnce()
  })
  const update = async (operation: () => void) =>
    act(async () => {
      operation()
      await setup.flush()
      await setup.renderOnce()
    })
  const ack = async () => {
    await update(() => acknowledge())
    await controller.settle()
    await update(() => {})
  }
  const compact = () => update(() => controller.executeNamedCommand("compact"))
  return {
    ...setup,
    controller,
    update,
    compact,
    ack,
    emit: (event: RuntimeEvent) => emit(event),
    close: async () => {
      await act(async () => setup.renderer.destroy())
      await controller.close()
    },
  }
}

test("native Compacting heartbeat survives request acknowledgement and stops on completion/error/disconnect", async () => {
  const h = await harness()
  try {
    await h.compact()
    const first = h.captureCharFrame()
    expect(first).toContain("Compacting")
    await h.ack()
    expect(h.captureCharFrame()).toContain("Compacting")
    await act(async () => {
      await Bun.sleep(150)
    })
    await h.update(() => {})
    expect(h.captureCharFrame()).not.toBe(first)
    const turn = turnId("compact-turn")
    await h.update(() => {
      h.emit({
        type: "conversation",
        event: { type: "turn.started", threadId: parent, turnId: turn },
      })
      h.emit({
        type: "compaction",
        phase: "started",
        threadId: parent,
        turnId: turn,
      })
      h.emit({
        type: "conversation",
        event: {
          type: "turn.completed",
          threadId: parent,
          turnId: turn,
          outcome: "complete",
        },
      })
    })
    expect(h.captureCharFrame()).not.toContain("Compacting")
    await h.compact()
    await h.ack()
    await h.update(() =>
      h.emit({
        type: "compaction",
        phase: "failed",
        threadId: parent,
        error: "Context limit error",
      }),
    )
    expect(h.captureCharFrame()).not.toContain("Compacting")
    expect(h.controller.getSnapshot().error).toBe("Context limit error")
    await h.compact()
    await h.ack()
    await h.update(() =>
      h.emit({ type: "disconnected", message: "Runtime disconnected" }),
    )
    expect(h.captureCharFrame()).not.toContain("Compacting")
  } finally {
    await h.close()
  }
})

test("parent compaction remains visible and animated while side chat is focused", async () => {
  const h = await harness()
  try {
    await h.compact()
    await h.ack()
    await h.update(() => h.controller.executeNamedCommand("side"))
    await h.controller.settle()
    await h.update(() => {})
    expect(h.controller.getSnapshot().activeThreadId).toBe(child)
    const frame = h.captureCharFrame()
    expect(frame).toContain("SIDE · focused")
    const main = h.renderer.root.findDescendantById("main-pane")!
    const side = h.renderer.root.findDescendantById("side-pane")!
    expect(main).toBeDefined()
    const rows = frame.split("\n")
    expect(
      rows.map((row) => row.slice(main.x, main.x + main.width)).join("\n"),
    ).toContain("Compacting")
    expect(
      rows.map((row) => row.slice(side.x, side.x + side.width)).join("\n"),
    ).not.toContain("Compacting")
    await act(async () => {
      await Bun.sleep(150)
    })
    await h.update(() => {})
    expect(h.captureCharFrame()).not.toBe(frame)
    await h.update(() =>
      h.emit({
        type: "compaction",
        phase: "completed",
        threadId: parent,
        turnId: turnId("background-compact"),
      }),
    )
    expect(h.captureCharFrame()).not.toContain("Compacting")
  } finally {
    await h.close()
  }
})
