import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { ScrollBoxRenderable } from "@opentui/core"
import { itemId, threadId, turnId, type ThreadSummary } from "@vimex/conversation"
import { initialWorkbench, transitionWorkbench, type WorkbenchState } from "@vimex/workbench"
import { VimexRoot } from "../index"
import { inertController, type TranscriptUiCommand, type VimexUiController } from "../contracts"
import { act } from "react"
import { measureRenderedTranscript } from "../transcript/rendered-layout"

function fixture(): WorkbenchState {
  const thread = threadId("thread-1")
  const summary: ThreadSummary = {
    id: thread,
    title: "Beautiful terminal",
    model: "gpt-6",
    reasoningEffort: "high",
    cwd: "/work/vimex",
    gitBranch: "main",
    contextUsed: 20_000,
    contextLimit: 100_000,
    status: "working",
  }
  let state = transitionWorkbench(initialWorkbench(), { type: "thread.open", summary }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "item.started",
      threadId: thread,
      item: {
        id: itemId("answer"),
        turnId: turnId("turn"),
        kind: "assistant",
        markdown: "## Result\n\nStreaming **Markdown** stays above the composer.",
        status: "running",
      },
    },
  }).state
  return { ...state, connection: "connected" }
}

describe("Vimex OpenTUI shell", () => {
  test("renders transcript, fixed composer, and full status context", async () => {
    const setup = await testRender(<VimexRoot state={fixture()} controller={inertController} />, { width: 96, height: 26 })
    try {
      await act(async () => setup.flush())
      const frame = setup.captureCharFrame()
      expect(frame).toContain("VIMEX / Beautiful terminal")
      expect(frame).toContain("Result")
      expect(frame).toContain("Message Codex")
      expect(frame).toContain("NORMAL")
      expect(frame).toContain("/work/vimex")
      expect(frame).toContain("git:main")
      expect(frame).toContain("20% context")
      expect(frame.lastIndexOf("Message Codex")).toBeGreaterThan(frame.indexOf("Streaming Markdown"))
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("routes normal-mode keys through the controller", async () => {
    const commands: Parameters<VimexUiController["dispatchInteraction"]>[0][] = []
    const controller: VimexUiController = {
      ...inertController,
      dispatchInteraction(command) { commands.push(command) },
    }
    const setup = await testRender(<VimexRoot state={fixture()} controller={controller} />, { width: 80, height: 20 })
    try {
      await act(async () => setup.flush())
      setup.mockInput.pressKey("i")
      await act(async () => setup.flush())
      expect(commands).toContainEqual({ type: "mode.insert" })
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("opens command mode from a literal colon byte", async () => {
    const commands: Parameters<VimexUiController["dispatchInteraction"]>[0][] = []
    const controller: VimexUiController = {
      ...inertController,
      dispatchInteraction(command) { commands.push(command) },
    }
    const setup = await testRender(<VimexRoot state={fixture()} controller={controller} />, { width: 80, height: 20 })
    try {
      await act(async () => setup.flush())
      await setup.mockInput.typeText(":")
      await act(async () => setup.flush())
      expect(commands).toContainEqual({ type: "mode.command" })
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("keeps native Markdown mounted during visual navigation", async () => {
    const state = fixture()
    const id = state.activeThreadId!
    const workspace = state.workspaces[id]!
    const answer = itemId("answer")
    const visualState: WorkbenchState = {
      ...state,
      workspaces: { ...state.workspaces, [id]: {
        ...workspace,
        interaction: { ...workspace.interaction, mode: "visual", surface: "transcript" },
        transcript: {
          ...workspace.transcript,
          cursor: { itemId: answer, graphemeOffset: 8 },
          selection: { anchor: { itemId: answer, graphemeOffset: 0 }, head: { itemId: answer, graphemeOffset: 8 }, shape: "character" },
        },
      } },
    }
    const setup = await testRender(<VimexRoot state={visualState} controller={inertController} />, { width: 80, height: 20 })
    try {
      await act(async () => setup.flush())
      expect(setup.renderer.root.findDescendantById("markdown:answer")?.constructor.name).toBe("MarkdownRenderable")
      expect(setup.captureCharFrame()).toContain("Result")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("derives logical rows from the rendered Markdown frame", async () => {
    const state = fixture()
    const setup = await testRender(<VimexRoot state={state} controller={inertController} />, { width: 72, height: 20 })
    try {
      await act(async () => setup.flush())
      const scrollbox = setup.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable
      const workspace = state.workspaces[state.activeThreadId!]!
      const layout = measureRenderedTranscript(setup.renderer, scrollbox, workspace.transcript)!
      const point = layout.points?.[itemId("answer")]?.[0]
      const renderedRow = setup.captureCharFrame().split("\n").findIndex((line) => line.includes("Result"))
      expect(point?.screenY).toBe(renderedRow)
      expect(layout.lines.length).toBeGreaterThan(1)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("measures Markdown rows outside the clipped viewport from renderer line data", async () => {
    const thread = threadId("thread-1")
    const longId = itemId("long-answer")
    const markdown = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n\n")
    const state = transitionWorkbench(fixture(), {
      type: "conversation.event",
      event: { type: "item.started", threadId: thread, item: { id: longId, turnId: turnId("long-turn"), kind: "assistant", markdown, status: "complete" } },
    }).state
    const setup = await testRender(<VimexRoot state={state} controller={inertController} />, { width: 52, height: 14 })
    try {
      await act(async () => setup.flush())
      const scrollbox = setup.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable
      const layout = measureRenderedTranscript(setup.renderer, scrollbox, state.workspaces[thread]!.transcript)!
      const points = layout.points?.[longId]
      expect(points?.[0]).toBeDefined()
      expect(points?.[markdown.length]).toBeDefined()
      expect(layout.linesByItem[longId]!.length).toBeGreaterThan(20)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("accepts count prefixes and Ctrl-w surface focus from raw key events", async () => {
    const commands: Parameters<VimexUiController["dispatchInteraction"]>[0][] = []
    const controller: VimexUiController = { ...inertController, dispatchInteraction(command) { commands.push(command) } }
    const setup = await testRender(<VimexRoot state={fixture()} controller={controller} />, { width: 80, height: 20 })
    try {
      await act(async () => setup.flush())
      await setup.mockInput.typeText("3")
      setup.mockInput.pressKey("w", { ctrl: true })
      await setup.mockInput.typeText("j")
      await act(async () => setup.flush())
      expect(commands).toContainEqual({ type: "count.push", digit: 3 })
      expect(commands).toContainEqual({ type: "focus.set", surface: "composer" })
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("keeps failed outgoing text visible and keyboard-retryable", async () => {
    const state = fixture()
    const id = state.activeThreadId!
    const workspace = state.workspaces[id]!
    const failedState: WorkbenchState = {
      ...state,
      workspaces: { ...state.workspaces, [id]: {
        ...workspace,
        interaction: { ...workspace.interaction, mode: "normal", surface: "composer" },
        composer: { ...workspace.composer, outbox: [{ id: "failed-1", text: "do not lose me", intent: "next-turn", status: "failed", reason: "network unavailable" }] },
      } },
    }
    const retried: string[] = []
    const controller: VimexUiController = { ...inertController, retryOutgoing(id) { retried.push(id) } }
    const setup = await testRender(<VimexRoot state={failedState} controller={controller} />, { width: 80, height: 20 })
    try {
      await act(async () => setup.flush())
      expect(setup.captureCharFrame()).toContain("failed: network unavailable")
      setup.mockInput.pressKey("r", { shift: true })
      await act(async () => setup.flush())
      expect(retried).toEqual(["failed-1"])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("Ctrl-e records the rendered top point as the semantic viewport anchor", async () => {
    const transcriptCommands: TranscriptUiCommand[] = []
    const controller: VimexUiController = { ...inertController, transcript(command) { transcriptCommands.push(command) } }
    const setup = await testRender(<VimexRoot state={fixture()} controller={controller} />, { width: 52, height: 14 })
    try {
      await act(async () => setup.flush())
      setup.mockInput.pressKey("e", { ctrl: true })
      await act(async () => {
        await setup.flush()
        await setup.renderOnce()
      })
      expect(transcriptCommands).toContainEqual({ type: "viewport.scroll", direction: "down", amount: "line" })
      expect(transcriptCommands.some((command) => command.type === "cursor.move" && command.preferredScreenRow === 0)).toBe(true)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("runs Vim word motion against the focused composer buffer", async () => {
    const state = fixture()
    const id = state.activeThreadId!
    const workspace = state.workspaces[id]!
    const composerState: WorkbenchState = {
      ...state,
      workspaces: { ...state.workspaces, [id]: {
        ...workspace,
        interaction: { ...workspace.interaction, mode: "normal", surface: "composer" },
        composer: { ...workspace.composer, text: "alpha beta", cursorOffset: 0, revision: 1 },
      } },
    }
    const changes: Array<{ text: string; cursor: number }> = []
    const controller: VimexUiController = {
      ...inertController,
      changeDraft(text, cursor) { changes.push({ text, cursor }) },
    }
    const setup = await testRender(<VimexRoot state={composerState} controller={controller} />, { width: 72, height: 18 })
    try {
      await act(async () => setup.flush())
      await setup.mockInput.typeText("2w")
      await act(async () => setup.flush())
      expect(changes.at(-1)).toEqual({ text: "alpha beta", cursor: 10 })
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("applies a counted Vim edit through the native composer adapter", async () => {
    const state = fixture()
    const id = state.activeThreadId!
    const workspace = state.workspaces[id]!
    const composerState: WorkbenchState = {
      ...state,
      workspaces: { ...state.workspaces, [id]: {
        ...workspace,
        interaction: { ...workspace.interaction, mode: "normal", surface: "composer" },
        composer: { ...workspace.composer, text: "alpha", cursorOffset: 0, revision: 1 },
      } },
    }
    const changes: Array<{ text: string; cursor: number }> = []
    const controller: VimexUiController = {
      ...inertController,
      changeDraft(text, cursor) { changes.push({ text, cursor }) },
    }
    const setup = await testRender(<VimexRoot state={composerState} controller={controller} />, { width: 72, height: 18 })
    try {
      await act(async () => setup.flush())
      await setup.mockInput.typeText("2x")
      await act(async () => setup.flush())
      expect(changes.at(-1)).toEqual({ text: "pha", cursor: 0 })
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("applies configured reasoning folds when an item first appears", async () => {
    const thread = threadId("thread-1")
    const state = transitionWorkbench(fixture(), {
      type: "conversation.event",
      event: { type: "item.started", threadId: thread, item: {
        id: itemId("thought"), turnId: turnId("turn"), kind: "reasoning", markdown: "private reasoning", status: "complete",
      } },
    }).state
    const transcriptCommands: TranscriptUiCommand[] = []
    const controller: VimexUiController = { ...inertController, transcript(command) { transcriptCommands.push(command) } }
    const setup = await testRender(
      <VimexRoot state={state} controller={controller} settings={{ foldReasoning: true }} />,
      { width: 72, height: 18 },
    )
    try {
      await act(async () => setup.flush())
      expect(transcriptCommands).toContainEqual({ type: "fold.set", itemId: itemId("thought"), folded: true })
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
})
