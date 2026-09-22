import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { InputRenderable } from "@opentui/core"
import { act, useMemo, useState } from "react"
import { threadId } from "@vimex/conversation"
import { initialWorkbench, transitionWorkbench } from "@vimex/workbench"
import { commandCompletions } from "@vimex/interaction"
import { VimexRoot } from "../index"
import { inertController, type VimexUiController } from "../contracts"

async function harness(surface: "composer" | "transcript" = "composer") {
  const id = threadId("commands")
  let initial = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id,
      title: "Commands",
      cwd: "/work",
      model: "model-a",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  initial = transitionWorkbench(initial, {
    type: "interaction.command",
    command: { type: "focus.set", surface },
  }).state
  initial = transitionWorkbench(initial, {
    type: "composer.change",
    text: "Keep my unfinished draft",
    cursorOffset: 4,
  }).state
  initial = {
    ...initial,
    availableModels: [
      { id: "model-a", label: "Model A", efforts: ["low", "high"] },
      { id: "model-b", label: "Model B", efforts: ["high"] },
    ],
  }
  let observed = initial
  const executed: string[] = []
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
        executeCommand(command) {
          executed.push(command)
          if (command === "model")
            setState(
              (current) =>
                transitionWorkbench(current, {
                  type: "interaction.command",
                  command: { type: "overlay.open", overlay: "models" },
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
  const keys = async (value: string) => {
    await act(async () => {
      await setup.mockInput.typeText(value)
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
    executed,
    workspace: () => observed.workspaces[id]!,
    close: async () => {
      await act(async () => setup.renderer.destroy())
    },
  }
}

test("model argument completion uses the discovered catalog", () => {
  expect(
    commandCompletions(":model model-b", { models: ["model-a", "model-b"] }),
  ).toEqual([":model model-b"])
})

for (const surface of ["composer", "transcript"] as const) {
  test(`leader rename from ${surface} shows the old title but types a replacement immediately`, async () => {
    const h = await harness(surface)
    try {
      await h.keys(" ")
      await h.keys("r")
      const input = h.renderer.root.findDescendantById(
        "command-line",
      ) as InputRenderable
      expect(input.value).toBe("rename ")
      expect(input.cursorOffset).toBe(7)
      expect(h.captureCharFrame()).toContain("Current name: Commands")
      await h.keys("New session")
      expect(input.value).toBe("rename New session")
      await act(async () => {
        h.mockInput.pressKey("RETURN")
        await h.flush()
      })
      expect(h.executed).toEqual(["rename New session"])
      expect(h.workspace().composer.text).toBe("Keep my unfinished draft")
    } finally {
      await h.close()
    }
  })
}

test("colon autocomplete sits above command bar without changing or moving the draft", async () => {
  const h = await harness()
  try {
    const composer = h.renderer.root.findDescendantById("composer-shell")!
    const before = { y: composer.y, height: composer.height }
    await h.keys(":")
    await h.keys("he")
    const drawer = h.renderer.root.findDescendantById(
      "command-completion-drawer",
    )!
    const bar = h.renderer.root.findDescendantById("command-bar")!
    expect(drawer.y + drawer.height).toBeLessThanOrEqual(bar.y)
    expect(h.captureCharFrame()).toContain(":help")
    expect(h.captureCharFrame()).toContain("Usage: :help [command]")
    expect(composer.y).toBe(before.y)
    expect(composer.height).toBe(before.height)
    await act(async () => {
      h.mockInput.pressKey("TAB")
      await h.flush()
    })
    const input = h.renderer.root.findDescendantById(
      "command-line",
    ) as InputRenderable
    expect(input.value).toBe("help ")
    expect(input.cursorOffset).toBe(5)
    await h.keys("topic")
    expect(input.value).toBe("help topic")
    await act(async () => {
      h.mockInput.pressKey("ESCAPE")
      await Bun.sleep(30)
      await h.flush()
    })
    expect(h.workspace().interaction).toMatchObject({
      mode: "normal",
      surface: "composer",
    })
    expect(h.workspace().composer.text).toBe("Keep my unfinished draft")
    expect(h.workspace().composer.cursorOffset).toBe(4)
  } finally {
    await h.close()
  }
})

test("model Tab completion executes an exact ID without opening the picker", async () => {
  const h = await harness()
  try {
    await h.keys(":")
    await h.keys("model model-b")
    await act(async () => {
      h.mockInput.pressKey("TAB")
      await h.flush()
    })
    const input = h.renderer.root.findDescendantById(
      "command-line",
    ) as InputRenderable
    expect(input.value).toBe("model model-b ")
    expect(input.cursorOffset).toBe("model model-b ".length)
    expect(h.captureCharFrame()).toContain(":model model-b high")
    await h.keys("high")
    expect(input.value).toBe("model model-b high")
    input.setText("model model-b")
    input.cursorOffset = input.value.length
    await act(async () => {
      h.mockInput.pressKey("RETURN")
      await h.flush()
      await h.renderOnce()
    })
    expect(h.executed).toEqual(["model model-b"])
    expect(h.workspace().interaction.overlay).toBeNull()
    expect(h.workspace().composer.text).toBe("Keep my unfinished draft")
  } finally {
    await h.close()
  }
})

test("explicit model completion selection wins over the bare model command", async () => {
  const h = await harness()
  try {
    await h.keys(":")
    await h.keys("model ")
    await act(async () => {
      h.mockInput.pressKey("ARROW_DOWN")
      h.mockInput.pressKey("RETURN")
      await h.flush()
    })
    expect(h.executed).toEqual(["model model-b"])
  } finally {
    await h.close()
  }
})

test("bare model picks a model then its supported thinking level", async () => {
  const h = await harness()
  try {
    await h.keys(":")
    await h.keys("model")
    await act(async () => {
      h.mockInput.pressKey("RETURN")
      await h.flush()
    })
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
    expect(h.workspace().interaction.overlay).toBe("models")
    expect(h.captureCharFrame()).toContain("Model A")
    await h.keys("j")
    await act(async () => {
      h.mockInput.pressKey("RETURN")
      await h.flush()
      await h.renderOnce()
    })
    expect(h.workspace().interaction.overlay).toBe("models")
    expect(h.captureCharFrame()).toContain("Thinking · Model B")
    expect(h.captureCharFrame()).toContain("high")
    await act(async () => {
      h.mockInput.pressKey("RETURN")
      await h.flush()
    })
    expect(h.executed).toEqual(["model", "model model-b high"])
    expect(h.workspace().interaction.overlay).toBeNull()
    expect(h.workspace().composer.text).toBe("Keep my unfinished draft")
  } finally {
    await h.close()
  }
})

test("model picker Escape returns a stage and arrows choose an effort", async () => {
  const h = await harness()
  try {
    await h.keys(":")
    await h.keys("model")
    await act(async () => {
      h.mockInput.pressKey("RETURN")
      await h.flush()
      await h.renderOnce()
    })
    await act(async () => {
      h.mockInput.pressKey("RETURN")
      await h.flush()
      await h.renderOnce()
    })
    expect(h.captureCharFrame()).toContain("Thinking · Model A")
    await act(async () => {
      h.mockInput.pressKey("ESCAPE")
      await Bun.sleep(30)
      await h.flush()
      await h.renderOnce()
    })
    expect(h.captureCharFrame()).toContain("Models")
    expect(h.workspace().interaction.overlay).toBe("models")
    await act(async () => {
      h.mockInput.pressKey("RETURN")
      await h.flush()
      await h.renderOnce()
    })
    await act(async () => {
      h.mockInput.pressKey("ARROW_UP")
      h.mockInput.pressKey("RETURN")
      await h.flush()
    })
    expect(h.executed).toEqual(["model", "model model-a low"])
    expect(h.workspace().interaction.overlay).toBeNull()
  } finally {
    await h.close()
  }
})

test("transcript slash remains search without the command completion drawer", async () => {
  const h = await harness("transcript")
  try {
    await h.keys("/")
    await h.keys("needle")
    expect(
      h.renderer.root.findDescendantById("command-completion-drawer"),
    ).toBeUndefined()
    await act(async () => {
      h.mockInput.pressKey("RETURN")
      await h.flush()
    })
    expect(h.executed).toEqual(["/needle"])
  } finally {
    await h.close()
  }
})

test("empty colon Return does not execute the first completion", async () => {
  const h = await harness()
  try {
    await h.keys(":")
    await act(async () => {
      h.mockInput.pressKey("RETURN")
      await h.flush()
    })
    expect(h.executed).toEqual([""])
    expect(h.workspace().composer.text).toBe("Keep my unfinished draft")
  } finally {
    await h.close()
  }
})

test("invalid recognized Ex arguments show usage and preserve Command input", async () => {
  const h = await harness()
  try {
    await h.keys(":")
    await h.keys("theme ultraviolet")
    await act(async () => {
      h.mockInput.pressKey("RETURN")
      await h.flush()
      await h.renderOnce()
    })
    expect(h.executed).toEqual([])
    expect(h.workspace().interaction.mode).toBe("command")
    expect(h.workspace().interaction.commandLine).toBe("theme ultraviolet")
    expect(h.captureCharFrame()).toContain("Usage: :theme [name]")
  } finally {
    await h.close()
  }
})
