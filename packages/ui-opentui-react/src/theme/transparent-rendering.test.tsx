import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { expect, test } from "bun:test"
import { act } from "react"
import { initialWorkbench } from "@vimex/workbench"
import { FullscreenShell } from "../app/FullscreenShell"
import { OverlayFrame } from "../app/OverlayFrame"
import { TelescopeModal } from "../composer/TelescopeModal"
import { createEmberTideSyntax, selectTheme, themePalette } from "."

test("transparent canvas preserves opaque badge text and floating dialog surfaces", async () => {
  const palette = selectTheme("charcoal-transparent")
  const h = await testRender(
    <FullscreenShell
      threadRole="PARENT"
      connection={initialWorkbench().connection}
      working={false}
      transcript={<text fg={palette.text}>CANVAS SAMPLE</text>}
      composer={<text bg={palette.backgroundRaised}>COMPOSER SAMPLE</text>}
      statusline={<text bg={palette.backgroundPanel}>STATUS SAMPLE</text>}
    />,
    { width: 80, height: 20 },
  )
  try {
    await h.renderOnce()
    const spans = h.captureSpans().lines.flatMap((line) => line.spans)
    for (const text of ["CANVAS SAMPLE", "COMPOSER SAMPLE", "STATUS SAMPLE"])
      expect(spans.find((span) => span.text.includes(text))!.bg.a).toBe(0)
    const badge = spans.find((span) => span.text.includes("PARENT"))!
    expect(badge.fg.a).toBe(1)
    expect(badge.fg.toString()).toBe(RGBA.fromHex("#151515").toString())
    expect(badge.bg.toString()).toBe(
      RGBA.fromHex(palette.blueBright).toString(),
    )
  } finally {
    await act(async () => h.renderer.destroy())
    selectTheme("ember-tide")
  }
  selectTheme("charcoal-transparent")
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
      RGBA.fromHex(themePalette("charcoal").backgroundRaised).toString(),
    )
    expect(span.bg.a).toBe(1)
  } finally {
    await act(async () => dialog.renderer.destroy())
    selectTheme("ember-tide")
  }
})

test("transparent telescope picker renders a valid backdrop and solid dialog", async () => {
  selectTheme("charcoal-transparent")
  const syntax = createEmberTideSyntax("charcoal-transparent")
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
