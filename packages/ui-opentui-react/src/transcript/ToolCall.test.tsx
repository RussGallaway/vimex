import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { act } from "react"
import { itemId, threadId, turnId, type ConversationItem } from "@vimex/conversation"
import { initialWorkbench, transitionWorkbench } from "@vimex/workbench"
import { graphemes } from "@vimex/transcript"
import { ToolCall } from "./ToolCall"
import { ReasoningBlock } from "./ReasoningBlock"
import { createEmberTideSyntax } from "../theme"
import { VimexRoot } from "../index"
import { inertController } from "../contracts"
import { measureRenderedTranscript } from "./rendered-layout"

const command: Extract<ConversationItem, { kind: "command" | "tool" }> = {
  id: itemId("exact-command"), turnId: turnId("tool-turn"), kind: "command", title: "Read project files", status: "complete", durationMs: 1250,
  executionCommand: "Command --literal 'two words'\nprintf '%s\\n' exact", detail: "Output must remain exact\nsecond output line",
}

for (const folded of [true, false]) {
  test(`command ${folded ? "collapsed" : "expanded"} shows concise fold header and exact body`, async () => {
    const h = await testRender(<ToolCall item={command} folded={folded} />, { width: 80, height: 18 })
    try {
      await act(async () => h.flush())
      const frame = h.captureCharFrame()
      expect(frame).toContain(folded ? "▸" : "▾")
      expect(frame).toContain("Read project files")
      expect(frame).toContain("1.3s")
      expect(frame).not.toContain("[open]")
      expect(frame).not.toContain("[closed]")
      if (folded) {
        expect(h.renderer.root.findDescendantById(`command-source:${command.id}`)).toBeUndefined()
        expect(h.renderer.root.findDescendantById(`tool-output:${command.id}`)).toBeUndefined()
      } else {
        expect((h.renderer.root.findDescendantById(`command-source:${command.id}`) as TextRenderable).plainText).toBe(command.executionCommand!)
        expect((h.renderer.root.findDescendantById(`tool-output:${command.id}`) as TextRenderable).plainText).toBe(command.detail)
      }
    } finally { await act(async () => h.renderer.destroy()) }
  })
}

test("only command items render execution command metadata", async () => {
  const h = await testRender(<ToolCall item={{ ...command, kind: "tool" }} folded={false} />, { width: 80, height: 18 })
  try {
    await act(async () => h.flush())
    expect(h.renderer.root.findDescendantById(`command-source:${command.id}`)).toBeUndefined()
    expect((h.renderer.root.findDescendantById(`tool-output:${command.id}`) as TextRenderable).plainText).toBe(command.detail)
  } finally { await act(async () => h.renderer.destroy()) }
})

test("reasoning folds use the same compact disclosure indicator", async () => {
  const syntax = createEmberTideSyntax()
  const h = await testRender(<ReasoningBlock item={{ id: itemId("thought"), turnId: turnId("thought-turn"), kind: "reasoning", status: "complete", markdown: "**Reviewing files**\n\nDetailed reasoning" }} folded syntax={syntax} />, { width: 70, height: 10 })
  try {
    await act(async () => h.flush())
    expect(h.captureCharFrame()).toContain("▸")
    expect(h.captureCharFrame()).toContain("Reviewing files")
    expect(h.captureCharFrame()).not.toContain("Detailed reasoning")
    expect(h.captureCharFrame()).not.toContain("[closed]")
  } finally { await act(async () => h.renderer.destroy()); syntax.destroy() }
})

test("command and output cursor geometry excludes matching decorative labels", async () => {
  const thread = threadId("tool-geometry")
  let state = transitionWorkbench(initialWorkbench(), { type: "thread.open", summary: { id: thread, title: "Tools", cwd: "/work", model: "test", reasoningEffort: "high", status: "idle" } }).state
  state = transitionWorkbench(state, { type: "conversation.event", event: { type: "item.started", threadId: thread, item: command } }).state
  const h = await testRender(<VimexRoot state={state} controller={inertController} />, { width: 80, height: 30 })
  try {
    await act(async () => { await h.flush(); await h.renderOnce() })
    const transcript = state.workspaces[thread]!.transcript
    const projection = transcript.projectionById[command.id]!
    expect(projection.source).toBe([command.title, command.executionCommand, command.detail].join("\n"))
    const layout = measureRenderedTranscript(h.renderer, h.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable, transcript)!
    const source = h.renderer.root.findDescendantById(`command-source:${command.id}`)!
    const output = h.renderer.root.findDescendantById(`tool-output:${command.id}`)!
    const commandStart = graphemes(`${command.title}\n`).length
    const outputStart = graphemes(`${command.title}\n${command.executionCommand}\n`).length
    expect(layout.points?.[command.id]?.[commandStart]?.screenY).toBe(source.y)
    expect(layout.points?.[command.id]?.[outputStart]?.screenY).toBe(output.y)
  } finally { await act(async () => h.renderer.destroy()) }
})


for (const folded of [false, true]) test(`truncated long tool title keeps every logical cursor inside the narrow terminal (${folded ? "folded" : "expanded"})`, async () => {
  const thread = threadId("narrow-tool")
  const item = { ...command, title: "Read " + "longpath/".repeat(15) + "file.ts" }
  let state = transitionWorkbench(initialWorkbench(), { type: "thread.open", summary: { id: thread, title: "Tools", cwd: "/work", model: "test", reasoningEffort: "high", status: "idle" } }).state
  state = transitionWorkbench(state, { type: "conversation.event", event: { type: "item.started", threadId: thread, item } }).state
  state = transitionWorkbench(state, { type: "transcript.command", command: { type: "fold.set", itemId: item.id, folded } }).state
  const h = await testRender(<VimexRoot state={state} controller={inertController} />, { width: 50, height: 30 })
  try {
    await act(async () => { await h.flush(); await h.renderOnce() })
    const transcript = state.workspaces[thread]!.transcript
    const projection = transcript.projectionById[item.id]!
    const layout = measureRenderedTranscript(h.renderer, h.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable, transcript)!
    const points = layout.points![item.id]!
    if (folded) expect(Object.keys(points).length).toBeLessThan(graphemes(projection.plain).length)
    else expect(Object.keys(points)).toHaveLength(graphemes(projection.plain).length + 1)
    expect(Object.values(points).every(point => point.screenX >= 0 && point.screenX < 50)).toBe(true)
    expect(projection.source).toBe([item.title, item.executionCommand, item.detail].join("\n"))
    if (!folded) {
      const source = h.renderer.root.findDescendantById(`command-source:${item.id}`)!
      const output = h.renderer.root.findDescendantById(`tool-output:${item.id}`)!
      expect(points[graphemes(`${item.title}\n`).length]?.screenY).toBe(source.y)
      expect(points[graphemes(`${item.title}\n${item.executionCommand}\n`).length]?.screenY).toBe(output.y)
    }
  } finally { await act(async () => h.renderer.destroy()) }
})

test("native tool output cursor positions count combining graphemes without losing columns", async () => {
  const thread = threadId("combining-tool")
  const item = { ...command, title: "Output sample", executionCommand: undefined, detail: "éZ界́Q" }
  let state = transitionWorkbench(initialWorkbench(), { type: "thread.open", summary: { id: thread, title: "Tools", cwd: "/work", model: "test", reasoningEffort: "high", status: "idle" } }).state
  state = transitionWorkbench(state, { type: "conversation.event", event: { type: "item.started", threadId: thread, item } }).state
  const h = await testRender(<VimexRoot state={state} controller={inertController} />, { width: 60, height: 24 })
  try {
    await act(async () => { await h.flush(); await h.renderOnce() })
    const transcript = state.workspaces[thread]!.transcript
    const layout = measureRenderedTranscript(h.renderer, h.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable, transcript)!
    const points = layout.points![item.id]!
    const start = graphemes(`${item.title}\n`).length
    const origin = points[start]!.screenX
    expect([0, 1, 2, 3].map(offset => points[start + offset]!.screenX - origin)).toEqual([0, 1, 2, 4])
  } finally { await act(async () => h.renderer.destroy()) }
})
