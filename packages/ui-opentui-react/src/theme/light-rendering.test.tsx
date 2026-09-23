import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { expect, test } from "bun:test"
import { act, useState } from "react"
import { itemId, threadId, turnId } from "@vimex/conversation"
import { initialWorkbench, transitionWorkbench } from "@vimex/workbench"
import { inertController } from "../contracts"
import { VimexRoot } from "../index"
import { waitForRender } from "../test-support/wait-for-render"
import { selectTheme, themePalette } from "."

test("light and dark themes repaint existing user and tool panels on a live switch", async () => {
  const thread = threadId("light-theme")
  const turn = turnId("light-theme-turn")
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Light theme",
      cwd: "/work",
      model: "test",
      reasoningEffort: "medium",
      status: "idle",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: { type: "turn.started", threadId: thread, turnId: turn },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "item.started",
      threadId: thread,
      item: {
        id: itemId("light-user"),
        turnId: turn,
        kind: "user",
        markdown: "USER THEME SAMPLE",
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
        id: itemId("light-tool"),
        turnId: turn,
        kind: "tool",
        title: "TOOL THEME SAMPLE",
        detail: "",
        status: "complete",
      },
    },
  }).state
  let switchTheme!: (
    name: "rose-pine-dawn" | "solarized-light" | "solarized-dark",
  ) => void
  function Harness() {
    const [name, setName] = useState<
      "rose-pine-dawn" | "solarized-light" | "solarized-dark"
    >("rose-pine-dawn")
    switchTheme = setName
    return (
      <VimexRoot
        state={{
          ...state,
          preferences: { theme: name, syntaxTheme: "theme" },
        }}
        controller={inertController}
      />
    )
  }
  const h = await testRender(<Harness />, { width: 80, height: 18 })
  try {
    const spanOf = (token: string) =>
      h
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes(token))
    for (const name of [
      "rose-pine-dawn",
      "solarized-light",
      "solarized-dark",
      "solarized-light",
    ] as const) {
      if (name !== "rose-pine-dawn") await act(async () => switchTheme(name))
      await waitForRender(
        h,
        () =>
          Boolean(spanOf("USER THEME SAMPLE") && spanOf("TOOL THEME SAMPLE")),
        `${name} transcript panels`,
      )
      const palette = themePalette(name)
      expect(spanOf("USER THEME SAMPLE")?.fg.toString()).toBe(
        RGBA.fromHex(palette.text).toString(),
      )
      expect(spanOf("USER THEME SAMPLE")?.bg.toString()).toBe(
        RGBA.fromHex(palette.backgroundPanel).toString(),
      )
      expect(spanOf("TOOL THEME SAMPLE")?.fg.toString()).toBe(
        RGBA.fromHex(palette.text).toString(),
      )
      expect(spanOf("TOOL THEME SAMPLE")?.bg.toString()).toBe(
        RGBA.fromHex(palette.backgroundRaised).toString(),
      )
    }
  } finally {
    await act(async () => h.renderer.destroy())
    selectTheme("ember-tide")
  }
})
