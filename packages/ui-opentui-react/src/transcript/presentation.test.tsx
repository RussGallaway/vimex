import { test, expect } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { DiffRenderable } from "@opentui/core"
import { act } from "react"
import { itemId, turnId } from "@vimex/conversation"
import { FileChange } from "./FileChange"
import { ToolCall } from "./ToolCall"
import { createEmberTideSyntax } from "../theme"

test("file edits choose split or unified presentation from real terminal width", async () => {
  for (const [width, expected] of [[80, "unified"], [140, "split"]] as const) {
    const syntax = createEmberTideSyntax()
    const setup = await testRender(<FileChange folded={false} syntax={syntax} item={{ id: itemId("edit"), turnId: turnId("turn"), kind: "edit", title: "sample.ts", status: "complete", patch: "--- a/sample.ts\n+++ b/sample.ts\n@@ -1 +1 @@\n-const n = 1\n+const n = 2\n" }} />, { width, height: 12 })
    try {
      await act(async () => setup.flush())
      const diff = setup.renderer.root.findDescendantById("diff:edit") as DiffRenderable
      expect(diff.view).toBe(expected)
      expect(setup.captureCharFrame()).toContain("const n = 2")
    } finally { await act(async () => setup.renderer.destroy()); syntax.destroy() }
  }
})

test("tool cards expose duration alongside output", async () => {
  const setup = await testRender(<ToolCall folded={false} item={{ id: itemId("command"), turnId: turnId("turn"), kind: "command", title: "run tests", detail: "All checks passed", status: "complete", durationMs: 1250 }} />, { width: 80, height: 10 })
  try {
    await act(async () => setup.flush())
    const frame = setup.captureCharFrame()
    expect(frame).toContain("1.3s")
    expect(frame).toContain("All checks passed")
  } finally { await act(async () => setup.renderer.destroy()) }
})
