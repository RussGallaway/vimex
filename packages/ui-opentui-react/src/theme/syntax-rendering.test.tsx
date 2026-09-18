import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { themeNames } from "@vimex/interaction"
import { createEmberTideSyntax, themePalette } from "."

for (const name of themeNames) test(`${name} renders parsed code with its own token colors`, async () => {
  const syntax = createEmberTideSyntax(name)
  const palette = themePalette(name)
  const h = await testRender(<code content={'function greet() { return "hello" + 42 }'} filetype="typescript" syntaxStyle={syntax} fg={palette.text} bg={palette.background} />, { width: 70, height: 4 })
  const spans = () => h.captureSpans().lines.flatMap(line => line.spans)
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      await act(async () => { await Bun.sleep(10); await h.flush(); await h.renderOnce() })
      if (spans().find(span => span.text === "function")?.fg.toString() === syntax.getStyle("keyword")!.fg!.toString()) break
    }
    for (const [text, scope] of [["function", "keyword"], ["greet", "function"], ['"hello"', "string"], ["42", "number"]]) {
      const token = spans().find(span => span.text.includes(text!))
      expect(token).toBeDefined()
      expect(token!.fg.toString()).toBe(syntax.getStyle(scope!)!.fg!.toString())
    }
  } finally { await act(async () => h.renderer.destroy()); syntax.destroy() }
})
