import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { InputRenderable } from "@opentui/core"
import { act, useMemo, useState } from "react"
import { threadId, turnId, type ThreadId } from "@vimex/conversation"
import {
  initialWorkbench,
  transitionWorkbench,
  type WorkbenchState,
} from "@vimex/workbench"
import { VimexRoot } from "../index"
import { inertController, type VimexUiController } from "../contracts"

const first = threadId("menu-first"),
  second = threadId("menu-second")
function fixture() {
  let state = initialWorkbench()
  for (const [id, title] of [
    [first, "Alpha"],
    [second, "jk match"],
  ] as const) {
    state = transitionWorkbench(state, {
      type: "thread.open",
      summary: {
        id,
        title,
        cwd: "/work",
        model: "test",
        reasoningEffort: "high",
        status: "idle",
      },
    }).state
  }
  state = { ...state, activeThreadId: first, threadOrder: [first, second] }
  return transitionWorkbench(state, {
    type: "interaction.command",
    command: { type: "overlay.open", overlay: "sessions" },
  }).state
}
async function harness(initial: WorkbenchState = fixture()) {
  let observed = initial
  const opened: ThreadId[] = []
  const answers: Array<Readonly<Record<string, string | readonly string[]>>> =
    []
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
        openThread(id) {
          opened.push(id)
        },
        answerQuestions(_id, value) {
          answers.push(value)
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
  const escape = async () => {
    await act(async () => {
      setup.mockInput.pressKey("ESCAPE")
      await Bun.sleep(30)
      await setup.flush()
    })
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
  }
  return {
    ...setup,
    opened,
    answers,
    keys,
    escape,
    interaction: () => observed.workspaces[first]!.interaction,
    close: async () => {
      await act(async () => setup.renderer.destroy())
    },
  }
}

test("Normal sessions j/k navigate without entering search text", async () => {
  const h = await harness()
  try {
    await h.keys("jkj")
    expect(
      (h.renderer.root.findDescendantById("session-search") as InputRenderable)
        .value,
    ).toBe("")
    await act(async () => {
      h.mockInput.pressKey("RETURN")
      await h.flush()
    })
    expect(h.opened).toEqual([second])
  } finally {
    await h.close()
  }
})

test("Insert session search keeps literal j/k and Escape returns to Normal before closing", async () => {
  const h = await harness()
  try {
    await h.keys("i")
    await h.keys("jk")
    expect(h.interaction().mode).toBe("insert")
    expect(
      (h.renderer.root.findDescendantById("session-search") as InputRenderable)
        .value,
    ).toBe("jk")
    expect(
      h.renderer.root.findDescendantById(`session-row:${first}`),
    ).toBeUndefined()
    await h.escape()
    expect(h.interaction()).toMatchObject({
      mode: "normal",
      overlay: "sessions",
    })
    await h.keys("jk")
    expect(
      (h.renderer.root.findDescendantById("session-search") as InputRenderable)
        .value,
    ).toBe("jk")
    await h.escape()
    expect(h.interaction().overlay).toBeNull()
  } finally {
    await h.close()
  }
})

test("session rename keeps j/k as literal input", async () => {
  const h = await harness()
  try {
    await act(async () => {
      h.mockInput.pressKey("r", { ctrl: true })
      await h.flush()
    })
    await h.keys("jk")
    expect(
      (h.renderer.root.findDescendantById("session-rename") as InputRenderable)
        .value,
    ).toBe("Alphajk")
  } finally {
    await h.close()
  }
})

for (const allowOther of [false, true]) {
  test(`questions ${allowOther ? "preserve j/k in free text" : "navigate options with j/k"}`, async () => {
    let state = transitionWorkbench(fixture(), {
      type: "interaction.command",
      command: { type: "overlay.open", overlay: "questions" },
    }).state
    state = {
      ...state,
      questions: {
        choice: {
          id: "choice",
          threadId: first,
          turnId: turnId("menu-turn"),
          questions: [
            {
              id: "direction",
              header: "Direction",
              question: "Choose",
              allowOther,
              secret: false,
              ...(!allowOther
                ? {
                    options: [
                      { label: "Continue", description: "First" },
                      { label: "Stop", description: "Second" },
                    ],
                  }
                : {}),
            },
          ],
        },
      },
    }
    const h = await harness(state)
    try {
      await h.keys(allowOther ? "jk" : "jkj")
      await act(async () => {
        h.mockInput.pressKey("RETURN")
        await h.flush()
      })
      expect(h.answers).toEqual([{ direction: allowOther ? "jk" : "Stop" }])
    } finally {
      await h.close()
    }
  })
}
