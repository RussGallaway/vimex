import { expect, test } from "bun:test"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, useSyncExternalStore } from "react"
import { itemId, threadId, turnId, type ConversationGateway } from "@vimex/conversation"
import type { ApprovalGateway } from "@vimex/approvals"
import { VimexController, type ModelCatalog, type RuntimeConnection, type RuntimeEvent } from "@vimex/workbench"
import { VimexRoot } from "../index"

const thread = threadId("wheel-thread")
const answer = itemId("wheel-answer")

async function wheelHarness() {
  let emit: (event: RuntimeEvent) => void = () => {}
  const summary = { id: thread, title: "Wheel interaction", cwd: "/work", model: "test", reasoningEffort: "high", status: "idle" as const }
  const runtime: ConversationGateway & ApprovalGateway & RuntimeConnection & ModelCatalog = {
    connect: async () => {}, restart: async () => {}, close: async () => {},
    subscribe(listener) { emit = listener; return () => { emit = () => {} } },
    listThreads: async () => [summary], startThread: async () => ({ summary, events: [] }), resumeThread: async () => ({ summary, events: [] }),
    forkThread: async () => ({ summary, events: [] }), startTurn: async () => [], steerTurn: async () => {}, interruptTurn: async () => {},
    updateSettings: async () => {}, renameThread: async () => {}, resolveApproval: async () => {}, listModels: async () => [],
  }
  const controller = new VimexController({ conversation: runtime, approvals: runtime, connection: runtime, models: runtime,
    resolveDirectory: value => value, clipboard: { writeText: async () => {} }, openUrl: async () => {}, quit() {},
  })
  await controller.initialize("/work")
  emit({ type: "conversation", event: { type: "item.started", threadId: thread, item: {
    id: answer, turnId: turnId("wheel-turn"), kind: "assistant", markdown: Array.from({ length: 60 }, (_, index) => `Line ${index} readable output`).join("\n\n"), status: "running",
  } } })
  function Harness() {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    return <VimexRoot state={state} controller={controller} />
  }
  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => { setup = await testRender(<Harness />, { width: 80, height: 24 }); await setup.flush() })
  for (let count = 0; count < 20 && !setup.captureCharFrame().includes("Line 59 readable output"); count++) {
    await act(async () => { await Bun.sleep(5); await setup.flush(); await setup.renderOnce() })
  }
  expect(setup.captureCharFrame()).toContain("Line 59 readable output")
  const workspace = () => controller.getSnapshot().workspaces[thread]!
  const keys = async (value: string) => {
    await act(async () => { await setup.mockInput.typeText(value); await setup.flush() })
    await act(async () => { await setup.flush(); await setup.renderOnce() })
  }
  const close = async () => { await act(async () => setup.renderer.destroy()); await controller.close() }
  return { ...setup, controller, emit: (event: RuntimeEvent) => emit(event), workspace, keys, close }
}


for (const mode of ["normal", "insert", "visual"] as const) test(`native wheel preserves ${mode} composer, scrolls precise rows, and detaches tail`, async () => {
  const h = await wheelHarness()
  try {
    await act(async () => {
      h.controller.changeDraft("keep draft", 3)
      h.controller.dispatchInteraction({ type: "focus.set", surface: "composer" })
      await h.flush()
    })
    if (mode === "insert") await h.keys("i")
    if (mode === "visual") await h.keys("vl")
    const composer = h.renderer.root.findDescendantById("composer") as TextareaRenderable
    const scrollbox = h.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable
    const cursor = composer.cursorOffset
    const selection = composer.getSelectedText()
    const transcriptCursor = h.workspace().transcript.cursor
    const wheel = async (direction: "up" | "down", count = 1) => {
      await act(async () => {
        for (let i = 0; i < count; i++) await h.mockMouse.scroll(scrollbox.x + 10, scrollbox.y + 3, direction)
        await h.flush(); await h.renderOnce()
      })
      await act(async () => { await h.flush(); await h.renderOnce() })
    }
    const bottom = scrollbox.scrollTop
    expect(bottom).toBeGreaterThan(30)
    await wheel("up")
    expect(scrollbox.scrollTop).toBe(bottom - 1)
    await wheel("up", 8)
    expect(scrollbox.scrollTop).toBe(bottom - 9)
    expect(h.workspace().transcript.viewport.kind).toBe("point")
    expect(h.workspace().transcript.cursor).toEqual(transcriptCursor)
    expect(h.workspace().interaction).toMatchObject({ mode, surface: "composer" })
    expect(h.workspace().composer.text).toBe("keep draft")
    expect(composer.cursorOffset).toBe(cursor)
    expect(composer.getSelectedText()).toBe(selection)
    expect(composer.focused).toBe(true)
    await wheel("down", 15)
    expect(scrollbox.scrollTop).toBe(bottom)
    expect(h.workspace().transcript.viewport.kind).toBe("point")
    expect(scrollbox.stickyScroll).toBe(false)
    await act(async () => {
      h.emit({ type: "conversation", event: { type: "item.delta", threadId: thread, itemId: answer, delta: "\n\nNew streaming line\n\nAnother streaming line" } })
      await h.flush()
    })
    await act(async () => { await h.flush(); await h.renderOnce() })
    expect(scrollbox.scrollTop).toBe(bottom)
    expect(h.workspace().transcript.viewport.kind).toBe("point")
    await wheel("up", bottom + 5)
    expect(scrollbox.scrollTop).toBe(0)
    await wheel("down")
    expect(scrollbox.scrollTop).toBe(1)
  } finally { await h.close() }
})


test("wheel preserves transcript Visual selection and only explicit follow reattaches streaming", async () => {
  const h = await wheelHarness()
  try {
    await h.keys("ggvll")
    const selected = h.workspace().transcript.selection
    const cursor = h.workspace().transcript.cursor
    const scrollbox = h.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable
    await act(async () => {
      await h.mockMouse.scroll(scrollbox.x + 10, scrollbox.y + 3, "down")
      await h.flush(); await h.renderOnce()
    })
    await act(async () => { await h.flush(); await h.renderOnce() })
    expect(h.workspace().interaction).toMatchObject({ surface: "transcript", mode: "visual" })
    expect(h.workspace().transcript.selection).toEqual(selected)
    expect(h.workspace().transcript.cursor).toEqual(cursor)
    expect(h.workspace().transcript.viewport.kind).toBe("point")
    await act(async () => { h.controller.transcript({ type: "viewport.tail" }); await h.flush() })
    await act(async () => { await h.flush(); await h.renderOnce() })
    expect(scrollbox.stickyScroll).toBe(true)
    expect(h.workspace().transcript.viewport.kind).toBe("tail")
    const bottom = scrollbox.scrollTop
    await act(async () => {
      await h.mockMouse.scroll(scrollbox.x + 10, scrollbox.y + 3, "down")
      await h.flush(); await h.renderOnce()
    })
    await act(async () => { await h.flush(); await h.renderOnce() })
    expect(scrollbox.scrollTop).toBe(bottom)
    expect(scrollbox.stickyScroll).toBe(false)
    expect(h.workspace().transcript.viewport.kind).toBe("point")
  } finally { await h.close() }
})
