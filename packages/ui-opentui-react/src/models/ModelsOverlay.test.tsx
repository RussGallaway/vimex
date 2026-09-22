import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useMemo, useState } from "react"
import { threadId } from "@vimex/conversation"
import {
  initialWorkbench,
  transitionWorkbench,
  type AvailableModel,
} from "@vimex/workbench"
import { VimexRoot } from "../index"
import { inertController, type VimexUiController } from "../contracts"

for (const scenario of [
  {
    name: "loading",
    models: undefined,
    error: undefined,
    text: "Loading models",
  },
  {
    name: "empty",
    models: [] as readonly AvailableModel[],
    error: undefined,
    text: "No models available",
  },
  {
    name: "failed",
    models: undefined,
    error: "Service unavailable",
    text: "Could not load models",
  },
]) {
  test(`model picker stays open on Enter when ${scenario.name}`, async () => {
    const id = threadId("model-state")
    let initial = transitionWorkbench(initialWorkbench(), {
      type: "thread.open",
      summary: {
        id,
        title: "Models",
        cwd: "/work",
        model: "test",
        reasoningEffort: "high",
        status: "idle",
      },
    }).state
    initial = transitionWorkbench(initial, {
      type: "interaction.command",
      command: { type: "overlay.open", overlay: "models" },
    }).state
    initial = {
      ...initial,
      availableModels: scenario.models,
      modelCatalogError: scenario.error,
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
    try {
      expect(setup.captureCharFrame()).toContain(scenario.text)
      if (scenario.error) {
        expect(setup.captureCharFrame()).toContain(scenario.error)
        expect(setup.captureCharFrame()).toContain(":model to retry")
        expect(setup.captureCharFrame()).not.toContain("Loading models")
      }
      await act(async () => {
        setup.mockInput.pressKey("RETURN")
        await setup.flush()
      })
      expect(observed.workspaces[id]!.interaction.overlay).toBe("models")
      expect(executed).toEqual([])
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
}
