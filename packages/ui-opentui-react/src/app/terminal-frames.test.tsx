import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type {
  InputRenderable,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core"
import { act, useMemo, useState } from "react"
import { itemId, threadId, turnId } from "@vimex/conversation"
import {
  initialWorkbench,
  transitionWorkbench,
  type WorkbenchState,
} from "@vimex/workbench"
import { VimexRoot } from "../index"
import { inertController, type VimexUiController } from "../contracts"
import { waitForRender } from "../test-support/wait-for-render"

const thread = threadId("frame-thread")
const tool = itemId("frame-tool")

function fixture(): WorkbenchState {
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Frame regression",
      model: "gpt-6",
      reasoningEffort: "high",
      cwd: "/work/vimex",
      gitBranch: "main",
      status: "idle",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "item.started",
      threadId: thread,
      item: {
        id: itemId("frame-answer"),
        turnId: turnId("frame-turn"),
        kind: "assistant",
        markdown:
          "## Result\n\nA **stable** transcript with [a link](https://example.com).",
        status: "complete",
      },
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "item.started",
      threadId: thread,
      item: {
        id: tool,
        turnId: turnId("frame-turn"),
        kind: "tool",
        title: "Read files",
        detail: "first output",
        status: "running",
      },
    },
  }).state
  const workspace = state.workspaces[thread]!
  return {
    ...state,
    connection: "connected",
    workspaces: {
      ...state.workspaces,
      [thread]: {
        ...workspace,
        composer: {
          ...workspace.composer,
          text: "Draft stays here",
          cursorOffset: 16,
          revision: 1,
        },
        transcript: { ...workspace.transcript, folded: { [tool]: true } },
      },
    },
  }
}

function fold(state: WorkbenchState, folded: boolean): WorkbenchState {
  const workspace = state.workspaces[thread]!
  return {
    ...state,
    workspaces: {
      ...state.workspaces,
      [thread]: {
        ...workspace,
        transcript: { ...workspace.transcript, folded: { [tool]: folded } },
      },
    },
  }
}

function stableFrame(frame: string) {
  // Spinner animation has dedicated tests; preserve its occupied cell without timing noise.
  return frame
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "⠋")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

describe("terminal frame regressions", () => {
  for (const [width, height] of [
    [120, 30],
    [96, 26],
    [48, 18],
  ] as const) {
    test(`composer stays anchored through tool streaming and folding at ${width}x${height}`, async () => {
      let state = fixture()
      let renderState!: (next: WorkbenchState) => void
      function Harness() {
        const [current, setCurrent] = useState(state)
        renderState = setCurrent
        return <VimexRoot state={current} controller={inertController} />
      }
      const setup = await testRender(<Harness />, { width, height })
      try {
        await act(async () => setup.flush())
        const transcript = setup.renderer.root.findDescendantById(
          "transcript",
        ) as ScrollBoxRenderable
        await act(async () => {
          transcript.scrollTo(0)
          await setup.flush()
          await setup.renderOnce()
        })
        await waitForRender(
          setup,
          () => setup.captureCharFrame().includes("A stable transcript"),
          "terminal-frame Markdown content",
        )
        expect(setup.captureCharFrame()).toContain("A stable transcript")
        const composer = setup.renderer.root.findDescendantById(
          "composer",
        ) as TextareaRenderable
        const shell = setup.renderer.root.findDescendantById("composer-shell")!
        const anchoredY = shell.y
        const anchoredBottom = shell.y + shell.height
        const assertAnchored = () => {
          expect(shell.y).toBe(anchoredY)
          expect(shell.y + shell.height).toBe(anchoredBottom)
          expect(anchoredBottom).toBeLessThanOrEqual(height)
          const status = setup.renderer.root.findDescendantById("status-bar")!
          expect(status.y).toBe(anchoredBottom + 1)
          expect(status.height).toBe(1)
          expect(shell.x).toBe(0)
          expect(shell.width).toBe(width)
          expect(status.y + status.height).toBe(height)
          expect(composer.height).toBeGreaterThanOrEqual(2)
          const cwd = setup.renderer.root.findDescendantById("status-cwd")!
          const branch =
            setup.renderer.root.findDescendantById("status-branch")!
          expect(cwd.x + cwd.width).toBeLessThanOrEqual(branch.x)
          expect(transcript.y + transcript.height).toBeLessThanOrEqual(shell.y)
          expect(composer.plainText).toBe("Draft stays here")
          expect(setup.captureCharFrame()).toContain("Draft stays here")
        }
        expect(stableFrame(setup.captureCharFrame())).toMatchSnapshot(
          `collapsed ${width}x${height}`,
        )
        state = fold(state, false)
        await act(async () => {
          renderState(state)
        })
        await act(async () => {
          await setup.flush()
          await setup.renderOnce()
        })
        assertAnchored()
        await act(async () => {
          transcript.scrollTo(transcript.scrollHeight)
          await setup.flush()
          await setup.renderOnce()
        })
        expect(setup.captureCharFrame()).toContain("first output")
        for (let batch = 0; batch < 3; batch++) {
          state = transitionWorkbench(state, {
            type: "conversation.event",
            event: {
              type: "item.delta",
              threadId: thread,
              itemId: tool,
              delta: Array.from(
                { length: 8 },
                (_, row) => `\nbatch ${batch} row ${row}: output continues`,
              ).join(""),
            },
          }).state
          await act(async () => {
            renderState(state)
          })
          await act(async () => {
            await setup.flush()
            await setup.renderOnce()
          })
          assertAnchored()
        }
        await act(async () => {
          transcript.scrollTo(0)
          await setup.flush()
        })
        assertAnchored()
        expect(setup.captureCharFrame()).toContain("Result")
        state = fold(state, true)
        await act(async () => {
          renderState(state)
        })
        await act(async () => {
          await setup.flush()
          await setup.renderOnce()
        })
        assertAnchored()
        expect(setup.captureCharFrame()).not.toContain("batch 2 row 7")
        const draft = Array.from(
          { length: 20 },
          (_, row) => `draft line ${row}`,
        ).join("\n")
        const workspace = state.workspaces[thread]!
        const inputHeight = composer.height
        const transcriptHeight = transcript.height
        state = {
          ...state,
          workspaces: {
            ...state.workspaces,
            [thread]: {
              ...workspace,
              composer: {
                ...workspace.composer,
                text: draft,
                cursorOffset: draft.length,
                revision: workspace.composer.revision + 1,
              },
            },
          },
        }
        await act(async () => {
          renderState(state)
        })
        await act(async () => {
          await setup.flush()
          await setup.renderOnce()
        })
        expect(composer.plainText).toBe(draft)
        expect(composer.height).toBe(inputHeight)
        expect(shell.y).toBe(anchoredY)
        expect(shell.y + shell.height).toBe(anchoredBottom)
        expect(transcript.height).toBe(transcriptHeight)
      } finally {
        await act(async () => setup.renderer.destroy())
      }
    })
  }

  for (const [width, height] of [
    [120, 30],
    [48, 18],
    [48, 12],
  ] as const) {
    test(`command mode replaces the status strip without moving composer or transcript at ${width}x${height}`, async () => {
      function Harness() {
        const [state, setState] = useState(fixture)
        const controller = useMemo<VimexUiController>(
          () => ({
            ...inertController,
            dispatchInteraction(command) {
              setState(
                (current) =>
                  transitionWorkbench(current, {
                    type: "interaction.command",
                    command,
                  }).state,
              )
            },
          }),
          [],
        )
        return <VimexRoot state={state} controller={controller} />
      }
      const setup = await testRender(<Harness />, { width, height })
      try {
        await act(async () => {
          await setup.flush()
          await setup.renderOnce()
        })
        const composer =
          setup.renderer.root.findDescendantById("composer-shell")!
        const transcript = setup.renderer.root.findDescendantById("transcript")!
        const status = setup.renderer.root.findDescendantById("status-bar")!
        const before = {
          composerY: composer.y,
          composerHeight: composer.height,
          transcriptY: transcript.y,
          transcriptHeight: transcript.height,
          statusY: status.y,
          statusHeight: status.height,
        }
        await act(async () => {
          await setup.mockInput.typeText(":")
          await setup.flush()
        })
        await act(async () => {
          await setup.flush()
          await setup.renderOnce()
        })
        const command = setup.renderer.root.findDescendantById("command-bar")!
        expect(command).toBeDefined()
        expect(command.y).toBe(before.statusY)
        expect(command.height).toBe(before.statusHeight)
        expect(command.y + command.height).toBe(height)
        expect(
          setup.renderer.root.findDescendantById("status-bar"),
        ).toBeUndefined()
        expect(composer.y).toBe(before.composerY)
        expect(composer.height).toBe(before.composerHeight)
        expect(transcript.y).toBe(before.transcriptY)
        expect(transcript.height).toBe(before.transcriptHeight)
        expect(setup.captureCharFrame()).toContain("COMMAND")
        await act(async () => {
          await setup.mockInput.typeText("help")
          await setup.flush()
        })
        const commandInput = setup.renderer.root.findDescendantById(
          "command-line",
        ) as InputRenderable
        expect(commandInput.value).toBe("help")
        expect(commandInput.y).toBe(command.y)
        expect(
          (
            setup.renderer.root.findDescendantById(
              "composer",
            ) as TextareaRenderable
          ).plainText,
        ).toBe("Draft stays here")
        await act(async () => {
          setup.mockInput.pressKey("ESCAPE")
          await setup.flush()
        })
        await act(async () => {
          await setup.flush()
          await setup.renderOnce()
        })
        for (
          let attempt = 0;
          attempt < 20 && !setup.renderer.root.findDescendantById("status-bar");
          attempt++
        ) {
          await act(async () => {
            await Bun.sleep(5)
            await setup.flush()
            await setup.renderOnce()
          })
        }
        await act(async () => {
          await setup.flush()
          await setup.renderOnce()
        })
        const restored = setup.renderer.root.findDescendantById("status-bar")!
        expect(restored.y).toBe(before.statusY)
        expect(restored.height).toBe(before.statusHeight)
        expect(
          setup.renderer.root.findDescendantById("command-bar"),
        ).toBeUndefined()
        expect(composer.y).toBe(before.composerY)
        expect(transcript.height).toBe(before.transcriptHeight)
      } finally {
        await act(async () => setup.renderer.destroy())
      }
    })
  }

  test("long titles and paths cannot collide with header and status metadata", async () => {
    const state = fixture()
    const summary = {
      ...state.summaries[thread]!,
      title: "A very long thread title that must truncate safely",
      cwd: "/work/very-long-directory/project-with-a-long-name",
      gitBranch: "feature/a-very-long-branch",
    }
    const longState = {
      ...state,
      summaries: { ...state.summaries, [thread]: summary },
    }
    const setup = await testRender(
      <VimexRoot state={longState} controller={inertController} />,
      { width: 48, height: 18 },
    )
    try {
      await act(async () => {
        await setup.flush()
        await setup.renderOnce()
      })
      const title = setup.renderer.root.findDescendantById("thread-title")!
      const connection =
        setup.renderer.root.findDescendantById("connection-status")!
      const cwd = setup.renderer.root.findDescendantById("status-cwd")!
      const branch = setup.renderer.root.findDescendantById("status-branch")!
      expect(title.height).toBe(1)
      expect(title.x + title.width).toBeLessThan(connection.x)
      expect(connection.x + connection.width).toBeLessThanOrEqual(48)
      expect(cwd.x + cwd.width).toBeLessThanOrEqual(branch.x)
      expect(setup.captureCharFrame()).toContain("● connected")
      expect(setup.captureCharFrame()).not.toContain("project-with-a-long-name")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

  for (const [width, height] of [
    [180, 40],
    [80, 24],
    [48, 18],
  ] as const) {
    test(`Help is centered and keyboard-scrollable at ${width}x${height}`, async () => {
      const state = fixture()
      const workspace = state.workspaces[thread]!
      const helpState = {
        ...state,
        workspaces: {
          ...state.workspaces,
          [thread]: {
            ...workspace,
            interaction: { ...workspace.interaction, overlay: "help" as const },
          },
        },
      }
      const setup = await testRender(
        <VimexRoot state={helpState} controller={inertController} />,
        { width, height },
      )
      try {
        await act(async () => {
          await setup.flush()
          await setup.renderOnce()
        })
        const modal = setup.renderer.root.findDescendantById("overlay-frame")!
        expect(
          Math.abs(modal.x + modal.width / 2 - width / 2),
        ).toBeLessThanOrEqual(1)
        expect(
          Math.abs(modal.y + modal.height / 2 - height / 2),
        ).toBeLessThanOrEqual(1)
        expect(modal.y).toBeGreaterThanOrEqual(0)
        expect(modal.y + modal.height).toBeLessThanOrEqual(height)
        expect(setup.captureCharFrame()).toContain("j/k scroll · esc close")
        const help = setup.renderer.root.findDescendantById(
          "help-scroll",
        ) as ScrollBoxRenderable
        if (height <= 24) {
          expect(help.scrollHeight).toBeGreaterThan(help.height)
          await act(async () => {
            await setup.mockInput.typeText("G")
            await setup.flush()
            await setup.renderOnce()
          })
          expect(help.scrollTop).toBeGreaterThan(0)
          expect(setup.captureCharFrame()).toContain(":goal")
          await act(async () => {
            await setup.mockInput.typeText("g")
            await setup.flush()
            await setup.renderOnce()
          })
          expect(help.scrollTop).toBe(0)
        }
      } finally {
        await act(async () => setup.renderer.destroy())
      }
    })
  }

  for (const [width, height] of [
    [180, 40],
    [80, 24],
  ] as const) {
    test(`session picker is centered at ${width}x${height}`, async () => {
      const state = fixture()
      const workspace = state.workspaces[thread]!
      const overlayState = {
        ...state,
        workspaces: {
          ...state.workspaces,
          [thread]: {
            ...workspace,
            interaction: {
              ...workspace.interaction,
              overlay: "sessions" as const,
            },
          },
        },
      }
      const setup = await testRender(
        <VimexRoot state={overlayState} controller={inertController} />,
        { width, height },
      )
      try {
        await act(async () => {
          await setup.flush()
          await setup.renderOnce()
        })
        const modal = setup.renderer.root.findDescendantById("overlay-frame")!
        expect(
          Math.abs(modal.x + modal.width / 2 - width / 2),
        ).toBeLessThanOrEqual(1)
        expect(
          Math.abs(modal.y + modal.height / 2 - height / 2),
        ).toBeLessThanOrEqual(1)
        expect(modal.x).toBeGreaterThanOrEqual(0)
        expect(modal.y).toBeGreaterThanOrEqual(0)
        expect(modal.x + modal.width).toBeLessThanOrEqual(width)
        expect(modal.y + modal.height).toBeLessThanOrEqual(height)
      } finally {
        await act(async () => setup.renderer.destroy())
      }
    })
  }

  test("session picker stays inside a 48x18 terminal", async () => {
    const state = fixture()
    const workspace = state.workspaces[thread]!
    const overlayState = {
      ...state,
      workspaces: {
        ...state.workspaces,
        [thread]: {
          ...workspace,
          interaction: {
            ...workspace.interaction,
            overlay: "sessions" as const,
          },
        },
      },
    }
    const setup = await testRender(
      <VimexRoot state={overlayState} controller={inertController} />,
      { width: 48, height: 18 },
    )
    try {
      await act(async () => setup.flush())
      const modal = setup.renderer.root.findDescendantById("overlay-frame")!
      expect(Math.abs(modal.x + modal.width / 2 - 24)).toBeLessThanOrEqual(1)
      expect(Math.abs(modal.y + modal.height / 2 - 9)).toBeLessThanOrEqual(1)
      const search = setup.renderer.root.findDescendantById("session-search")!
      expect(search.x).toBeGreaterThanOrEqual(0)
      expect(search.y).toBeGreaterThanOrEqual(0)
      expect(search.x + search.width).toBeLessThanOrEqual(48)
      expect(search.y + search.height).toBeLessThanOrEqual(18)
      const cwd = setup.renderer.root.findDescendantById(
        `session-cwd:${thread}`,
      )!
      const metadata = setup.renderer.root.findDescendantById(
        `session-metadata:${thread}`,
      )!
      expect(metadata.y).toBeGreaterThanOrEqual(cwd.y + cwd.height)
      expect(cwd.x + cwd.width).toBeLessThanOrEqual(48)
      expect(setup.captureCharFrame()).toContain("/work/vimex")
      expect(setup.captureCharFrame()).toContain("idle · git:main · gpt-6")
      const modalFrame = setup
        .captureCharFrame()
        .split("\n")
        .slice(modal.y, modal.y + modal.height)
        .map((line) => line.slice(modal.x, modal.x + modal.width))
        .join("\n")
      expect(stableFrame(modalFrame)).toMatchSnapshot("sessions 48x18")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
})
