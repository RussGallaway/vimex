import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useState } from "react"
import { itemId, threadId, turnId } from "@vimex/conversation"
import { initialWorkbench, transitionWorkbench } from "@vimex/workbench"
import { inertController } from "../contracts"
import { VimexRoot } from "../index"
import { createEmberTideSyntax, selectTheme, themePalette } from "../theme"
import { MarkdownMessage } from "./MarkdownMessage"
import { RGBA } from "@opentui/core"
import { waitForRender } from "../test-support/wait-for-render"

for (const kind of ["assistant", "user"] as const)
  test(`${kind} theme switching refreshes nested backgrounds without remounting ordinary streamed content`, async () => {
    selectTheme("ember-tide")
    const ember = createEmberTideSyntax("ember-tide"),
      nord = createEmberTideSyntax("nord")
    const item = {
      id: itemId("theme-switch"),
      turnId: turnId("turn"),
      kind,
      markdown: "- LISTTEXT with `inline` code\n\n> QUOTETEXT\n\nParagraph",
      status: "complete" as const,
    }
    let update!: () => void
    let stream!: () => void
    function Harness() {
      const [next, setNext] = useState(false)
      const [suffix, setSuffix] = useState("")
      stream = () => setSuffix(" streamed")
      update = () => {
        selectTheme("nord")
        setNext(true)
      }
      return (
        <box
          width="100%"
          height="100%"
          backgroundColor={
            themePalette(next ? "nord" : "ember-tide").background
          }
        >
          <MarkdownMessage
            item={{ ...item, markdown: item.markdown + suffix }}
            syntax={next ? nord : ember}
          />
        </box>
      )
    }
    const h = await testRender(<Harness />, { width: 80, height: 15 })
    try {
      await waitForRender(
        h,
        () => h.captureCharFrame().includes("LISTTEXT"),
        `${kind} Markdown content`,
      )
      const original = h.renderer.root.findDescendantById(`markdown:${item.id}`)
      await act(async () => stream())
      await waitForRender(
        h,
        () => h.captureCharFrame().includes("streamed"),
        `${kind} streamed Markdown update`,
      )
      expect(h.renderer.root.findDescendantById(`markdown:${item.id}`)).toBe(
        original,
      )
      await act(async () => update())
      await waitForRender(
        h,
        () => {
          const current = h.renderer.root.findDescendantById(
            `markdown:${item.id}`,
          )
          const spans = h.captureSpans().lines.flatMap((line) => line.spans)
          return (
            current !== original &&
            ["LISTTEXT", "QUOTETEXT"].every((token) =>
              spans.some((span) => span.text.includes(token)),
            )
          )
        },
        `${kind} themed Markdown replacement`,
      )
      expect(
        h.renderer.root.findDescendantById(`markdown:${item.id}`),
      ).not.toBe(original)
      const spans = h.captureSpans().lines.flatMap((line) => line.spans)
      for (const token of ["LISTTEXT", "QUOTETEXT"]) {
        const span = spans.find((span) => span.text.includes(token))!
        expect(span).toBeDefined()
        expect(span.fg.toString()).not.toBe(
          RGBA.fromHex(themePalette("ember-tide").textSoft).toString(),
        )
        expect(span.bg.toString()).toBe(
          RGBA.fromHex(
            kind === "user"
              ? themePalette("nord").backgroundPanel
              : themePalette("nord").background,
          ).toString(),
        )
      }
    } finally {
      await act(async () => h.renderer.destroy())
      ember.destroy()
      nord.destroy()
      selectTheme("ember-tide")
    }
  })

test("theme switching refreshes existing activity batches and turn decorations", async () => {
  const thread = threadId("theme-activity")
  const turn = turnId("theme-activity-turn")
  const ids = [itemId("theme-tool-one"), itemId("theme-tool-two")]
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: thread,
      title: "Theme activity",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: { type: "turn.started", threadId: thread, turnId: turn },
  }).state
  for (const id of ids) {
    state = transitionWorkbench(state, {
      type: "conversation.event",
      event: {
        type: "item.started",
        threadId: thread,
        item: {
          id,
          turnId: turn,
          kind: "tool",
          title: "Web search",
          detail: "result",
          activity: { family: "web-research" },
          status: "complete",
        },
      },
    }).state
    state = transitionWorkbench(state, {
      type: "transcript.command",
      command: { type: "fold.set", itemId: id, folded: true },
    }).state
  }
  state = transitionWorkbench(state, {
    type: "conversation.event",
    event: {
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "complete",
      durationMs: 164_000,
    },
  }).state
  let switchTheme!: (name: "ember-tide" | "nord") => void
  function Harness() {
    const [name, setName] = useState<"ember-tide" | "nord">("ember-tide")
    switchTheme = setName
    return (
      <VimexRoot
        state={{
          ...state,
          preferences: {
            theme: name,
            syntaxTheme: state.preferences?.syntaxTheme ?? "theme",
          },
        }}
        controller={inertController}
      />
    )
  }
  const h = await testRender(<Harness />, { width: 80, height: 18 })
  try {
    const colorOf = (token: string) =>
      h
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes(token))
    const verify = async (name: "ember-tide" | "nord") => {
      await waitForRender(
        h,
        () => Boolean(colorOf("Web research") && colorOf("Worked for")),
        `${name} activity rows`,
      )
      const palette = themePalette(name)
      expect(colorOf("Web research")?.fg.toString()).toBe(
        RGBA.fromHex(palette.text).toString(),
      )
      expect(colorOf("Web research")?.bg.toString()).toBe(
        RGBA.fromHex(palette.backgroundRaised).toString(),
      )
      expect(colorOf("Worked for")?.fg.toString()).toBe(
        RGBA.fromHex(palette.textMuted).toString(),
      )
    }
    await verify("ember-tide")
    await act(async () => switchTheme("nord"))
    await verify("nord")
    await act(async () => switchTheme("ember-tide"))
    await verify("ember-tide")
  } finally {
    await act(async () => h.renderer.destroy())
    selectTheme("ember-tide")
  }
})
