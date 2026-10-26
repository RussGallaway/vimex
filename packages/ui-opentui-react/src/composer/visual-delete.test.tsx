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

for (const [text, cursor, keys, expected, register] of [
  ["alpha beta", 1, "ciw", " beta", "alpha"],
  ['say "hello" now', 7, 'ci"', 'say "" now', "hello"],
  ["use [hello] now", 7, "ci[", "use [] now", "hello"],
  ["use [hello] now", 7, "ci]", "use [] now", "hello"],
  ["one\ntwo", 1, "cc", "\ntwo", "one"],
  ["foo.bar baz", 0, "vEy", "foo.bar baz", "foo.bar"],
  ["one\ntwo\nthree", 1, "Vjd", "three", "one\ntwo"],
  ["alpha", 1, "vlohy", "alpha", "alp"],
] as const) {
  test(`composer routes ${keys} through semantic Vim actions`, async () => {
    const setup = await fixture(text, cursor)
    try {
      await act(async () => {
        await setup.mockInput.typeText(keys)
        await setup.flush()
      })
      expect(setup.composer.plainText).toBe(expected)
      expect(setup.state().interaction.unnamedRegister.text).toBe(register)
      expect(setup.state().interaction.mode).toBe(
        keys.startsWith("c") ? "insert" : "normal",
      )
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
}

test("an unmatched change text object keeps Normal mode and the draft", async () => {
  const setup = await fixture("plain text", 1)
  try {
    await act(async () => {
      await setup.mockInput.typeText('ci"')
      await setup.flush()
    })
    expect(setup.composer.plainText).toBe("plain text")
    expect(setup.state().interaction.mode).toBe("normal")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("successive composer Visual j motions preserve the desired column", async () => {
  const setup = await fixture("abcdef\nx\nabcdef", 5)
  try {
    await act(async () => {
      await setup.mockInput.typeText("vjjy")
      await setup.flush()
    })
    expect(setup.state().interaction.unnamedRegister.text).toBe("f\nx\nabcdef")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

for (const [keys, expected, register] of [
  ["vGD", "alpha beta", "second line\nthird line"],
  ["vggD", "third line", "alpha beta\nsecond line"],
  ["vlD", "alpha beta\nthird line", "second line"],
  ["vlX", "alpha beta\nthird line", "second line"],
  ["vlY", "alpha beta\nsecond line\nthird line", "second line"],
] as const) {
  test(`composer ${keys} acts on whole selected lines`, async () => {
    const setup = await fixture("alpha beta\nsecond line\nthird line", 14)
    try {
      await act(async () => {
        await setup.mockInput.typeText(keys)
        await setup.flush()
      })
      expect(setup.composer.plainText).toBe(expected)
      expect(setup.state().interaction.mode).toBe("normal")
      expect(setup.state().interaction.unnamedRegister).toEqual({
        text: register,
        shape: "line",
      })
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
}

for (const keys of ["gD", "vgD"]) {
  test(`unsupported composer ${keys} does not fall through to destructive D`, async () => {
    const setup = await fixture("alpha beta\nsecond line", 14)
    try {
      await act(async () => {
        await setup.mockInput.typeText(keys)
        await setup.flush()
      })
      expect(setup.composer.plainText).toBe("alpha beta\nsecond line")
      expect(setup.state().interaction.mode).toBe(
        keys === "gD" ? "normal" : "visual",
      )
      expect(setup.state().interaction.pendingKeys).toBe("")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
}

for (const [keys, cursor] of [
  ["vjy", 2],
  ["vjY", 0],
  ["vkhy", 1],
] as const) {
  test(`composer ${keys} returns its editing cursor to the selection start`, async () => {
    const setup = await fixture("alpha\nsecond\nthird", keys === "vkhy" ? 8 : 2)
    try {
      await act(async () => {
        await setup.mockInput.typeText(keys)
        await setup.flush()
      })
      expect(setup.state().composer.cursorOffset).toBe(cursor)
      expect(setup.state().interaction.mode).toBe("normal")
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
}

test("normal composer dG deletes through the draft end and undo restores it", async () => {
  const text = "alpha beta\nsecond line\nthird line"
  const setup = await fixture(text, 14)
  try {
    await act(async () => {
      await setup.mockInput.typeText("dG")
      await setup.flush()
    })
    expect(setup.composer.plainText).toBe("alpha beta")
    expect(setup.state().interaction.unnamedRegister).toEqual({
      text: "second line\nthird line",
      shape: "line",
    })
    expect(setup.state().interaction.mode).toBe("normal")
    expect(setup.state().interaction.pendingKeys).toBe("")
    expect(setup.state().composer.cursorOffset).toBe(3)
    await act(async () => {
      await setup.mockInput.typeText("u")
      await setup.flush()
    })
    expect(setup.composer.plainText).toBe(text)
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})
