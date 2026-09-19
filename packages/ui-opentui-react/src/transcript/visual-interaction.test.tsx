import { measureRenderedTranscript, measuredPoint } from "./rendered-layout"
import { expect, test } from "bun:test"
import type { Renderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, useSyncExternalStore } from "react"
import { itemId, threadId, turnId, type ConversationGateway } from "@vimex/conversation"
import type { ApprovalGateway } from "@vimex/approvals"
import { VimexController, type ModelCatalog, type RuntimeConnection, type RuntimeEvent } from "@vimex/workbench"
import { graphemeCount, selectedText } from "@vimex/transcript"
import { VimexRoot } from "../index"
import { blockNativeRevision } from "./measure-rendered-block"

const thread = threadId("visual-thread")
const answer = itemId("visual-answer")

async function visualHarness() {
  let emit: (event: RuntimeEvent) => void = () => {}
  const copied: string[] = []
  const interrupted: { thread: string; turn: string }[] = []
  const summary = { id: thread, title: "Visual interaction", cwd: "/work", model: "test", reasoningEffort: "high", status: "idle" as const }
  const runtime: ConversationGateway & ApprovalGateway & RuntimeConnection & ModelCatalog = {
    connect: async () => {}, restart: async () => {}, close: async () => {},
    subscribe(listener) { emit = listener; return () => { emit = () => {} } },
    listThreads: async () => [summary], startThread: async () => ({ summary, events: [] }), resumeThread: async () => ({ summary, events: [] }),
    forkThread: async () => ({ summary, events: [] }), startTurn: async () => [], steerTurn: async () => {}, interruptTurn: async (thread, turn) => { interrupted.push({ thread, turn }) },
    updateSettings: async () => {}, renameThread: async () => {}, resolveApproval: async () => {}, listModels: async () => [],
  }
  const controller = new VimexController({ conversation: runtime, approvals: runtime, connection: runtime, models: runtime,
    resolveDirectory: value => value, clipboard: { writeText: async text => { copied.push(text) } }, openUrl: async () => {}, quit() {},
  })
  await controller.initialize("/work")
  emit({ type: "conversation", event: { type: "item.started", threadId: thread, item: {
    id: answer, turnId: turnId("visual-turn"), kind: "assistant", markdown: "Alpha **bold** text.\n\nSecond line with a [link](https://example.com).", status: "running",
  } } })
  function Harness() {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    return <VimexRoot state={state} controller={controller} />
  }
  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => { setup = await testRender(<Harness />, { width: 80, height: 24 }); await setup.flush() })
  for (let count = 0; count < 20 && !setup.captureCharFrame().includes("Alpha bold text."); count++) {
    await act(async () => { await Bun.sleep(5); await setup.flush(); await setup.renderOnce() })
  }
  expect(setup.captureCharFrame()).toContain("Alpha bold text.")
  const workspace = () => controller.getSnapshot().workspaces[thread]!
  const keys = async (value: string) => {
    await act(async () => { await setup.mockInput.typeText(value); await setup.flush() })
    await act(async () => { await setup.flush(); await setup.renderOnce() })
  }
  const close = async () => { await act(async () => setup.renderer.destroy()); await controller.close() }
  return { ...setup, controller, copied, interrupted, emit: (event: RuntimeEvent) => { emit(event); void controller.settle() }, workspace, keys, close }
}

test("Visual transcript selection survives streaming and resize, then yanks semantic text", async () => {
  const h = await visualHarness()
  try {
    await h.keys("gg")
    await h.keys("v")
    await h.keys("4l")
    expect(h.workspace().interaction.mode).toBe("visual")
    expect(selectedText(h.workspace().transcript, "plain")).toBe("Alpha")
    const selection = h.workspace().transcript.selection
    expect(h.renderer.getSelection()?.getSelectedText()).toBe("Alpha")
    await act(async () => {
      h.emit({ type: "conversation", event: { type: "item.delta", threadId: thread, itemId: answer, delta: "\n\nStreaming tail grows while reading." } })
      await h.flush()
    })
    expect(h.workspace().transcript.selection).toEqual(selection)
    await act(async () => { h.resize(48, 18); await h.flush(); await h.renderOnce() })
    expect(h.workspace().transcript.selection).toEqual(selection)
    expect(selectedText(h.workspace().transcript, "plain")).toBe("Alpha")
    expect(h.renderer.getSelection()?.getSelectedText()).toBe("Alpha")
    await h.keys("y")
    await h.controller.settle()
    expect(h.copied).toEqual(["Alpha"])
    expect(h.workspace().interaction.mode).toBe("normal")
    expect(h.workspace().transcript.selection).toBeUndefined()
  } finally { await h.close() }
})

test("Visual line copy omits Markdown syntax and focus exit clears semantic selection", async () => {
  const h = await visualHarness()
  try {
    await h.keys("gg")
    await h.keys("V")
    expect(h.workspace().transcript.selection?.shape).toBe("line")
    await h.keys("y")
    await h.controller.settle()
    expect(h.copied[0]).toBe("Alpha bold text.\n")
    await h.keys("v")
    await h.keys("ll")
    expect(h.workspace().transcript.selection).toBeDefined()
    await act(async () => { h.mockInput.pressKey("j", { ctrl: true }); await h.flush() })
    await act(async () => { await h.flush(); await h.renderOnce() })
    expect(h.workspace().interaction.surface).toBe("composer")
    expect(h.workspace().interaction.mode).toBe("normal")
    expect(h.workspace().transcript.selection).toBeUndefined()
    expect(h.renderer.getSelection()).toBeNull()
  } finally { await h.close() }
})

test("distant Visual selection clips native highlight to each bounded window", async () => {
  const h = await visualHarness()
  try {
    let selectionStarts = 0
    let selectionUpdates = 0
    const startSelection = h.renderer.startSelection.bind(h.renderer)
    const updateSelection = h.renderer.updateSelection.bind(h.renderer)
    h.renderer.startSelection = (...args) => { selectionStarts += 1; return startSelection(...args) }
    h.renderer.updateSelection = (...args) => { selectionUpdates += 1; return updateSelection(...args) }
    const ids = Array.from({ length: 100 }, (_, index) => itemId(`clip-${index}`))
    await act(async () => {
      ids.forEach((id, index) => h.emit({ type: "conversation", event: { type: "item.started", threadId: thread, item: {
        id, turnId: turnId(`clip-turn-${index}`), kind: "assistant", markdown: `clip row ${index}`, status: "complete",
      } } }))
      await h.controller.settle(); await h.flush(); await h.renderOnce()
    })
    const start = { itemId: ids[5]!, graphemeOffset: 0 }
    const end = { itemId: ids[95]!, graphemeOffset: 0 }
    await act(async () => {
      h.controller.transcript({ type: "cursor.move", target: start, preferredScreenRow: 2, extend: false })
      h.controller.transcript({ type: "selection.begin", shape: "character" })
      h.controller.dispatchInteraction({ type: "mode.visual" })
      h.controller.transcript({ type: "cursor.move", target: end, preferredScreenRow: 2, extend: true })
      await h.flush(); await h.renderOnce()
    })
    const nearEnd = h.renderer.getSelection()?.getSelectedText()
    expect(nearEnd).toBeTruthy()
    expect(nearEnd).toContain("clip row")

    await act(async () => {
      h.controller.transcript({ type: "selection.swap" })
      await h.flush(); await h.renderOnce()
    })
    for (let count = 0; count < 10 && !h.renderer.getSelection(); count++) await act(async () => {
      await Bun.sleep(5); await h.flush(); await h.renderOnce()
    })
    const swappedFrame = h.controller.transcriptRuntime("main")!.getSnapshot()
    expect(swappedFrame.transcript.selection).toEqual({ anchor: end, head: start, shape: "character" })
    expect(swappedFrame.transcript.viewport).toEqual({ kind: "point", point: start, preferredScreenRow: 2 })
    expect(swappedFrame.window.blocks.some(block => block.key.kind === "item" && block.key.itemId === start.itemId)).toBe(true)
    expect(swappedFrame.geometry.measuredBlockCount).toBeGreaterThan(0)
    const nearStart = h.renderer.getSelection()?.getSelectedText()
    expect(nearStart).toBeTruthy()
    expect(nearStart).toContain("clip row 5")
    expect(h.workspace().transcript.selection).toEqual({ anchor: end, head: start, shape: "character" })
    const semanticText = selectedText(h.workspace().transcript, "plain")!
    expect(h.captureCharFrame()).toContain(`${graphemeCount(semanticText)} selected`)

    const stableStarts = selectionStarts
    const stableUpdates = selectionUpdates
    for (let count = 0; count < 5; count++) await act(async () => { await h.flush(); await h.renderOnce() })
    expect(selectionStarts).toBe(stableStarts)
    expect(selectionUpdates).toBe(stableUpdates)

    await act(async () => {
      h.controller.transcript({ type: "selection.clear" })
      await h.flush(); await h.renderOnce()
    })
    expect(h.renderer.getSelection()).toBeNull()
  } finally { await h.close() }
})

test("transcript hardware cursor follows Normal motions, Visual head, resize and focus", async () => {
  const h = await visualHarness()
  try {
    await h.keys("gg")
    const first = h.renderer.getCursorState()
    expect(first.visible).toBe(true)
    expect(first.style).toBe("block")
    await h.keys("l")
    expect(h.renderer.getCursorState().x).toBe(first.x + 1)
    expect(h.renderer.getCursorState().y).toBe(first.y)
    await h.keys("h")
    expect(h.renderer.getCursorState().x).toBe(first.x)
    await h.keys("j")
    expect(h.renderer.getCursorState().y).toBeGreaterThan(first.y)
    await h.keys("k")
    expect(h.renderer.getCursorState().y).toBe(first.y)
    await h.keys("v")
    await h.keys("4l")
    expect(h.renderer.getCursorState().x).toBe(first.x + 4)
    expect(h.renderer.getCursorState().visible).toBe(true)
    await act(async () => { h.resize(48, 18); await h.flush(); await h.renderOnce() })
    const resized = h.renderer.getCursorState()
    expect(resized.visible).toBe(true)
    expect(resized.x).toBeLessThanOrEqual(48)
    expect(resized.y).toBeLessThan((h.renderer.root.findDescendantById("composer-shell")!).y + 1)
    await act(async () => { h.mockInput.pressKey("j", { ctrl: true }); await h.flush() })
    await act(async () => { await h.renderOnce() })
    expect(h.renderer.getCursorState().style).toBe("block")
    await h.keys("i")
    expect(h.renderer.getCursorState().style).toBe("line")
    await flashKey(h, "ESCAPE")
    expect(h.renderer.getCursorState().style).toBe("block")
    await h.keys("i")
    expect(h.renderer.getCursorState().style).toBe("line")
    const composer = h.renderer.root.findDescendantById("composer")!
    expect(h.renderer.getCursorState().y).toBeGreaterThanOrEqual(composer.y + 1)
    await act(async () => { h.mockInput.pressKey("k", { ctrl: true }); await h.flush() })
    await act(async () => { await h.flush(); await h.renderOnce() })
    expect(h.renderer.getCursorState().y).toBeLessThan(composer.y + 1)
    expect(h.renderer.getCursorState().style).toBe("block")
    await h.keys(":")
    const command = h.renderer.root.findDescendantById("command-line")!
    expect(h.renderer.getCursorState().y).toBe(command.y + 1)
  } finally { await h.close() }
})

test("batched vwwy observes each mode and motion before copying", async () => {
  const h = await visualHarness()
  try {
    await h.keys("gg")
    await act(async () => { await h.mockInput.pressKeys(["v", "w", "w", "y"], 0); await h.flush() })
    await h.controller.settle()
    expect(h.copied).toEqual(["Alpha bold t"])
    expect(h.workspace().interaction.mode).toBe("normal")
    expect(h.workspace().transcript.selection).toBeUndefined()
  } finally { await h.close() }
})


test("transcript cursor hides outside the viewport and yields to session search", async () => {
  const h = await visualHarness()
  try {
    await act(async () => {
      h.emit({ type: "conversation", event: { type: "item.delta", threadId: thread, itemId: answer, delta: "\n\n" + Array.from({ length: 40 }, (_, i) => `More output ${i}`).join("\n\n") } })
      await h.flush()
    })
    await act(async () => { await h.flush(); await h.renderOnce() })
    await h.keys("gg")
    const scrollbox = h.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable
    await act(async () => { scrollbox.scrollTo(scrollbox.scrollHeight); await h.flush(); await h.renderOnce() })
    expect(h.renderer.getCursorState().visible).toBe(false)
    await h.keys(" s")
    const search = h.renderer.root.findDescendantById("session-search")!
    const cursor = h.renderer.getCursorState()
    expect(cursor.visible).toBe(true)
    expect(cursor.y).toBe(search.y + 1)
    expect(cursor.x).toBeGreaterThanOrEqual(search.x + 1)
  } finally { await h.close() }
})

for (const [label, down, up] of [["raw Ctrl-J/K", "\n", "\x0b"], ["arrow keys", "\x1b[B", "\x1b[A"]] as const) {
test(`${label} change focus without scrolling or deleting the draft`, async () => {
  const h = await visualHarness()
  try {
    await act(async () => {
      h.controller.changeDraft("keep this draft", 4)
      h.emit({ type: "conversation", event: { type: "item.delta", threadId: thread, itemId: answer, delta: "\n\n" + Array.from({ length: 40 }, (_, i) => `More output ${i}`).join("\n\n") } })
      await h.flush()
    })
    await act(async () => { await h.flush(); await h.renderOnce() })
    await h.keys("gg")
    const scrollbox = h.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable
    await act(async () => { scrollbox.scrollTo(8); await h.flush(); await h.renderOnce() })
    const before = scrollbox.scrollTop
    expect(before).toBeGreaterThan(0)
    await act(async () => { h.mockInput.pressKey(down); await h.flush() })
    await act(async () => { await h.flush(); await h.renderOnce() })
    expect(h.workspace().interaction.surface).toBe("composer")
    expect(scrollbox.scrollTop).toBe(before)
    await act(async () => { h.mockInput.pressKey(up); await h.flush() })
    await act(async () => { await h.flush(); await h.renderOnce() })
    expect(h.workspace().interaction.surface).toBe("transcript")
    expect(scrollbox.scrollTop).toBe(before)
    await act(async () => { h.mockInput.pressKey(down); await h.flush() })
    await h.keys("i")
    await act(async () => { h.mockInput.pressKey(up); await h.flush() })
    await act(async () => { await h.flush(); await h.renderOnce() })
    expect(h.workspace().interaction).toMatchObject({ mode: "normal", surface: "transcript" })
    expect(h.workspace().composer.text).toBe("keep this draft")
    expect(scrollbox.scrollTop).toBe(before)
  } finally { await h.close() }
})
}



test("transcript yanks paste into composer Normal mode through the shared Vim register", async () => {
  const h = await visualHarness()
  try {
    await h.keys("ggv4ly")
    await h.controller.settle()
    expect(h.copied).toEqual(["Alpha"])
    await act(async () => { h.mockInput.pressKey("j", { ctrl: true }); await h.flush() })
    await h.keys("p")
    expect(h.workspace().composer.text).toBe("Alpha")
    expect(h.workspace().interaction.mode).toBe("normal")
    await act(async () => { h.mockInput.pressKey("k", { ctrl: true }); await h.flush() })
    await h.keys("ggVy")
    await h.controller.settle()
    expect(h.workspace().interaction.unnamedRegister.shape).toBe("line")
    await act(async () => { h.mockInput.pressKey("j", { ctrl: true }); await h.flush() })
    await h.keys("p")
    expect(h.workspace().composer.text).toBe("Alpha\nAlpha bold text.")
    await act(async () => { h.controller.changeDraft("before\nafter", 0); await h.flush() })
    await h.keys("p")
    expect(h.workspace().composer.text).toBe("before\nAlpha bold text.\nafter")
    expect(h.copied.at(-1)).toBe("Alpha bold text.\n")
  } finally { await h.close() }
})

 test("arrow focus exits transcript Visual selection and composer Visual selection", async () => {
  const h = await visualHarness()
  const arrow = async (key: string) => {
    await act(async () => { h.mockInput.pressArrow(key as "up" | "down"); await h.flush() })
    await act(async () => { await h.flush(); await h.renderOnce() })
  }
  try {
    await h.keys("ggv4l")
    expect(h.workspace().transcript.selection).toBeDefined()
    await arrow("down")
    expect(h.workspace().interaction).toMatchObject({ mode: "normal", surface: "composer" })
    expect(h.workspace().transcript.selection).toBeUndefined()
    await act(async () => { h.controller.changeDraft("draft", 0); await h.flush() })
    await h.keys("vl")
    expect(h.workspace().interaction.mode).toBe("visual")
    await arrow("up")
    expect(h.workspace().interaction).toMatchObject({ mode: "normal", surface: "transcript" })
    expect(h.workspace().composer.text).toBe("draft")
  } finally { await h.close() }
})


for (const mode of ["normal", "insert", "visual"] as const) {
  test(`composer ${mode} scrolls transcript with Ctrl-E/Y/D/U without moving its cursor`, async () => {
    const h = await visualHarness()
    try {
      await act(async () => {
        h.emit({ type: "conversation", event: { type: "item.delta", threadId: thread, itemId: answer, delta: "\n\n" + Array.from({ length: 50 }, (_, i) => `Output ${i}`).join("\n\n") } })
        h.controller.changeDraft("keep my draft", 4)
        h.controller.dispatchInteraction({ type: "focus.set", surface: "composer" })
        await h.flush()
      })
      if (mode === "insert") await h.keys("i")
      if (mode === "visual") await h.keys("vl")
      const composer = h.renderer.root.findDescendantById("composer") as TextareaRenderable
      const scrollbox = h.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable
      await act(async () => { scrollbox.scrollTo(10); await h.flush(); await h.renderOnce() })
      const draft = h.workspace().composer.text
      const cursor = composer.cursorOffset
      const selection = composer.getSelectedText()
      for (const [key, direction] of [["e", 1], ["y", -1], ["d", 1], ["u", -1]] as const) {
        const before = scrollbox.scrollTop
        await act(async () => { h.mockInput.pressKey(key, { ctrl: true }); await h.flush(); await h.renderOnce() })
        expect(Math.sign(scrollbox.scrollTop - before)).toBe(direction)
        if (key === "e" || key === "y") expect(Math.abs(scrollbox.scrollTop - before)).toBe(1)
        else expect(Math.abs(scrollbox.scrollTop - before)).toBeGreaterThan(1)
        expect(h.workspace().interaction).toMatchObject({ mode, surface: "composer" })
        expect(h.workspace().composer.text).toBe(draft)
        expect(composer.cursorOffset).toBe(cursor)
        expect(composer.getSelectedText()).toBe(selection)
        expect(composer.focused).toBe(true)
      }
    } finally { await h.close() }
  })
}


for (const [encoding, previous, next] of [["literal braces", "{", "}"], ["shifted brackets", "\x1b[91;2u", "\x1b[93;2u"]] as const) {
  test(`${encoding} navigate transcript blocks and extend Visual selection`, async () => {
    const h = await visualHarness()
    const press = async (value: string) => {
      await act(async () => { h.mockInput.pressKey(value); await h.flush(); await h.renderOnce() })
    }
    try {
      await h.keys("gg")
      const first = h.workspace().transcript.cursor!
      await press(next)
      const second = h.workspace().transcript.cursor!
      expect(second.graphemeOffset).toBeGreaterThan(first.graphemeOffset)
      expect(h.workspace().transcript.projectionById[answer]!.plain.slice(second.graphemeOffset)).toStartWith("Second")
      await press(previous)
      expect(h.workspace().transcript.cursor).toEqual(first)
      await h.keys("v")
      await press(next)
      expect(h.workspace().transcript.selection?.anchor).toEqual(first)
      expect(h.workspace().transcript.selection?.head).toEqual(second)
    } finally { await h.close() }
  })
}


test("Escape interrupts active turns in Normal mode after dismissing editing modes and overlays", async () => {
  const h = await visualHarness()
  const escape = async () => {
    await act(async () => { h.mockInput.pressKey("ESCAPE"); await Bun.sleep(30); await h.flush() })
    await h.controller.settle()
  }
  const start = async () => {
    await act(async () => {
      h.emit({ type: "conversation", event: { type: "turn.started", threadId: thread, turnId: turnId("stop-turn") } })
      h.emit({ type: "conversation", event: { type: "item.started", threadId: thread, item: { id: itemId("stop-reasoning"), turnId: turnId("stop-turn"), kind: "reasoning", markdown: "Working", status: "running" } } })
      await h.flush(); await h.renderOnce()
    })
  }
  try {
    await escape()
    expect(h.interrupted).toEqual([])
    await start()
    expect(h.captureCharFrame()).toContain("Thinking")
    await h.keys("i")
    await h.keys("Keep my draft")
    await escape()
    expect(h.workspace().interaction.mode).toBe("normal")
    expect(h.interrupted).toEqual([])
    await escape()
    expect(h.interrupted).toEqual([{ thread, turn: "stop-turn" }])
    await act(async () => { await h.flush(); await h.renderOnce() })
    expect(h.captureCharFrame()).toContain("Stopping")
    expect(h.workspace().composer.text).toBe("Keep my draft")

    await h.keys("v")
    await escape()
    expect(h.workspace().interaction.mode).toBe("normal")
    expect(h.interrupted).toHaveLength(1)
    await h.keys(":")
    await escape()
    expect(h.interrupted).toHaveLength(1)
    await h.keys(" s")
    expect(h.workspace().interaction.overlay).toBe("sessions")
    await escape()
    expect(h.workspace().interaction.overlay).toBeNull()
    expect(h.interrupted).toHaveLength(1)
    await escape()
    expect(h.interrupted).toHaveLength(1)
    await act(async () => {
      h.emit({ type: "conversation", event: { type: "turn.completed", threadId: thread, turnId: turnId("stop-turn"), outcome: "interrupted" } })
      await h.flush()
    })
    await escape()
    await h.keys("t")
    await act(async () => { await h.flush(); await h.renderOnce() })
    expect(h.captureCharFrame()).not.toContain("Stopping")
    expect(h.captureCharFrame()).not.toContain("Thinking")
    expect(h.captureCharFrame()).toContain("Reasoning")
    expect(h.interrupted).toHaveLength(1)
  } finally { await h.close() }
})


for (const key of ["ctrl-k", "up"] as const) test(`${key} enters the bottom visible transcript row after scrolling from the composer`, async () => {
  const h = await visualHarness()
  try {
    await act(async () => {
      h.emit({ type: "conversation", event: { type: "item.delta", threadId: thread, itemId: answer, delta: "\n\n" + Array.from({ length: 70 }, (_, i) => `Visible row ${i}`).join("\n\n") } })
      await h.flush(); await h.renderOnce()
    })
    await h.keys("G")
    await act(async () => {
      h.controller.changeDraft("preserve draft", 5)
      h.mockInput.pressKey("ARROW_DOWN")
      await h.flush(); await h.renderOnce()
    })
    await h.keys("i")
    const scrollbox = h.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable
    for (let i = 0; i < 3; i++) await act(async () => {
      h.mockInput.pressKey("u", { ctrl: true }); await h.flush(); await h.renderOnce()
    })
    const before = scrollbox.scrollTop
    const oldCursor = h.workspace().transcript.cursor
    const measured = measureRenderedTranscript(h.renderer, scrollbox, h.workspace().transcript)!
    const rows = Object.values(measured.points!).flatMap(item => Object.values(item)).map(point => measuredPoint(measured, point)!)
      .filter(point => point.screenY >= scrollbox.viewport.screenY && point.screenY < scrollbox.viewport.screenY + scrollbox.viewport.height)
    const bottom = Math.max(...rows.map(point => point.screenY))
    await act(async () => {
      if (key === "ctrl-k") h.mockInput.pressKey("k", { ctrl: true })
      else h.mockInput.pressKey("ARROW_UP")
      await h.flush(); await h.renderOnce()
    })
    expect(h.workspace().interaction).toMatchObject({ mode: "normal", surface: "transcript" })
    expect(h.workspace().composer.text).toBe("preserve draft")
    expect(h.workspace().transcript.cursor).not.toEqual(oldCursor)
    expect(scrollbox.scrollTop).toBe(before)
    const after = measureRenderedTranscript(h.renderer, scrollbox, h.workspace().transcript)!
    expect(measuredPoint(after, h.workspace().transcript.cursor)!.screenY).toBe(bottom)
    // Refocusing an already focused transcript must not reposition its cursor.
    await h.keys("k")
    const moved = h.workspace().transcript.cursor
    await act(async () => { h.mockInput.pressKey("ARROW_UP"); await h.flush(); await h.renderOnce() })
    expect(h.workspace().transcript.cursor).toEqual(moved)
  } finally { await h.close() }
})

async function flashKey(h: Awaited<ReturnType<typeof visualHarness>>, key: string, ctrl = false) {
  await act(async () => { h.mockInput.pressKey(key, { ctrl }); if (key === "ESCAPE") await Bun.sleep(30); await h.flush(); await h.renderOnce() })
}

test("Flash jumps from Insert composer to labeled transcript text, preserving draft and supporting jump-back", async () => {
  const h = await visualHarness()
  try {
    const transcriptBlock = h.renderer.root.findDescendantById(`transcript-block:${answer}:root`) as Renderable
    await act(async () => { await h.flush(); await h.renderOnce() })
    const nativeRevision = blockNativeRevision(transcriptBlock)
    expect(nativeRevision).toBeGreaterThan(0)
    await h.keys("i")
    await h.keys("Draft untouched")
    await flashKey(h, "g", true)
    expect(h.captureCharFrame()).toContain("Jump /")
    await h.keys("bold")
    expect(h.captureCharFrame()).toContain("1 matches")
    expect(h.workspace().composer.text).toBe("Draft untouched")
    expect(h.renderer.root.findDescendantById("flash-label:a")).toBeDefined()
    await h.keys("a")
    expect(h.renderer.root.findDescendantById("flash-query")).toBeUndefined()
    expect(h.workspace().interaction).toMatchObject({ mode: "normal", surface: "transcript" })
    expect(h.workspace().transcript.cursor).toEqual({ itemId: answer, graphemeOffset: 6 })
    expect(h.workspace().composer.text).toBe("Draft untouched")
    expect(blockNativeRevision(transcriptBlock)).toBe(nativeRevision)
    await flashKey(h, "o", true)
    expect(h.workspace().transcript.cursor?.graphemeOffset).not.toBe(6)
    await flashKey(h, "TAB")
    expect(h.workspace().transcript.cursor?.graphemeOffset).toBe(6)
  } finally { await h.close() }
})

test("Flash cancellation restores composer Insert focus and does not interrupt or change cursor", async () => {
  const h = await visualHarness()
  try {
    await h.keys("i")
    await h.keys("draft")
    const cursor = h.workspace().transcript.cursor
    await flashKey(h, "g", true)
    await h.keys("unmatched")
    expect(h.captureCharFrame()).toContain("0 matches")
    await flashKey(h, "ESCAPE")
    expect(h.workspace().interaction).toMatchObject({ mode: "insert", surface: "composer" })
    expect(h.workspace().transcript.cursor).toEqual(cursor)
    expect(h.interrupted).toHaveLength(0)
    await h.keys(" preserved")
    expect(h.workspace().composer.text).toBe("draft preserved")
  } finally { await h.close() }
})

test("Flash extends Visual selection and marks restore exact transcript positions", async () => {
  const h = await visualHarness()
  try {
    await h.keys("ggma")
    const marked = h.workspace().transcript.cursor
    await h.keys("vs")
    await h.keys("bold")
    await flashKey(h, "RETURN")
    expect(h.workspace().interaction.mode).toBe("visual")
    expect(h.workspace().transcript.selection?.anchor).toEqual(marked)
    expect(h.workspace().transcript.selection?.head.graphemeOffset).toBe(6)
    await flashKey(h, "ESCAPE")
    await h.keys("`a")
    expect(h.workspace().transcript.cursor).toEqual(marked)
  } finally { await h.close() }
})


for (const prefix of ["/", "?"]) test(`${prefix} in composer Normal searches transcript without changing draft`, async () => {
  const h = await visualHarness()
  try {
    await flashKey(h, "ARROW_DOWN")
    await act(async () => { h.controller.changeDraft("keep this", 3); await h.flush() })
    await h.keys(prefix + "bold")
    expect(h.workspace().interaction.mode).toBe("command")
    expect(h.workspace().composer.text).toBe("keep this")
    await flashKey(h, "RETURN")
    expect(h.workspace().interaction).toMatchObject({ mode: "normal", surface: "transcript" })
    expect(h.workspace().transcript.cursor?.graphemeOffset).toBe(6)
    expect(h.workspace().composer.text).toBe("keep this")
  } finally { await h.close() }
})

test("Flash stays isolated during streaming and cancels cleanly on narrow resize", async () => {
  const h = await visualHarness()
  try {
    await h.keys("i")
    await h.keys("/theme")
    await flashKey(h, "g", true)
    await h.keys("bold")
    await act(async () => {
      h.emit({ type: "conversation", event: { type: "item.delta", threadId: thread, itemId: answer, delta: " More streaming text." } })
      await h.flush(); await h.renderOnce()
    })
    expect(h.renderer.root.findDescendantById("flash-label:a")).toBeDefined()
    expect(h.workspace().composer.text).toBe("/theme")
    await act(async () => { h.resize(38, 18); await h.flush(); await h.renderOnce() })
    expect(h.renderer.root.findDescendantById("flash-query")).toBeUndefined()
    expect(h.workspace().interaction).toMatchObject({ mode: "insert", surface: "composer" })
    await flashKey(h, "g", true)
    await h.keys("bold")
    expect(h.captureCharFrame()).toContain("Jump / bold")
    await flashKey(h, "ESCAPE")
    expect(h.workspace().composer.text).toBe("/theme")
  } finally { await h.close() }
})


test("Normal streaming and scrolling use the hardware cursor without rebuilding native selections", async () => {
  const h = await visualHarness()
  const original = h.renderer.startSelection.bind(h.renderer)
  let selections = 0
  h.renderer.startSelection = (...args) => { selections++; return original(...args) }
  try {
    await h.keys("gg")
    for (let i = 0; i < 5; i++) await act(async () => {
      h.emit({ type: "conversation", event: { type: "item.delta", threadId: thread, itemId: answer, delta: "\n\nStreaming paragraph " + i } })
      h.mockInput.pressKey(i % 2 ? "y" : "e", { ctrl: true })
      await h.flush(); await h.renderOnce()
    })
    expect(selections).toBe(0)
    expect(h.renderer.getSelection()).toBeNull()
    await h.keys("gg")
    expect(h.renderer.getCursorState().visible).toBe(true)
    await h.keys("vll")
    expect(selections).toBeGreaterThan(0)
    expect(h.renderer.getSelection()?.getSelectedText()).toBe("Alp")
  } finally { await h.close() }
})


test("s launches Flash from composer Normal while Insert s stays literal", async () => {
  const h = await visualHarness()
  try {
    await h.keys("i")
    await h.keys("saved draft")
    expect(h.renderer.root.findDescendantById("flash-query")).toBeUndefined()
    await flashKey(h, "ESCAPE")
    await flashKey(h, "ARROW_DOWN")
    expect(h.workspace().interaction).toMatchObject({ mode: "normal", surface: "composer" })
    const cursor = h.workspace().composer.cursorOffset
    await h.keys("s")
    expect(h.captureCharFrame()).toContain("Jump /")
    await flashKey(h, "ESCAPE")
    expect(h.workspace().interaction).toMatchObject({ mode: "normal", surface: "composer" })
    expect(h.workspace().composer.cursorOffset).toBe(cursor)
    await h.keys("s")
    await h.keys("bold")
    await flashKey(h, "RETURN")
    expect(h.workspace().transcript.cursor).toEqual({ itemId: answer, graphemeOffset: 6 })
    expect(h.workspace().composer.text).toBe("saved draft")
  } finally { await h.close() }
})


for (const surface of ["composer", "transcript"] as const) {
  test(`t follows transcript tail from ${surface} Normal without changing draft`, async () => {
    const h = await visualHarness()
    try {
      await act(async () => {
        h.controller.changeDraft("preserve draft", 3)
        h.controller.dispatchInteraction({ type: "focus.set", surface })
        h.controller.transcript({ type: "viewport.anchor", point: { itemId: answer, graphemeOffset: 0 }, preferredScreenRow: 0 })
        await h.flush()
      })
      await h.keys("t")
      expect(h.workspace().transcript.viewport.kind).toBe("tail")
      expect(h.workspace().interaction.surface).toBe(surface)
      expect(h.workspace().composer.text).toBe("preserve draft")
      await h.keys("i")
      await h.keys("t")
      expect(h.workspace().composer.text).toContain("t")
    } finally { await h.close() }
  })
}
