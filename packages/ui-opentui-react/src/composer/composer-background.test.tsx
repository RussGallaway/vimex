import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { expect, test } from "bun:test"
import { act } from "react"
import { threadId } from "@vimex/conversation"
import { initialWorkbench, transitionWorkbench } from "@vimex/workbench"
import { inertController } from "../contracts"
import { VimexRoot } from "../index"
import { selectTheme, themePalette } from "../theme"

for (const theme of [
  "ember-tide",
  "rose-pine-dawn",
  "charcoal-transparent",
  "charcoal-ink-transparent",
  "charcoal-copper-transparent",
  "charcoal-signal-transparent",
  "lichen-transparent",
  "dusk-transparent",
  "clay-transparent",
] as const) {
  test(`${theme} keeps the composer accent on the canvas across every input row`, async () => {
    const palette = themePalette(theme)
    const state = transitionWorkbench(initialWorkbench(), {
      type: "thread.open",
      summary: {
        id: threadId("composer-background"),
        title: "Composer background",
        cwd: "/tmp",
        model: "test",
        reasoningEffort: "high",
        status: "idle",
      },
    }).state
    const h = await testRender(
      <VimexRoot
        state={{ ...state, preferences: { theme, syntaxTheme: "theme" } }}
        controller={inertController}
      />,
      { width: 80, height: 24 },
    )
    try {
      await h.renderOnce()
      const shell = h.renderer.root.findDescendantById("composer-shell")!
      const input = h.renderer.root.findDescendantById("composer")!
      const frame = h.captureSpans()
      const canvas = RGBA.fromHex(palette.background)
      const surface = RGBA.fromHex(
        palette.composerBackground ?? palette.backgroundRaised,
      )
      expect(input.x).toBe(shell.x + 3)
      for (let y = shell.y; y < shell.y + shell.height; y++) {
        const cells = frame.lines[y]!.spans.flatMap((span) =>
          Array.from({ length: span.width }, () => span),
        )
        expect(cells[shell.x]!.text).toContain("│")
        expect(cells[shell.x]!.bg.toString()).toBe(canvas.toString())
        expect(cells[shell.x]!.fg.toString()).toBe(
          RGBA.fromHex(palette.blueBright).toString(),
        )
        // Both padding columns, the input, and the right edge remain filled.
        for (const x of [
          shell.x + 1,
          shell.x + 2,
          input.x,
          shell.x + shell.width - 1,
        ])
          expect(cells[x]!.bg.toString()).toBe(surface.toString())
      }
    } finally {
      await act(async () => h.renderer.destroy())
      selectTheme("ember-tide")
    }
  })
}
