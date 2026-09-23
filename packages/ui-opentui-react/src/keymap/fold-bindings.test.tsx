import { expect, test } from "bun:test"
import { DiffRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, useMemo, useState } from "react"
import { itemId, threadId, turnId } from "@vimex/conversation"
import { initialWorkbench, transitionWorkbench } from "@vimex/workbench"
import type { Overlay, Surface, VimMode } from "@vimex/interaction"
import { VimexRoot } from "../index"
import { inertController, type VimexUiController } from "../contracts"

const thread = threadId("folds"),
  tool = itemId("fold-tool"),
  edit = itemId("fold-edit")
async function harness(
  mode: VimMode = "normal",
  surface: Surface = "transcript",
  overlay: Overlay = null,
  cursorId = tool,
) {
  let initial = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Folds",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  for (const item of [
    {
      id: itemId("message"),
      turnId: turnId("turn"),
      kind: "assistant" as const,
      markdown: "A message",
      status: "complete" as const,
    },
    {
      id: tool,
      turnId: turnId("turn"),
      kind: "tool" as const,
      title: "Read files",
      detail: "Tool output",
      status: "complete" as const,
    },
    {
      id: edit,
      turnId: turnId("turn"),
      kind: "edit" as const,
      title: "src/example.ts",
      patch: "@@ -1 +1 @@\n-old\n+new",
      status: "complete" as const,
    },
  ])
    initial = transitionWorkbench(initial, {
      type: "conversation.event",
      event: { type: "item.started", threadId: thread, item },
    }).state
  const workspace = initial.workspaces[thread]!
  initial = {
    ...initial,
    workspaces: {
      ...initial.workspaces,
      [thread]: {
        ...workspace,
        interaction: { ...workspace.interaction, mode, surface, overlay },
        composer: {
          ...workspace.composer,
          text: "Keep this draft",
          cursorOffset: 4,
          revision: 1,
        },
        transcript: {
          ...workspace.transcript,
          folded: { [tool]: true, [edit]: true },
          cursor: { itemId: cursorId, graphemeOffset: 0 },
          viewport: {
            kind: "point",
            point: { itemId: tool, graphemeOffset: 0 },
            preferredScreenRow: 0,
          },
          ...(mode === "visual"
            ? {
                selection: {
                  anchor: { itemId: tool, graphemeOffset: 0 },
                  head: { itemId: tool, graphemeOffset: 3 },
                  shape: "character" as const,
                },
              }
            : {}),
        },
      },
    },
  }
  let observed = initial
  function Harness() {
    const [state, setState] = useState(initial)
    observed = state
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
        transcript(command) {
          if (command.type === "fold.all" || command.type === "fold.set")
            setState(
              (current) =>
                transitionWorkbench(current, {
                  type: "transcript.command",
                  command,
                }).state,
            )
        },
      }),
      [],
    )
    return <VimexRoot state={state} controller={controller} />
  }
  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    setup = await testRender(<Harness />, { width: 80, height: 28 })
    await setup.flush()
  })
  const keys = async (text: string) => {
    await act(async () => {
      await setup.mockInput.typeText(text)
      await setup.flush()
    })
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
  }
  return {
    ...setup,
    keys,
    workspace: () => observed.workspaces[thread]!,
    close: async () => {
      await act(async () => setup.renderer.destroy())
    },
  }
}

test("typed uppercase zR/zM expand and collapse all without lowercase aliases", async () => {
  const h = await harness()
  try {
    await h.keys("zR")
    expect(h.workspace().transcript.folded).toMatchObject({ [tool]: false })
    expect(h.workspace().transcript.folded[edit]).toBe(false)
    await h.keys("zM")
    expect(h.workspace().transcript.folded).toMatchObject({ [tool]: true })
    expect(h.workspace().transcript.folded[edit]).toBe(true)
    await h.keys("zr")
    expect(h.workspace().transcript.folded).toMatchObject({ [tool]: true })
  } finally {
    await h.close()
  }
})

test("Enter toggles only the current transcript block", async () => {
  const h = await harness()
  try {
    await act(async () => {
      h.mockInput.pressKey("RETURN")
      await h.flush()
    })
    expect(h.workspace().transcript.folded).toMatchObject({ [tool]: false })
    await act(async () => {
      h.mockInput.pressKey("RETURN")
      await h.flush()
    })
    expect(h.workspace().transcript.folded).toMatchObject({ [tool]: true })
  } finally {
    await h.close()
  }
})

test("Shift-Tab leaves an open diff in the native diff view", async () => {
  const h = await harness()
  try {
    await h.keys("zR")
    expect(h.renderer.root.findDescendantById(`diff:${edit}`)).toBeInstanceOf(
      DiffRenderable,
    )
    await act(async () => {
      h.mockInput.pressKey("TAB", { shift: true })
      await h.flush()
      await h.renderOnce()
    })
    expect(h.workspace().transcript.folded[tool]).toBe(true)
    expect(h.workspace().transcript.folded[edit]).toBe(false)
    expect(h.renderer.root.findDescendantById(`diff:${edit}`)).toBeInstanceOf(
      DiffRenderable,
    )
  } finally {
    await h.close()
  }
})

test("Enter restores an edit to the native diff view after closing it", async () => {
  const h = await harness("normal", "transcript", null, edit)
  try {
    for (const folded of [false, true, false]) {
      await act(async () => {
        h.mockInput.pressKey("RETURN")
        await h.flush()
        await h.renderOnce()
      })
      expect(h.workspace().transcript.folded[edit]).toBe(folded)
      expect(
        h.renderer.root.findDescendantById(`diff:${edit}`) instanceof
          DiffRenderable,
      ).toBe(!folded)
    }
  } finally {
    await h.close()
  }
})

for (const [mode, surface] of [
  ["normal", "transcript"],
  ["visual", "transcript"],
  ["normal", "composer"],
  ["insert", "composer"],
] as const) {
  test(`Shift-Tab preserves ${mode} ${surface} focus, draft, selection and anchor`, async () => {
    const h = await harness(mode, surface)
    try {
      const before = h.workspace()
      const focused = h.renderer.currentFocusedRenderable?.id
      for (const folded of [false, true]) {
        await act(async () => {
          h.mockInput.pressKey("TAB", { shift: true })
          await h.flush()
        })
        await act(async () => {
          await h.flush()
          await h.renderOnce()
        })
        const after = h.workspace()
        expect(after.transcript.folded).toMatchObject({ [tool]: folded })
        expect(after.transcript.folded[edit]).toBe(true)
        expect(after.transcript.bulkToolFolded).toBe(folded)
        expect(after.interaction).toEqual(before.interaction)
        expect(after.composer).toEqual(before.composer)
        expect(after.transcript.selection).toEqual(before.transcript.selection)
        expect(after.transcript.cursor).toEqual(before.transcript.cursor)
        expect(after.transcript.viewport).toEqual(before.transcript.viewport)
        expect(h.renderer.currentFocusedRenderable?.id).toBe(focused)
      }
    } finally {
      await h.close()
    }
  })
}

for (const [mode, overlay] of [
  ["command", null],
  ["normal", "help"],
] as const) {
  test(`local ${overlay ?? "command completion"} keys do not fold the transcript`, async () => {
    const h = await harness(mode, "transcript", overlay)
    try {
      const folds = h.workspace().transcript.folded
      await act(async () => {
        h.mockInput.pressKey("TAB")
        h.mockInput.pressKey("TAB", { shift: true })
        await h.flush()
      })
      expect(h.workspace().transcript.folded).toEqual(folds)
    } finally {
      await h.close()
    }
  })
}

for (const key of ["za", "zo", "zc"]) {
  test(`${key} ignores an ordinary message and composer focus`, async () => {
    for (const [surface, cursor] of [
      ["transcript", itemId("message")],
      ["composer", tool],
    ] as const) {
      const h = await harness("normal", surface, null, cursor)
      try {
        const before = h.workspace()
        await h.keys(key)
        expect(h.workspace().transcript.folded).toEqual(
          before.transcript.folded,
        )
        expect(h.workspace().composer).toEqual(before.composer)
      } finally {
        await h.close()
      }
    }
  })
}

test("Visual Vim fold commands preserve the selection, cursor and focus", async () => {
  const h = await harness("visual")
  try {
    const before = h.workspace()
    for (const [key, folded] of [
      ["zo", false],
      ["zc", true],
      ["za", false],
      ["zM", true],
      ["zR", false],
    ] as const) {
      await h.keys(key)
      const after = h.workspace()
      expect(after.transcript.folded[tool]).toBe(folded)
      expect(after.transcript.selection).toEqual(before.transcript.selection)
      expect(after.transcript.cursor).toEqual(before.transcript.cursor)
      expect(after.interaction).toEqual(before.interaction)
    }
  } finally {
    await h.close()
  }
})
