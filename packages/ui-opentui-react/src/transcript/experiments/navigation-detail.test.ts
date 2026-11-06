import { expect, test } from "bun:test"
import { CodeRenderable, type TreeSitterClient } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, createElement } from "react"
import { createEmberTideSyntax } from "../../theme"
import { NavigationDetailGate } from "./navigation-detail"

test("deferred code decoration preserves native text and wrapped geometry", async () => {
  const gate = new NavigationDetailGate(60_000)
  const calls: string[] = []
  const client = gate.client({
    highlightOnce: async (_content: string, filetype: string) => {
      calls.push(filetype)
      return { highlights: [[0, 5, "keyword"]] }
    },
  } as unknown as TreeSitterClient)
  gate.motion()
  // Markdown concealment must remain available while fenced code waits.
  await client.highlightOnce("**bold**", "markdown")
  expect(calls).toEqual(["markdown"])
  const syntax = createEmberTideSyntax()
  const content =
    'const longValue = "this code wraps across narrow terminal rows"\nreturn longValue'
  const h = await testRender(
    createElement("code", {
      id: "deferred-code",
      content,
      filetype: "typescript",
      syntaxStyle: syntax,
      treeSitterClient: client,
      conceal: false,
      drawUnstyledText: true,
      width: "100%",
      wrapMode: "word",
    }),
    { width: 24, height: 12 },
  )
  try {
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
    const code = h.renderer.root.getRenderable(
      "deferred-code",
    ) as CodeRenderable
    const beforeText = h.captureCharFrame()
    const beforeLines = structuredClone(code.lineInfo)
    const beforeHeight = code.height
    expect(beforeText).toContain("const longValue")
    expect(calls).toEqual(["markdown"])
    gate.dispose()
    await act(async () => {
      await code.highlightingDone
      await h.flush()
      await h.renderOnce()
    })
    expect(calls).toEqual(["markdown", "typescript"])
    expect(h.captureCharFrame()).toEqual(beforeText)
    expect(code.lineInfo).toEqual(beforeLines)
    expect(code.height).toEqual(beforeHeight)
  } finally {
    gate.dispose()
    await act(async () => h.renderer.destroy())
    syntax.destroy()
  }
})

test("repeated motion extends waiting and disposal releases pending tasks", async () => {
  const gate = new NavigationDetailGate(30)
  gate.motion()
  let released = false
  const pending = gate.whenIdle().then(() => {
    released = true
  })
  gate.motion()
  await Promise.resolve()
  expect(released).toBe(false)
  gate.dispose()
  await pending
  expect(released).toBe(true)
  expect(gate.active).toBe(false)
})
