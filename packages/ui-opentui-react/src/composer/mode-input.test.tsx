import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { TextareaRenderable } from "@opentui/core"
import { act, useMemo, useState } from "react"
import { threadId, turnId } from "@vimex/conversation"
import { activeWorkspace, initialWorkbench, transitionWorkbench, type WorkbenchState } from "@vimex/workbench"
import type { VimMode } from "@vimex/interaction"
import { VimexRoot } from "../index"
import { inertController, type VimexUiController } from "../contracts"

async function setupMode(mode: VimMode) {
  let observed: WorkbenchState
  let initial = transitionWorkbench(initialWorkbench(), { type: "thread.open", summary: {
    id: threadId("mode-input"), title: "Mode input", cwd: "/tmp", model: "test", reasoningEffort: "high", status: "idle",
  } }).state
  initial = transitionWorkbench(initial, { type: "interaction.command", command: { type: "focus.set", surface: "composer" } }).state
  initial = transitionWorkbench(initial, { type: "composer.change", text: "alpha beta", cursorOffset: 0 }).state
  if (mode === "insert") initial = transitionWorkbench(initial, { type: "interaction.command", command: { type: "mode.insert" } }).state
  if (mode === "visual") initial = transitionWorkbench(initial, { type: "interaction.command", command: { type: "mode.visual" } }).state
  function Harness() {
    const [state, setState] = useState(initial)
    observed = state
    const controller = useMemo<VimexUiController>(() => ({
      ...inertController,
      dispatchInteraction(command) { setState(current => transitionWorkbench(current, { type: "interaction.command", command }).state) },
      changeDraft(text, cursorOffset) { setState(current => transitionWorkbench(current, { type: "composer.change", text, cursorOffset }).state) },
    }), [])
    return <VimexRoot state={state} controller={controller} />
  }
  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => { setup = await testRender(<Harness />, { width: 80, height: 24 }) })
  await act(async () => setup.flush())
  return { ...setup, composer: setup.renderer.root.findDescendantById("composer") as TextareaRenderable, state: () => observed! }
}

async function setupSubmission(mode: "insert" | "normal") {
  const id = threadId("submission")
  let initial = transitionWorkbench(initialWorkbench(), { type: "thread.open", summary: {
    id, title: "Submission", cwd: "/tmp", model: "test", reasoningEffort: "high", status: "idle",
  } }).state
  initial = transitionWorkbench(initial, { type: "interaction.command", command: { type: "focus.set", surface: "composer" } }).state
  initial = transitionWorkbench(initial, { type: "composer.change", text: "first message", cursorOffset: 13 }).state
  if (mode === "insert") initial = transitionWorkbench(initial, { type: "interaction.command", command: { type: "mode.insert" } }).state

  let observed = initial
  let updateState!: (command: Parameters<typeof transitionWorkbench>[1]) => void
  let submission = 0
  function Harness() {
    const [state, setState] = useState(initial)
    observed = state
    updateState = (command) => setState(current => transitionWorkbench(current, command).state)
    const controller = useMemo<VimexUiController>(() => ({
      ...inertController,
      dispatchInteraction(command) { setState(current => transitionWorkbench(current, { type: "interaction.command", command }).state) },
      changeDraft(text, cursorOffset) { setState(current => transitionWorkbench(current, { type: "composer.change", text, cursorOffset }).state) },
      submit(intent) { setState(current => transitionWorkbench(current, { type: "composer.submit", intent, clientMessageId: `submission-${++submission}` }).state) },
    }), [])
    return <VimexRoot state={state} controller={controller} />
  }

  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => { setup = await testRender(<Harness />, { width: 80, height: 24, kittyKeyboard: true }) })
  await act(async () => setup.flush())
  return {
    ...setup,
    composer: setup.renderer.root.findDescendantById("composer") as TextareaRenderable,
    state: () => observed,
    settle(command: Parameters<typeof transitionWorkbench>[1]) { updateState(command) },
    thread: id,
  }
}

describe("composer mode input isolation", () => {
  for (const mode of ["normal", "visual"] as const) {
    test(`${mode} rejects unmatched punctuation, Unicode, native deletion and bracketed paste`, async () => {
      const setup = await setupMode(mode)
      try {
        for (const text of ["!@#%&*()_+={}[]|;", "é😀界"]) {
          await act(async () => { await setup.mockInput.typeText(text); await setup.flush() })
          expect(setup.composer.plainText).toBe("alpha beta")
        }
        await act(async () => { setup.mockInput.pressKey("BACKSPACE"); setup.mockInput.pressKey("DELETE"); await setup.flush() })
        expect(setup.composer.plainText).toBe("alpha beta")
        await act(async () => { await setup.mockInput.pasteBracketedText("pasted 😀\nsecond line"); await setup.flush() })
        expect(setup.composer.plainText).toBe("alpha beta")
      } finally { await act(async () => setup.renderer.destroy()) }
    })
  }

  test("Normal Vim motions and edits still operate before Insert accepts text and paste", async () => {
    const setup = await setupMode("normal")
    try {
      await act(async () => { await setup.mockInput.typeText("wx"); await setup.flush() })
      expect(setup.composer.plainText).toBe("alpha eta")
      await act(async () => { await setup.mockInput.typeText("i"); await setup.flush() })
      await act(async () => { await setup.mockInput.typeText("!é"); await setup.mockInput.pasteBracketedText("😀[paste]"); await setup.flush() })
      expect(setup.composer.plainText).toBe("alpha !é😀[paste]eta")
      await act(async () => { setup.mockInput.pressEscape(); await Bun.sleep(30); await setup.flush() })
      expect(activeWorkspace(setup.state())!.interaction.mode).toBe("normal")
      await act(async () => { await setup.mockInput.typeText("!@"); await setup.flush() })
      expect(setup.composer.plainText).toBe("alpha !é😀[paste]eta")
    } finally { await act(async () => setup.renderer.destroy()) }
  })

  test("keeps a long multiline draft inside a fixed-height scrolling input", async () => {
    const setup = await setupMode("insert")
    try {
      const shell = setup.renderer.root.findDescendantById("composer-shell")!
      const initialShellHeight = shell.height
      const initialInputHeight = setup.composer.height
      const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")
      await act(async () => {
        await setup.mockInput.pasteBracketedText(`\n${lines}`)
        await setup.flush()
        await setup.renderOnce()
      })
      const viewport = setup.composer.editorView.getViewport()
      const cursor = setup.composer.visualCursor
      expect(shell.height).toBe(initialShellHeight)
      expect(setup.composer.height).toBe(initialInputHeight)
      expect(initialInputHeight).toBe(3)
      expect(setup.composer.lineCount).toBeGreaterThan(20)
      expect(viewport.offsetY).toBeGreaterThan(0)
      expect(cursor.logicalRow).toBeGreaterThanOrEqual(20)
      expect(cursor.visualRow).toBeLessThan(viewport.height)
    } finally { await act(async () => setup.renderer.destroy()) }
  })

  test("Insert Enter clears the native buffer before immediate next-draft input", async () => {
    const setup = await setupSubmission("insert")
    try {
      await act(async () => {
        await setup.mockInput.pressKeys(["RETURN", ..."next draft"], 0)
        await setup.flush()
      })
      const composer = activeWorkspace(setup.state())!.composer
      expect(composer.text).toBe("next draft")
      expect(composer.outbox).toEqual([expect.objectContaining({ id: "submission-1", text: "first message", status: "sending" })])
    } finally { await act(async () => setup.renderer.destroy()) }
  })

  test("Insert Ctrl-Enter steers through native clearing before immediate next-draft input", async () => {
    const setup = await setupSubmission("insert")
    try {
      await act(async () => {
        setup.mockInput.pressEnter({ ctrl: true })
        expect(setup.composer.plainText).toBe("")
        await setup.mockInput.typeText("next steer draft")
        await setup.flush()
      })
      const composer = activeWorkspace(setup.state())!.composer
      expect(composer.text).toBe("next steer draft")
      expect(composer.outbox).toEqual([expect.objectContaining({
        id: "submission-1", text: "first message", intent: "steer", status: "sending",
      })])
    } finally { await act(async () => setup.renderer.destroy()) }
  })

  test("the submitted empty-state render cannot erase bytes already received for the next draft", async () => {
    const id = threadId("stale-submit-render")
    let initial = transitionWorkbench(initialWorkbench(), { type: "thread.open", summary: {
      id, title: "Stale submit render", cwd: "/tmp", model: "test", reasoningEffort: "high", status: "idle",
    } }).state
    initial = transitionWorkbench(initial, { type: "interaction.command", command: { type: "focus.set", surface: "composer" } }).state
    initial = transitionWorkbench(initial, { type: "interaction.command", command: { type: "mode.insert" } }).state
    initial = transitionWorkbench(initial, { type: "composer.change", text: "submitted text", cursorOffset: 14 }).state
    function Harness() {
      const [state, setState] = useState(initial)
      const controller = useMemo<VimexUiController>(() => ({
        ...inertController,
        changeDraft() {},
        submit(intent) { setState(current => transitionWorkbench(current, { type: "composer.submit", intent, clientMessageId: "stale-1" }).state) },
      }), [])
      return <VimexRoot state={state} controller={controller} />
    }
    let renderer!: Awaited<ReturnType<typeof testRender>>
    await act(async () => { renderer = await testRender(<Harness />, { width: 80, height: 24 }); await renderer.flush() })
    try {
      const textarea = renderer.renderer.root.findDescendantById("composer") as TextareaRenderable
      await act(async () => {
        renderer.mockInput.pressEnter()
        textarea.setText("NEXT_DRAFT_IN_SAME_DRAIN")
        textarea.cursorOffset = textarea.plainText.length
        await renderer.flush()
      })
      expect(textarea.plainText).toBe("NEXT_DRAFT_IN_SAME_DRAIN")
    } finally { await act(async () => renderer.renderer.destroy()) }
  })

  test("a delayed acknowledgement cannot overwrite the next draft", async () => {
    const setup = await setupSubmission("insert")
    try {
      await act(async () => {
        setup.mockInput.pressEnter()
        await setup.mockInput.typeText("newer text")
        await setup.flush()
      })
      await act(async () => {
        setup.settle({ type: "composer.ack", threadId: setup.thread, clientMessageId: "submission-1", turnId: turnId("started") })
        await setup.flush()
      })
      expect(activeWorkspace(setup.state())!.composer.text).toBe("newer text")
      expect(setup.composer.plainText).toBe("newer text")
    } finally { await act(async () => setup.renderer.destroy()) }
  })

  test("a delayed failure retains the submitted outbox copy and the newer draft", async () => {
    const setup = await setupSubmission("insert")
    try {
      await act(async () => {
        setup.mockInput.pressEnter()
        await setup.mockInput.typeText("newer text")
        await setup.flush()
      })
      await act(async () => {
        setup.settle({ type: "composer.fail", threadId: setup.thread, clientMessageId: "submission-1", reason: "offline" })
        await setup.flush()
      })
      const composer = activeWorkspace(setup.state())!.composer
      expect(composer.text).toBe("newer text")
      expect(composer.outbox).toEqual([expect.objectContaining({ text: "first message", status: "failed", reason: "offline" })])
      expect(setup.composer.plainText).toBe("newer text")
    } finally { await act(async () => setup.renderer.destroy()) }
  })

  test("Normal Enter clears immediately and submits exactly once", async () => {
    const setup = await setupSubmission("normal")
    try {
      await act(async () => {
        setup.mockInput.pressEnter()
        expect(setup.composer.plainText).toBe("")
        await setup.flush()
      })
      const composer = activeWorkspace(setup.state())!.composer
      expect(composer.text).toBe("")
      expect(composer.outbox).toEqual([expect.objectContaining({ text: "first message", status: "sending" })])
    } finally { await act(async () => setup.renderer.destroy()) }
  })
})
