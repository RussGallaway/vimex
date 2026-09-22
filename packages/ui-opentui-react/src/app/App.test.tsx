import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import {
  MarkdownRenderable,
  CodeRenderable,
  type Renderable,
  type InputRenderable,
  type ScrollBoxRenderable,
  type TextareaRenderable,
  type TextRenderable,
} from "@opentui/core"
import {
  itemId,
  threadId,
  turnId,
  type ThreadSummary,
} from "@vimex/conversation"
import {
  initialWorkbench,
  transitionWorkbench,
  type WorkbenchState,
} from "@vimex/workbench"
import { graphemes, projectItem, TranscriptRuntime } from "@vimex/transcript"
import { VimexRoot } from "../index"
import {
  inertController,
  type TranscriptUiCommand,
  type VimexUiController,
} from "../contracts"
import { act, useState } from "react"
import { measureRenderedTranscript } from "../transcript/rendered-layout"
import { reduceInteraction, type Overlay } from "@vimex/interaction"
import { createEmberTideSyntax } from "../theme"

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
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary,
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "item.started",
      threadId: thread,
      item: {
        id: itemId("answer"),
        turnId: turnId("turn"),
        kind: "assistant",
        markdown:
          "## Result\n\nStreaming **Markdown** stays above the composer.",
        status: "running",
      },
    },
  }).state
  return { ...state, connection: "connected" }
}

function withOverlay(state: WorkbenchState, overlay: Overlay): WorkbenchState {
  const id = state.activeThreadId!
  const workspace = state.workspaces[id]!
  return {
    ...state,
    workspaces: {
      ...state.workspaces,
      [id]: {
        ...workspace,
        interaction: { ...workspace.interaction, overlay },
      },
    },
  }
}

describe("Vimex OpenTUI shell", () => {
  test("renders transcript, fixed composer, and full status context", async () => {
    const setup = await testRender(
      <VimexRoot state={fixture()} controller={inertController} />,
      { width: 96, height: 26 },
    )
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
      expect(frame.lastIndexOf("Message Codex")).toBeGreaterThan(
        frame.indexOf("Streaming Markdown"),
      )
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("keeps model metadata in the full-width composer and a slim responsive status strip", async () => {
    const wide = await testRender(
      <VimexRoot state={fixture()} controller={inertController} />,
      { width: 96, height: 26 },
    )
    try {
      await act(async () => {
        await wide.flush()
        await wide.renderOnce()
      })
      const composer = wide.renderer.root.findDescendantById("composer-shell")!
      const status = wide.renderer.root.findDescendantById("status-bar")!
      expect(composer.x).toBe(0)
      expect(composer.width).toBe(96)
      expect(status.height).toBe(1)
      expect(wide.captureCharFrame()).toContain("Codex · gpt-6 · high")
      expect(wide.captureCharFrame()).toContain("enter send · shift↵ newline")
      expect(
        (
          wide.renderer.root.findDescendantById(
            "status-metadata",
          ) as TextRenderable
        ).plainText,
      ).toContain("20k/100k · 20% context")
      expect(
        (
          wide.renderer.root.findDescendantById(
            "status-metadata",
          ) as TextRenderable
        ).plainText,
      ).not.toContain("gpt-6")
    } finally {
      await act(async () => wide.renderer.destroy())
    }

    const narrow = await testRender(
      <VimexRoot state={fixture()} controller={inertController} />,
      { width: 48, height: 18 },
    )
    try {
      await act(async () => {
        await narrow.flush()
        await narrow.renderOnce()
      })
      expect(
        narrow.renderer.root.findDescendantById("composer-shell")!.width,
      ).toBe(48)
      expect(
        narrow.renderer.root.findDescendantById("composer-send-hint"),
      ).toBeUndefined()
      expect(narrow.captureCharFrame()).toContain("Codex · gpt-6 · high")
      expect(
        narrow.renderer.root.findDescendantById("status-bar")!.height,
      ).toBe(1)
    } finally {
      await act(async () => narrow.renderer.destroy())
    }
  })

  test("routes normal-mode keys through the controller", async () => {
    const commands: Parameters<VimexUiController["dispatchInteraction"]>[0][] =
      []
    const controller: VimexUiController = {
      ...inertController,
      dispatchInteraction(command) {
        commands.push(command)
      },
    }
    const setup = await testRender(
      <VimexRoot state={fixture()} controller={controller} />,
      { width: 80, height: 20 },
    )
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
    const commands: Parameters<VimexUiController["dispatchInteraction"]>[0][] =
      []
    const controller: VimexUiController = {
      ...inertController,
      dispatchInteraction(command) {
        commands.push(command)
      },
    }
    const setup = await testRender(
      <VimexRoot state={fixture()} controller={controller} />,
      { width: 80, height: 20 },
    )
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
      workspaces: {
        ...state.workspaces,
        [id]: {
          ...workspace,
          interaction: {
            ...workspace.interaction,
            mode: "visual",
            surface: "transcript",
          },
          transcript: {
            ...workspace.transcript,
            cursor: { itemId: answer, graphemeOffset: 8 },
            selection: {
              anchor: { itemId: answer, graphemeOffset: 0 },
              head: { itemId: answer, graphemeOffset: 8 },
              shape: "character",
            },
          },
        },
      },
    }
    const setup = await testRender(
      <VimexRoot state={visualState} controller={inertController} />,
      { width: 80, height: 20 },
    )
    try {
      await act(async () => setup.flush())
      expect(
        setup.renderer.root.findDescendantById("markdown:answer")?.constructor
          .name,
      ).toBe("MarkdownRenderable")
      expect(setup.captureCharFrame()).toContain("Result")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("derives logical rows from the rendered Markdown frame", async () => {
    const state = fixture()
    const setup = await testRender(
      <VimexRoot state={state} controller={inertController} />,
      { width: 72, height: 20 },
    )
    try {
      await act(async () => setup.flush())
      const scrollbox = setup.renderer.root.findDescendantById(
        "transcript",
      ) as ScrollBoxRenderable
      const workspace = state.workspaces[state.activeThreadId!]!
      const layout = measureRenderedTranscript(
        setup.renderer,
        scrollbox,
        workspace.transcript,
      )!
      const point = layout.points?.[itemId("answer")]?.[0]
      const renderedRow = setup
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("Result"))
      expect(point?.screenY).toBe(renderedRow)
      expect(layout.lines.length).toBeGreaterThan(1)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("measures Markdown rows outside the clipped viewport from renderer line data", async () => {
    const thread = threadId("thread-1")
    const longId = itemId("long-answer")
    const markdown = Array.from(
      { length: 30 },
      (_, index) => `line ${index}`,
    ).join("\n\n")
    const state = transitionWorkbench(fixture(), {
      type: "conversation.event",
      event: {
        type: "item.started",
        threadId: thread,
        item: {
          id: longId,
          turnId: turnId("long-turn"),
          kind: "assistant",
          markdown,
          status: "complete",
        },
      },
    }).state
    const setup = await testRender(
      <VimexRoot state={state} controller={inertController} />,
      { width: 52, height: 14 },
    )
    try {
      await act(async () => setup.flush())
      const scrollbox = setup.renderer.root.findDescendantById(
        "transcript",
      ) as ScrollBoxRenderable
      const layout = measureRenderedTranscript(
        setup.renderer,
        scrollbox,
        state.workspaces[thread]!.transcript,
      )!
      const points = layout.points?.[longId]
      expect(points?.[0]).toBeDefined()
      expect(points?.[markdown.length]).toBeDefined()
      expect(layout.linesByItem[longId]!.length).toBeGreaterThan(20)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("keeps every logical point mapped across complex Markdown reflow", async () => {
    const thread = threadId("thread-1")
    const complexId = itemId("complex-markdown")
    const markdown =
      "# Heading\n\n- alpha alpha\n- beta\n\n| A | B |\n|---|---|\n| x | y |\n\n```ts\nconst x = 1\n```\n\nA [link](https://example.com) and **bold** text"
    const state = transitionWorkbench(fixture(), {
      type: "conversation.event",
      event: {
        type: "item.started",
        threadId: thread,
        item: {
          id: complexId,
          turnId: turnId("complex-turn"),
          kind: "assistant",
          markdown,
          status: "complete",
        },
      },
    }).state
    const setup = await testRender(
      <VimexRoot state={state} controller={inertController} />,
      { width: 52, height: 26 },
    )
    try {
      await act(async () => setup.flush())
      const scrollbox = setup.renderer.root.findDescendantById(
        "transcript",
      ) as ScrollBoxRenderable
      const transcript = state.workspaces[thread]!.transcript
      const projection = transcript.projectionById[complexId]!
      const wide = measureRenderedTranscript(
        setup.renderer,
        scrollbox,
        transcript,
      )!
      expect(
        measureRenderedTranscript(setup.renderer, scrollbox, transcript),
      ).toBe(wide)
      const count = graphemes(projection.plain).length
      expect(Object.keys(wide.points?.[complexId] ?? {})).toHaveLength(
        count + 1,
      )
      const dataOffset = graphemes(
        projection.plain.slice(0, projection.plain.indexOf("| x") + 2),
      ).length
      const dataRow = setup
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("│x"))
      expect(wide.points?.[complexId]?.[dataOffset]?.screenY).toBe(dataRow)
      const foldedTranscript = {
        ...transcript,
        folded: { ...transcript.folded, [complexId]: true },
      }
      expect(
        measureRenderedTranscript(setup.renderer, scrollbox, foldedTranscript),
      ).not.toBe(wide)
      measureRenderedTranscript(setup.renderer, scrollbox, transcript)

      // Commit the pane geometry context before asking native layout to render its new dimensions.
      await act(async () => {
        setup.resize(30, 18)
        await setup.flush()
      })
      await act(async () => {
        await setup.renderOnce()
        await setup.flush()
      })
      const narrow = measureRenderedTranscript(
        setup.renderer,
        scrollbox,
        transcript,
      )!
      expect(narrow).not.toBe(wide)
      expect(Object.keys(narrow.points?.[complexId] ?? {})).toHaveLength(
        count + 1,
      )
      expect(scrollbox.width).toBe(30)
      expect(narrow.width).toBe(30)
      expect(narrow.width).toBeLessThan(wide.width)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("measures large multiline tool output without dropping logical points", async () => {
    const thread = threadId("thread-1")
    const tool = itemId("large-tool")
    const detail = Array.from(
      { length: 400 },
      (_, index) =>
        `${String(index).padStart(4, "0")}: ${"result ".repeat(12)}`,
    ).join("\n")
    let state = transitionWorkbench(fixture(), {
      type: "conversation.event",
      event: {
        type: "item.started",
        threadId: thread,
        item: {
          id: tool,
          turnId: turnId("tool-turn"),
          kind: "tool",
          title: "large output",
          detail,
          status: "complete",
        },
      },
    }).state
    const workspace = state.workspaces[thread]!
    state = {
      ...state,
      workspaces: {
        ...state.workspaces,
        [thread]: {
          ...workspace,
          transcript: {
            ...workspace.transcript,
            folded: { ...workspace.transcript.folded, [tool]: false },
          },
        },
      },
    }
    const setup = await testRender(
      <VimexRoot
        state={state}
        controller={inertController}
        settings={{ foldTools: false }}
      />,
      { width: 48, height: 12 },
    )
    try {
      await act(async () => setup.flush())
      const scrollbox = setup.renderer.root.findDescendantById(
        "transcript",
      ) as ScrollBoxRenderable
      const transcript = state.workspaces[thread]!.transcript
      const started = performance.now()
      const layout = measureRenderedTranscript(
        setup.renderer,
        scrollbox,
        transcript,
      )!
      expect(
        measureRenderedTranscript(setup.renderer, scrollbox, transcript),
      ).toBe(layout)
      const elapsed = performance.now() - started
      const count = graphemes(transcript.projectionById[tool]!.plain).length
      expect(Object.keys(layout.points?.[tool] ?? {})).toHaveLength(count + 1)
      expect(elapsed).toBeLessThan(2_000)

      const originalScrollTop = scrollbox.scrollTop
      scrollbox.scrollTop = Math.max(0, originalScrollTop - 4)
      const scrolled = measureRenderedTranscript(
        setup.renderer,
        scrollbox,
        transcript,
      )!
      expect(scrolled).not.toBe(layout)
      scrollbox.scrollTop = originalScrollTop
      measureRenderedTranscript(setup.renderer, scrollbox, transcript)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("invalidates cached layout when same-size native Markdown content changes", async () => {
    const thread = threadId("thread-1")
    const original = fixture()
    const workspace = original.workspaces[thread]!
    const answer = workspace.conversation.items[itemId("answer")]!
    if (answer.kind !== "assistant")
      throw new Error("assistant fixture expected")
    const nativeOriginal = { ...answer, markdown: "plain composer." }
    const changed = { ...answer, markdown: "plain composer!" }
    const beforeTranscript = {
      ...workspace.transcript,
      projectionById: {
        ...workspace.transcript.projectionById,
        [changed.id]: projectItem(
          nativeOriginal,
          workspace.transcript.projectionById[changed.id],
        ),
      },
    }
    const afterTranscript = {
      ...beforeTranscript,
      projectionById: {
        ...beforeTranscript.projectionById,
        [changed.id]: projectItem(
          changed,
          workspace.transcript.projectionById[changed.id],
        ),
      },
    }
    const syntax = createEmberTideSyntax()
    const setup = await testRender(
      <scrollbox id="transcript">
        <box id={`transcript-item:${changed.id}`}>
          <markdown
            id={`markdown:${changed.id}`}
            content={nativeOriginal.markdown}
            syntaxStyle={syntax}
            conceal
          />
        </box>
      </scrollbox>,
      { width: 72, height: 18 },
    )
    try {
      await act(async () => setup.flush())
      const scrollbox = setup.renderer.root.findDescendantById(
        "transcript",
      ) as ScrollBoxRenderable
      const before = measureRenderedTranscript(
        setup.renderer,
        scrollbox,
        beforeTranscript,
      )!
      expect(
        measureRenderedTranscript(setup.renderer, scrollbox, beforeTranscript),
      ).toBe(before)
      const markdown = setup.renderer.root.findDescendantById(
        `markdown:${changed.id}`,
      ) as MarkdownRenderable
      markdown.content = changed.markdown
      await act(async () => {
        setup.renderer.requestRender()
        await setup.renderOnce()
        // Native Markdown renders through asynchronous Code children. Await
        // their completion instead of racing a wall-clock polling deadline.
        const highlights: Promise<void>[] = []
        const visit = (node: Renderable) => {
          if (node instanceof CodeRenderable)
            highlights.push(node.highlightingDone)
          for (const child of node.getChildren()) visit(child)
        }
        visit(markdown)
        await Promise.all(highlights)
        await setup.renderOnce()
      })
      const after = measureRenderedTranscript(
        setup.renderer,
        scrollbox,
        afterTranscript,
      )!
      expect(after).not.toBe(before)
      expect(
        measureRenderedTranscript(setup.renderer, scrollbox, afterTranscript),
      ).toBe(after)
      expect(setup.captureCharFrame()).toContain("composer!")
    } finally {
      syntax.destroy()
      await act(async () => setup.renderer.destroy())
    }
  })

  test("keeps measured layout cached when a same-width decorative glyph animates", async () => {
    const thread = threadId("thread-1")
    const transcript = fixture().workspaces[thread]!.transcript
    const answer = itemId("answer")
    const plain = transcript.projectionById[answer]!.plain
    const setup = await testRender(
      <scrollbox id="transcript">
        <box id={`transcript-item:${answer}`}>
          <text id="decorative-spinner">⠋</text>
          <text>{plain}</text>
        </box>
      </scrollbox>,
      { width: 72, height: 18 },
    )
    try {
      await act(async () => setup.flush())
      const scrollbox = setup.renderer.root.findDescendantById(
        "transcript",
      ) as ScrollBoxRenderable
      const before = measureRenderedTranscript(
        setup.renderer,
        scrollbox,
        transcript,
      )!
      const spinner = setup.renderer.root.findDescendantById(
        "decorative-spinner",
      ) as TextRenderable
      spinner.content = "⠙"
      await act(async () => {
        setup.renderer.requestRender()
        await setup.renderOnce()
      })
      expect(
        measureRenderedTranscript(setup.renderer, scrollbox, transcript),
      ).toBe(before)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("accepts count prefixes and Ctrl-w surface focus from raw key events", async () => {
    const commands: Parameters<VimexUiController["dispatchInteraction"]>[0][] =
      []
    const controller: VimexUiController = {
      ...inertController,
      dispatchInteraction(command) {
        commands.push(command)
      },
    }
    const setup = await testRender(
      <VimexRoot state={fixture()} controller={controller} />,
      { width: 80, height: 20 },
    )
    try {
      await act(async () => setup.flush())
      await setup.mockInput.typeText("3")
      setup.mockInput.pressKey("w", { ctrl: true })
      await setup.mockInput.typeText("j")
      await act(async () => setup.flush())
      expect(commands).toContainEqual({ type: "count.push", digit: 3 })
      expect(commands).toContainEqual({
        type: "focus.set",
        surface: "composer",
      })
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
      workspaces: {
        ...state.workspaces,
        [id]: {
          ...workspace,
          interaction: {
            ...workspace.interaction,
            mode: "normal",
            surface: "composer",
          },
          composer: {
            ...workspace.composer,
            outbox: [
              {
                id: "failed-1",
                text: "do not lose me",
                intent: "next-turn",
                status: "failed",
                reason: "network unavailable",
              },
            ],
          },
        },
      },
    }
    const retried: string[] = []
    const controller: VimexUiController = {
      ...inertController,
      retryOutgoing(id) {
        retried.push(id)
      },
    }
    const setup = await testRender(
      <VimexRoot state={failedState} controller={controller} />,
      { width: 80, height: 20 },
    )
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
    const controller: VimexUiController = {
      ...inertController,
      transcript(command) {
        transcriptCommands.push(command)
      },
    }
    const setup = await testRender(
      <VimexRoot state={fixture()} controller={controller} />,
      { width: 52, height: 14 },
    )
    try {
      await act(async () => setup.flush())
      setup.mockInput.pressKey("e", { ctrl: true })
      await act(async () => {
        await setup.flush()
        await setup.renderOnce()
      })
      expect(
        transcriptCommands.some(
          (command) => command.type === "viewport.scroll",
        ),
      ).toBe(false)
      const anchor = transcriptCommands.find(
        (command) => command.type === "viewport.anchor",
      )
      expect(anchor?.type).toBe("viewport.anchor")
      if (anchor?.type === "viewport.anchor")
        expect(anchor.preferredScreenRow).toBeGreaterThanOrEqual(0)
      expect(
        transcriptCommands.some((command) => command.type === "cursor.move"),
      ).toBe(false)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("consumes scroll counts without repeated domain transactions", async () => {
    const transcriptCommands: TranscriptUiCommand[] = []
    const interactionCommands: Parameters<
      VimexUiController["dispatchInteraction"]
    >[0][] = []
    const controller: VimexUiController = {
      ...inertController,
      transcript(command) {
        transcriptCommands.push(command)
      },
      dispatchInteraction(command) {
        interactionCommands.push(command)
      },
    }
    const setup = await testRender(
      <VimexRoot state={fixture()} controller={controller} />,
      { width: 52, height: 14 },
    )
    try {
      await act(async () => setup.flush())
      await setup.mockInput.typeText("3")
      setup.mockInput.pressKey("e", { ctrl: true })
      await act(async () => setup.flush())
      expect(
        transcriptCommands.filter(
          (command) => command.type === "viewport.scroll",
        ),
      ).toEqual([])
      expect(
        transcriptCommands.filter(
          (command) => command.type === "viewport.anchor",
        ).length,
      ).toBeLessThanOrEqual(1)
      expect(interactionCommands.at(-1)).toEqual({ type: "count.clear" })
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
      workspaces: {
        ...state.workspaces,
        [id]: {
          ...workspace,
          interaction: {
            ...workspace.interaction,
            mode: "normal",
            surface: "composer",
          },
          composer: {
            ...workspace.composer,
            text: "alpha beta",
            cursorOffset: 0,
            revision: 1,
          },
        },
      },
    }
    const changes: Array<{ text: string; cursor: number }> = []
    const controller: VimexUiController = {
      ...inertController,
      changeDraft(text, cursor) {
        changes.push({ text, cursor })
      },
    }
    const setup = await testRender(
      <VimexRoot state={composerState} controller={controller} />,
      { width: 72, height: 18 },
    )
    try {
      await act(async () => setup.flush())
      await setup.mockInput.typeText("2w")
      await act(async () => setup.flush())
      expect(changes.at(-1)).toEqual({ text: "alpha beta", cursor: 9 })
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
      workspaces: {
        ...state.workspaces,
        [id]: {
          ...workspace,
          interaction: {
            ...workspace.interaction,
            mode: "normal",
            surface: "composer",
          },
          composer: {
            ...workspace.composer,
            text: "alpha",
            cursorOffset: 0,
            revision: 1,
          },
        },
      },
    }
    const changes: Array<{ text: string; cursor: number }> = []
    const controller: VimexUiController = {
      ...inertController,
      changeDraft(text, cursor) {
        changes.push({ text, cursor })
      },
    }
    const setup = await testRender(
      <VimexRoot state={composerState} controller={controller} />,
      { width: 72, height: 18 },
    )
    try {
      await act(async () => setup.flush())
      await setup.mockInput.typeText("2x")
      await act(async () => setup.flush())
      expect(changes.at(-1)).toEqual({ text: "pha", cursor: 0 })
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("converts native UTF-16 cursor offsets at the grapheme composer boundary", async () => {
    const state = fixture()
    const id = state.activeThreadId!
    const workspace = state.workspaces[id]!
    const composerState: WorkbenchState = {
      ...state,
      workspaces: {
        ...state.workspaces,
        [id]: {
          ...workspace,
          interaction: {
            ...workspace.interaction,
            mode: "normal",
            surface: "composer",
          },
          composer: {
            ...workspace.composer,
            text: "A😀éZ",
            cursorOffset: 1,
            revision: 1,
          },
        },
      },
    }
    const changes: Array<{ text: string; cursor: number }> = []
    const controller: VimexUiController = {
      ...inertController,
      changeDraft(text, cursor) {
        changes.push({ text, cursor })
      },
    }
    const setup = await testRender(
      <VimexRoot state={composerState} controller={controller} />,
      { width: 60, height: 16 },
    )
    try {
      await act(async () => setup.flush())
      await setup.mockInput.typeText("x")
      await act(async () => setup.flush())
      expect(changes.at(-1)).toEqual({ text: "AéZ", cursor: 1 })
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("remounts native composer history and restores the cursor when switching threads", async () => {
    const first = threadId("thread-1")
    const second = threadId("thread-2")
    let state = transitionWorkbench(fixture(), {
      type: "thread.open",
      summary: {
        id: second,
        title: "Second",
        model: "gpt-6",
        reasoningEffort: "high",
        cwd: "/work/second",
        status: "idle",
      },
    }).state
    const firstWorkspace = state.workspaces[first]!
    const secondWorkspace = state.workspaces[second]!
    state = {
      ...state,
      activeThreadId: first,
      workspaces: {
        ...state.workspaces,
        [first]: {
          ...firstWorkspace,
          interaction: {
            ...firstWorkspace.interaction,
            mode: "insert",
            surface: "composer",
          },
          composer: {
            ...firstWorkspace.composer,
            text: "same",
            cursorOffset: 0,
            revision: 1,
          },
        },
        [second]: {
          ...secondWorkspace,
          interaction: {
            ...secondWorkspace.interaction,
            mode: "normal",
            surface: "composer",
          },
          composer: {
            ...secondWorkspace.composer,
            text: "same",
            cursorOffset: 4,
            revision: 1,
          },
        },
      },
    }
    const secondState = { ...state, activeThreadId: second }
    let showSecond!: () => void
    const changes: Array<{ text: string; cursor: number }> = []
    const controller: VimexUiController = {
      ...inertController,
      changeDraft(text, cursor) {
        changes.push({ text, cursor })
      },
    }
    function Harness() {
      const [current, setCurrent] = useState(state)
      showSecond = () => setCurrent(secondState)
      return <VimexRoot state={current} controller={controller} />
    }
    const setup = await testRender(<Harness />, { width: 60, height: 16 })
    try {
      await act(async () => setup.flush())
      await setup.mockInput.typeText("!")
      await act(async () => {
        showSecond()
        await setup.flush()
      })
      const textarea = setup.renderer.root.findDescendantById(
        "composer",
      ) as TextareaRenderable
      expect(textarea.plainText).toBe("same")
      expect(textarea.cursorOffset).toBe(4)
      changes.length = 0
      await setup.mockInput.typeText("u")
      await act(async () => setup.flush())
      expect(changes.at(-1)).toEqual({ text: "same", cursor: 4 })
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("defaults tools to collapsed and file diffs to expanded", async () => {
    const thread = threadId("thread-1")
    let state = fixture()
    for (const item of [
      {
        id: itemId("new-tool"),
        turnId: turnId("turn"),
        kind: "tool" as const,
        title: "Read file",
        detail: "contents",
        status: "complete" as const,
      },
      {
        id: itemId("new-edit"),
        turnId: turnId("turn"),
        kind: "edit" as const,
        title: "src/main.ts",
        patch: "@@ -1 +1 @@\n-old\n+new",
        status: "complete" as const,
      },
    ])
      state = transitionWorkbench(state, {
        type: "conversation.event",
        event: { type: "item.started", threadId: thread, item },
      }).state
    const commands: TranscriptUiCommand[] = []
    const controller: VimexUiController = {
      ...inertController,
      transcript(command) {
        commands.push(command)
      },
    }
    const setup = await testRender(
      <VimexRoot state={state} controller={controller} />,
      { width: 72, height: 18 },
    )
    try {
      await act(async () => setup.flush())
      expect(commands).toContainEqual({
        type: "fold.defaults",
        reasoning: false,
        tools: true,
      })
      expect(
        setup.renderer.root.findDescendantById("diff:new-edit"),
      ).toBeDefined()
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("keeps canonical reasoning out of the primary transcript", async () => {
    const thread = threadId("thread-1")
    const state = transitionWorkbench(fixture(), {
      type: "conversation.event",
      event: {
        type: "item.started",
        threadId: thread,
        item: {
          id: itemId("thought"),
          turnId: turnId("turn"),
          kind: "reasoning",
          markdown: "UNIQUE PRIVATE REASONING",
          status: "complete",
        },
      },
    }).state
    const transcriptCommands: TranscriptUiCommand[] = []
    const controller: VimexUiController = {
      ...inertController,
      transcript(command) {
        transcriptCommands.push(command)
      },
    }
    const setup = await testRender(
      <VimexRoot state={state} controller={controller} />,
      { width: 72, height: 18 },
    )
    try {
      await act(async () => setup.flush())
      expect(transcriptCommands).toContainEqual({
        type: "fold.defaults",
        reasoning: false,
        tools: true,
      })
      const workspace = state.workspaces[thread]!
      expect(workspace.conversation.items[itemId("thought")]).toBeDefined()
      expect(workspace.transcript.order).not.toContain(itemId("thought"))
      expect(setup.captureCharFrame()).not.toContain("UNIQUE PRIVATE REASONING")
      expect(transcriptCommands).not.toContainEqual({
        type: "fold.set",
        itemId: itemId("thought"),
        folded: true,
      })
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("stationary runtime boundary motion is a no-op and preserves detached attachment", async () => {
    const state = fixture()
    const thread = state.activeThreadId!
    const workspace = state.workspaces[thread]!
    const first = workspace.transcript.order[0]!
    const point = { itemId: first, graphemeOffset: 0 }
    const transcript = {
      ...workspace.transcript,
      cursor: point,
      viewport: { kind: "point" as const, point, preferredScreenRow: 0 },
    }
    const runtime = new TranscriptRuntime(
      {
        threadId: thread,
        canonicalGeneration: workspace.canonicalGeneration,
        canonicalRevision: workspace.canonicalRevision,
        conversation: workspace.conversation,
        transcript,
        mode: "detached",
      },
      { windowPolicy: { viewportRows: 4, overscanRows: 4 } },
    )
    const transcriptCommands: TranscriptUiCommand[] = []
    let publications = 0
    runtime.subscribe(() => {
      publications++
    })
    const controller: VimexUiController = {
      ...inertController,
      transcriptRuntime: () => runtime,
      transcript(command) {
        transcriptCommands.push(command)
      },
    }
    const setup = await testRender(
      <VimexRoot state={state} controller={controller} />,
      { width: 72, height: 18 },
    )
    try {
      await act(async () => setup.flush())
      transcriptCommands.length = 0
      const publicationsBeforeKey = publications
      await act(async () => {
        setup.mockInput.pressKey("h")
        await setup.flush()
      })
      expect(transcriptCommands).toEqual([])
      expect(publications).toBe(publicationsBeforeKey)
      expect(runtime.getSnapshot().mode).toBe("detached")
    } finally {
      runtime.dispose()
      await act(async () => setup.renderer.destroy())
    }
  })

  test("fuzzy-filters rich session rows and opens the selected result", async () => {
    const current = threadId("thread-1")
    const target = threadId("client-auth")
    const summary: ThreadSummary = {
      id: target,
      title: "Client authentication",
      model: "gpt-6",
      reasoningEffort: "high",
      cwd: "/work/client",
      gitBranch: "feature/auth",
      updatedAt: Date.now(),
      status: "idle",
    }
    let state = transitionWorkbench(fixture(), {
      type: "thread.open",
      summary,
    }).state
    state = transitionWorkbench(state, {
      type: "thread.switch",
      threadId: current,
    }).state
    state = withOverlay(state, "sessions")
    const opened: string[] = []
    const controller: VimexUiController = {
      ...inertController,
      openThread(id) {
        opened.push(id)
      },
    }
    const setup = await testRender(
      <VimexRoot state={state} controller={controller} />,
      { width: 96, height: 26 },
    )
    try {
      await act(async () => setup.flush())
      await act(async () => {
        setup.mockInput.pressKey("TAB")
        await setup.flush()
      })
      await act(async () => {
        await setup.mockInput.typeText("fau")
        await setup.flush()
      })
      const frame = setup.captureCharFrame()
      expect(frame).toContain("Client authentication")
      expect(
        setup.renderer.root.findDescendantById(`session-row:${current}`),
      ).toBeUndefined()
      expect(frame).toContain("/work/client")
      expect(frame).toContain("git:feature/auth")
      await act(async () => {
        setup.mockInput.pressEnter()
        await setup.flush()
      })
      expect(opened).toEqual([target])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("opens the live session query when text and Return arrive before React rerenders", async () => {
    const current = threadId("thread-1")
    const target = threadId("01a0b1fa-cd31-7f11-b465-275ed3d0c21c")
    let state = fixture()
    state = transitionWorkbench(state, {
      type: "thread.register",
      summary: {
        id: threadId("unrelated-auto-review"),
        title: "codex-auto-review",
        model: "gpt-6",
        reasoningEffort: "low",
        cwd: "/work/other",
        status: "idle",
        updatedAt: Date.now(),
      },
    }).state
    state = transitionWorkbench(state, {
      type: "thread.switch",
      threadId: current,
    }).state
    state = withOverlay(state, "sessions")
    const opened: string[] = []
    const controller: VimexUiController = {
      ...inertController,
      openThread(id) {
        opened.push(id)
      },
    }
    const setup = await testRender(
      <VimexRoot state={state} controller={controller} />,
      { width: 96, height: 26 },
    )
    try {
      await act(async () => setup.flush())
      await act(async () => {
        setup.mockInput.pressKey("TAB")
        await setup.flush()
      })
      await act(async () => {
        await setup.mockInput.typeText(target)
        setup.mockInput.pressEnter()
        await setup.flush()
      })
      expect(opened).toEqual([target])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("focuses session search after opening it from Normal mode", async () => {
    const current = threadId("thread-1")
    const target = threadId("fork-thread-from-normal")
    let initial = transitionWorkbench(fixture(), {
      type: "thread.open",
      summary: {
        id: target,
        title: "Fork target",
        model: "gpt-6",
        reasoningEffort: "high",
        cwd: "/work/fork",
        status: "idle",
      },
    }).state
    initial = transitionWorkbench(initial, {
      type: "thread.register",
      summary: {
        id: threadId("newest-unrelated"),
        title: "codex-auto-review",
        model: "gpt-6",
        reasoningEffort: "low",
        cwd: "/work/other",
        status: "idle",
        updatedAt: Date.now(),
      },
    }).state
    initial = transitionWorkbench(initial, {
      type: "thread.switch",
      threadId: current,
    }).state
    const opened: string[] = []
    function Harness() {
      const [state, setState] = useState(initial)
      const controller: VimexUiController = {
        ...inertController,
        dispatchInteraction(command) {
          setState((previous) => {
            const id = previous.activeThreadId!
            const workspace = previous.workspaces[id]!
            return {
              ...previous,
              workspaces: {
                ...previous.workspaces,
                [id]: {
                  ...workspace,
                  interaction: reduceInteraction(
                    workspace.interaction,
                    command,
                  ),
                },
              },
            }
          })
        },
        openThread(id) {
          opened.push(id)
        },
      }
      return <VimexRoot state={state} controller={controller} />
    }
    const setup = await testRender(<Harness />, { width: 96, height: 26 })
    try {
      await act(async () => {
        await setup.mockInput.typeText(" s")
        await setup.flush()
      })
      expect(setup.renderer.currentFocusedRenderable?.id).toBe("session-search")
      await act(async () => {
        setup.mockInput.pressKey("TAB")
        await setup.flush()
      })
      await act(async () => {
        await setup.mockInput.typeText(target)
        await setup.flush()
      })
      expect(
        (
          setup.renderer.root.findDescendantById(
            "session-search",
          ) as InputRenderable
        ).value,
      ).toBe(target)
      await act(async () => {
        setup.mockInput.pressEnter()
        await setup.flush()
      })
      expect(opened).toEqual([target])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("keeps the keyboard-selected session visible while moving through a long list", async () => {
    const current = threadId("thread-1")
    let state = fixture()
    for (let index = 0; index < 18; index++) {
      const id = threadId(`session-${index.toString().padStart(2, "0")}`)
      state = transitionWorkbench(state, {
        type: "thread.register",
        summary: {
          id,
          title: `Long session ${index.toString().padStart(2, "0")}`,
          cwd: `/work/${index}`,
          model: "gpt-6",
          reasoningEffort: "high",
          status: "idle",
        },
      }).state
    }
    state = transitionWorkbench(state, {
      type: "thread.switch",
      threadId: current,
    }).state
    state = withOverlay(state, "sessions")
    const expected = state.threadOrder[12]!
    const opened: string[] = []
    const controller: VimexUiController = {
      ...inertController,
      openThread(id) {
        opened.push(id)
      },
    }
    const setup = await testRender(
      <VimexRoot state={state} controller={controller} />,
      { width: 86, height: 18 },
    )
    try {
      await act(async () => setup.flush())
      await act(async () => {
        setup.mockInput.pressKey("TAB")
        await setup.flush()
      })
      await act(async () => {
        await setup.mockInput.pressKeys(
          Array.from({ length: 12 }, () => "ARROW_DOWN"),
          1,
        )
        await setup.flush()
      })
      await act(async () => {
        await setup.renderOnce()
        await setup.flush()
      })
      expect(setup.captureCharFrame()).toContain(
        state.summaries[expected]!.title,
      )
      await act(async () => {
        setup.mockInput.pressEnter()
        await setup.flush()
      })
      expect(opened).toEqual([expected])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("masks and submits a secret Codex question", async () => {
    let state = withOverlay(fixture(), "questions")
    const id = state.activeThreadId!
    state = {
      ...state,
      questions: {
        secret: {
          id: "secret",
          threadId: id,
          turnId: turnId("turn"),
          questions: [
            {
              id: "token",
              header: "Credential",
              question: "Enter the token",
              allowOther: true,
              secret: true,
            },
          ],
        },
      },
    }
    const submitted: Array<
      Readonly<Record<string, string | readonly string[]>>
    > = []
    const controller: VimexUiController = {
      ...inertController,
      answerQuestions(_id, answers) {
        submitted.push(answers)
      },
    }
    const setup = await testRender(
      <VimexRoot state={state} controller={controller} />,
      { width: 82, height: 22 },
    )
    try {
      await act(async () => setup.flush())
      await act(async () => {
        await setup.mockInput.typeText("hunter2")
        await setup.flush()
        await setup.flush()
      })
      const frame = setup.captureCharFrame()
      expect(frame).toContain("••••••")
      await act(async () => {
        setup.mockInput.pressEnter()
        await setup.flush()
      })
      expect(submitted).toEqual([{ token: "hunter2" }])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("submits an option-only Codex question with global Return", async () => {
    let state = withOverlay(fixture(), "questions")
    const id = state.activeThreadId!
    state = {
      ...state,
      questions: {
        choice: {
          id: "choice",
          threadId: id,
          turnId: turnId("turn"),
          questions: [
            {
              id: "direction",
              header: "Direction",
              question: "Choose a path",
              allowOther: false,
              secret: false,
              options: [
                { label: "Continue", description: "Keep going" },
                { label: "Stop", description: "End here" },
              ],
            },
          ],
        },
      },
    }
    const submitted: Array<
      Readonly<Record<string, string | readonly string[]>>
    > = []
    const controller: VimexUiController = {
      ...inertController,
      answerQuestions(_id, answers) {
        submitted.push(answers)
      },
    }
    const setup = await testRender(
      <VimexRoot state={state} controller={controller} />,
      { width: 82, height: 22 },
    )
    try {
      await act(async () => setup.flush())
      expect(
        setup.renderer.root.findDescendantById("question-answer"),
      ).toBeUndefined()
      await act(async () => {
        await setup.mockInput.pressKeys(["ARROW_DOWN"])
        await setup.flush()
      })
      await act(async () => {
        setup.mockInput.pressEnter()
        await setup.flush()
      })
      expect(submitted).toEqual([{ direction: "Stop" }])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("requests and confirms forks through explicit application actions", async () => {
    const state = fixture()
    const id = state.activeThreadId!,
      workspace = state.workspaces[id]!,
      answer = itemId("answer")
    const navigable = {
      ...state,
      workspaces: {
        ...state.workspaces,
        [id]: {
          ...workspace,
          transcript: {
            ...workspace.transcript,
            cursor: { itemId: answer, graphemeOffset: 0 },
          },
        },
      },
    }
    const requested: string[] = []
    const requestController: VimexUiController = {
      ...inertController,
      requestFork(item) {
        if (item) requested.push(item)
      },
    }
    const first = await testRender(
      <VimexRoot state={navigable} controller={requestController} />,
      { width: 80, height: 20 },
    )
    try {
      await act(async () => first.flush())
      await first.mockInput.typeText("f")
      await act(async () => first.flush())
      expect(requested).toEqual([answer])
    } finally {
      await act(async () => first.renderer.destroy())
    }

    const pending = withOverlay(
      {
        ...navigable,
        pendingFork: {
          threadId: id,
          itemId: answer,
          turnId: turnId("turn"),
          preview: "Fork after this message",
        },
      },
      "fork",
    )
    let confirmed = 0
    const confirmController: VimexUiController = {
      ...inertController,
      confirmFork() {
        confirmed++
      },
    }
    const second = await testRender(
      <VimexRoot state={pending} controller={confirmController} />,
      { width: 80, height: 20 },
    )
    try {
      await act(async () => second.flush())
      expect(second.captureCharFrame()).toContain("Fork after this message")
      await act(async () => {
        second.mockInput.pressEnter()
        await second.flush()
      })
      expect(confirmed).toBe(1)
    } finally {
      await act(async () => second.renderer.destroy())
    }
  })

  test("navigates from an agent relationship with the child callback", async () => {
    let state = withOverlay(fixture(), "agents")
    const parent = state.activeThreadId!,
      child = threadId("child-agent")
    state = {
      ...state,
      agentRelationships: [
        {
          parentId: parent,
          childId: child,
          itemId: itemId("answer"),
          relation: "spawned",
          agentPath: "researcher",
        },
      ],
    }
    const opened: string[] = []
    const controller: VimexUiController = {
      ...inertController,
      openChildThread(id) {
        opened.push(id)
      },
    }
    const setup = await testRender(
      <VimexRoot state={state} controller={controller} />,
      { width: 82, height: 22 },
    )
    try {
      await act(async () => setup.flush())
      expect(setup.captureCharFrame()).toContain("researcher")
      await act(async () => {
        setup.mockInput.pressEnter()
        await setup.flush()
      })
      expect(opened).toEqual([child])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("opens the selected URL from the keyboard picker", async () => {
    const answer = itemId("answer")
    const base = fixture()
    const choice = {
      itemId: answer,
      url: "https://example.com/docs",
      text: "documentation",
      from: { itemId: answer, graphemeOffset: 0 },
      to: { itemId: answer, graphemeOffset: 13 },
    }
    const state = withOverlay(
      {
        ...base,
        urlChoices: [choice],
        urlChoiceOwner: {
          threadId: base.activeThreadId!,
          presentationId: "main",
          displayedCanonicalRevision:
            base.workspaces[base.activeThreadId!]!.canonicalRevision,
          scope: "current-item",
        },
      },
      "urls",
    )
    const commands: TranscriptUiCommand[] = []
    const controller: VimexUiController = {
      ...inertController,
      transcript(command) {
        commands.push(command)
      },
    }
    const setup = await testRender(
      <VimexRoot state={state} controller={controller} />,
      { width: 82, height: 22 },
    )
    try {
      await act(async () => setup.flush())
      expect(setup.captureCharFrame()).toContain("https://example.com/docs")
      await act(async () => {
        setup.mockInput.pressEnter()
        await setup.flush()
      })
      expect(commands).toContainEqual({
        type: "url.open",
        url: "https://example.com/docs",
        candidate: choice,
        presentationId: "main",
      })
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  test("gives configured named keybindings precedence over built-ins", async () => {
    const executed: string[] = []
    const controller: VimexUiController = {
      ...inertController,
      executeNamedCommand(name) {
        executed.push(name)
      },
    }
    const setup = await testRender(
      <VimexRoot
        state={fixture()}
        controller={controller}
        settings={{ keybindings: { i: "sessions" } }}
      />,
      { width: 80, height: 20 },
    )
    try {
      await act(async () => setup.flush())
      setup.mockInput.pressKey("i")
      await act(async () => setup.flush())
      expect(executed).toEqual(["sessions"])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
})
