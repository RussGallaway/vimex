import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useState } from "react"
import { itemId, turnId } from "@vimex/conversation"
import { createEmberTideSyntax, selectTheme, themePalette } from "../theme"
import { MarkdownMessage } from "./MarkdownMessage"
import { RGBA } from "@opentui/core"

for (const kind of ["assistant", "user"] as const) test(`${kind} theme switching refreshes nested backgrounds without remounting ordinary streamed content`, async () => {
  selectTheme("ember-tide")
  const ember = createEmberTideSyntax("ember-tide"), nord = createEmberTideSyntax("nord")
  const item = { id: itemId("theme-switch"), turnId: turnId("turn"), kind, markdown: "- LISTTEXT with `inline` code\n\n> QUOTETEXT\n\nParagraph", status: "complete" as const }
  let update!: () => void
  let stream!: () => void
  function Harness() {
    const [next, setNext] = useState(false)
    const [suffix, setSuffix] = useState("")
    stream = () => setSuffix(" streamed")
    update = () => { selectTheme("nord"); setNext(true) }
    return <box width="100%" height="100%" backgroundColor={themePalette(next ? "nord" : "ember-tide").background}><MarkdownMessage item={{ ...item, markdown: item.markdown + suffix }} syntax={next ? nord : ember} /></box>
  }
  const h = await testRender(<Harness />, { width: 80, height: 15 })
  const settle = async () => {
    for (let i = 0; i < 20; i++) await act(async () => { await Bun.sleep(5); await h.flush(); await h.renderOnce() })
  }
  try {
    await settle()
    expect(h.captureCharFrame()).toContain("LISTTEXT")
    const original = h.renderer.root.findDescendantById(`markdown:${item.id}`)
    await act(async () => stream())
    await settle()
    expect(h.renderer.root.findDescendantById(`markdown:${item.id}`)).toBe(original)
    await act(async () => update())
    await settle()
    expect(h.renderer.root.findDescendantById(`markdown:${item.id}`)).not.toBe(original)
    const spans = h.captureSpans().lines.flatMap(line => line.spans)
    for (const token of ["LISTTEXT", "QUOTETEXT"]) {
      const span = spans.find(span => span.text.includes(token))!
      expect(span).toBeDefined()
      expect(span.fg.toString()).not.toBe(RGBA.fromHex(themePalette("ember-tide").textSoft).toString())
      expect(span.bg.toString()).toBe(RGBA.fromHex(kind === "user" ? themePalette("nord").backgroundPanel : themePalette("nord").background).toString())
    }
  } finally { await act(async () => h.renderer.destroy()); ember.destroy(); nord.destroy(); selectTheme("ember-tide") }
})
