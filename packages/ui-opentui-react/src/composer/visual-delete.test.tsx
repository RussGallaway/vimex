import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { TextareaRenderable } from "@opentui/core"
import { act, useMemo, useState } from "react"
import { threadId } from "@vimex/conversation"
import {
  activeWorkspace,
  initialWorkbench,
  transitionWorkbench,
} from "@vimex/workbench"
import { VimexRoot } from "../index"
import { inertController, type VimexUiController } from "../contracts"

async function fixture(text = "alpha beta", cursorOffset = 0) {
  let initial = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: threadId("visual-delete"),
      title: "Visual delete",
      cwd: "/tmp",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  initial = transitionWorkbench(initial, {
    type: "interaction.command",
    command: { type: "focus.set", surface: "composer" },
  }).state
  initial = transitionWorkbench(initial, {
    type: "composer.change",
    text,
    cursorOffset,
  }).state
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
        changeDraft(text, cursorOffset) {
          setState(
            (current) =>
              transitionWorkbench(current, {
                type: "composer.change",
                text,
                cursorOffset,
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
    setup = await testRender(<Harness />, { width: 80, height: 24 })
    await setup.flush()
  })
  return {
    ...setup,
    composer: setup.renderer.root.findDescendantById(
      "composer",
    ) as TextareaRenderable,
    state: () => activeWorkspace(observed)!,
  }
}

for (const key of ["d", "x"])
  test(`rapid Visual ${key} deletes only the inclusive selection and P restores it`, async () => {
    const setup = await fixture()
    try {
      await act(async () => {
        await setup.mockInput.typeText(`vl${key}`)
        await setup.flush()
      })
      expect(setup.composer.plainText).toBe("pha beta")
      expect(setup.state().interaction.mode).toBe("normal")
      expect(setup.state().interaction.unnamedRegister.text).toBe("al")
      await act(async () => {
        await setup.mockInput.typeText("P")
        await setup.flush()
      })
      expect(setup.composer.plainText).toBe("alpha beta")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })

test("rapid Visual change enters Insert and accepts replacement text without native double deletion", async () => {
  const setup = await fixture("A😀Z", 1)
  try {
    await act(async () => {
      await setup.mockInput.typeText("vc")
      await setup.flush()
    })
    expect(setup.state().interaction.mode).toBe("insert")
    expect(setup.composer.plainText).toBe("AZ")
    await act(async () => {
      await setup.mockInput.typeText("new")
      await setup.flush()
    })
    expect(setup.composer.plainText).toBe("AnewZ")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})
