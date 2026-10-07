import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { expect, test } from "bun:test"
import { act } from "react"
import { initialWorkbench } from "@vimex/workbench"
import { FullscreenShell } from "../app/FullscreenShell"
import { OverlayFrame } from "../app/OverlayFrame"
import { TelescopeModal } from "../composer/TelescopeModal"
import { createEmberTideSyntax, selectTheme } from "."

const transparentThemes = [
  "charcoal-transparent",
  "charcoal-ink-transparent",
  "charcoal-copper-transparent",
  "charcoal-signal-transparent",
] as const

for (const name of transparentThemes) {
  test(`${name} preserves opaque badge text and floating dialog surfaces`, async () => {
    const palette = selectTheme(name)
    const h = await testRender(
      <FullscreenShell
        threadRole="PARENT"
        connection={initialWorkbench().connection}
        working={false}
        transcript={<text fg={palette.text}>CANVAS SAMPLE</text>}
        composer={<text bg={palette.composerBackground}>COMPOSER SAMPLE</text>}
        statusline={<text bg={palette.backgroundPanel}>STATUS SAMPLE</text>}
      />,
      { width: 80, height: 20 },
    )
    try {
      await h.renderOnce()
      const spans = h.captureSpans().lines.flatMap((line) => line.spans)
      for (const text of ["CANVAS SAMPLE", "STATUS SAMPLE"])
        expect(spans.find((span) => span.text.includes(text))!.bg.a).toBe(0)
      expect(
        spans
          .find((span) => span.text.includes("COMPOSER SAMPLE"))!
          .bg.toString(),
      ).toBe(RGBA.fromHex(palette.composerBackground!).toString())
      const badge = spans.find((span) => span.text.includes("PARENT"))!
      expect(badge.fg.a).toBe(1)
      expect(badge.fg.toString()).toBe(
        RGBA.fromHex(palette.textInverse!).toString(),
      )
      expect(badge.bg.toString()).toBe(
        RGBA.fromHex(palette.blueBright).toString(),
      )
    } finally {
      await act(async () => h.renderer.destroy())
      selectTheme("ember-tide")
    }
    selectTheme(name)
    const dialog = await testRender(
      <OverlayFrame title="Dialog" width={60}>
        <text fg={palette.text}>DIALOG SAMPLE</text>
      </OverlayFrame>,
      { width: 80, height: 20 },
    )
    try {
      await dialog.renderOnce()
      const span = dialog
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes("DIALOG SAMPLE"))!
      expect(span.bg.toString()).toBe(
        RGBA.fromHex(palette.overlayBackground!).toString(),
      )
      expect(span.bg.a).toBe(1)
    } finally {
      await act(async () => dialog.renderer.destroy())
      selectTheme("ember-tide")
    }
  })

  test(`${name} telescope picker renders a valid backdrop and solid dialog`, async () => {
    selectTheme(name)
    const syntax = createEmberTideSyntax(name)
    const h = await testRender(
      <TelescopeModal
        title="Transparent picker"
        query=""
        choices={[]}
        marked={new Set()}
        syntax={syntax}
        selected={0}
        onQuery={() => {}}
      />,
      { width: 80, height: 24 },
    )
    try {
      await h.renderOnce()
      expect(h.captureCharFrame()).toContain("Transparent picker")
      const picker = h.renderer.root.findDescendantById("telescope-picker")
      expect(picker).toBeDefined()
    } finally {
      await act(async () => h.renderer.destroy())
      syntax.destroy()
      selectTheme("ember-tide")
    }
  })
}
