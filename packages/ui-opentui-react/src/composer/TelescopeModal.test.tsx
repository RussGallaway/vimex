import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import {
  type CodeRenderable,
  type InputRenderable,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core"
import { act, createRef } from "react"
import { threadId, type MentionCandidate } from "@vimex/conversation"
import { initialWorkbench, transitionWorkbench } from "@vimex/workbench"
import { TelescopeModal } from "./TelescopeModal"
import { createEmberTideSyntax } from "../theme"
import { inertController, type TranscriptUiCommand } from "../contracts"
import { VimexRoot } from "../index"

const longPreview = Array.from(
  { length: 120 },
  (_, index) => `const value${index} = ${index}`,
).join("\n")

test("Telescope preview uses the transcript syntax palette and preserves literal source", async () => {
  const syntax = createEmberTideSyntax("nord")
  const setup = await testRender(
    <TelescopeModal
      title="Files"
      query="src app"
      syntax={syntax}
      choices={[
        { kind: "file", name: "src/App.tsx", path: "/work/src/App.tsx" },
      ]}
      selected={0}
      marked={new Set(["/work/src/App.tsx"])}
      previewPath="/work/src/App.tsx"
      preview={'function greet() { return "hello" + 42 }\n// ```\n// # literal'}
      status="1/8"
    />,
    { width: 120, height: 30 },
  )
  try {
    await act(async () => setup.flush())
    const code = setup.renderer.root.findDescendantById(
      "telescope-preview-content",
    ) as CodeRenderable
    await act(async () => {
      await code.highlightingDone
      await setup.renderOnce()
    })
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Files")
    expect(frame).toContain("src app")
    expect(frame).toContain("src/App.tsx")
    expect(frame).toContain("// ```")
    expect(frame).toContain("// # literal")
    expect(code.syntaxStyle).toBe(syntax)
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    for (const [text, scope] of [
      ["function", "keyword"],
      ['"hello"', "string"],
      ["42", "number"],
    ] as const) {
      const token = spans.find((span) => span.text.includes(text))
      expect(token).toBeDefined()
      expect(token!.fg.toString()).toBe(syntax.getStyle(scope)!.fg!.toString())
    }
  } finally {
    await act(async () => setup.renderer.destroy())
    syntax.destroy()
  }
})

for (const [width, height] of [
  [80, 24],
  [200, 60],
] as const) {
  test(`preview is wider than results and clips long files within the modal at ${width}x${height}`, async () => {
    const syntax = createEmberTideSyntax()
    const previewScrollRef = createRef<ScrollBoxRenderable>()
    const setup = await testRender(
      <TelescopeModal
        title="Files"
        query=""
        syntax={syntax}
        choices={[
          {
            kind: "file",
            name: "/work/very/long/path/to/the/file/App.tsx",
            path: "/work/very/long/path/to/the/file/App.tsx",
          },
        ]}
        selected={0}
        marked={new Set()}
        previewPath="/work/src/App.tsx"
        previewScrollRef={previewScrollRef}
        preview={longPreview}
      />,
      { width, height },
    )
    try {
      await act(async () => setup.flush())
      const scroll = previewScrollRef.current!
      const find = (id: string) => setup.renderer.root.findDescendantById(id)!
      const modal = find("telescope-picker")
      const results = find("telescope-results-pane")
      const pane = find("telescope-preview-pane")
      const hint = find("telescope-hint")
      expect(pane.width).toBeGreaterThan(results.width)
      expect(pane.width / (pane.width + results.width)).toBeCloseTo(0.6, 1)
      expect(scroll.viewport.height).toBeGreaterThan(5)
      expect(scroll.scrollHeight).toBeGreaterThan(scroll.viewport.height)
      expect(scroll.screenY + scroll.height).toBeLessThanOrEqual(hint.screenY)
      expect(hint.screenY + hint.height).toBeLessThan(
        modal.screenY + modal.height,
      )
      expect(modal.screenY + modal.height).toBeLessThan(height)
      const frame = setup.captureCharFrame().split("\n")
      expect(
        frame.filter((row) => row.includes("const value")).length,
      ).toBeGreaterThan(0)
      expect(frame.slice(hint.screenY).join("\n")).not.toContain("const value")
      await act(async () => {
        scroll.scrollTo(scroll.scrollHeight)
        await setup.renderOnce()
      })
      expect(setup.captureCharFrame()).toContain("const value119")
      expect(
        setup.captureCharFrame().split("\n").slice(hint.screenY).join("\n"),
      ).not.toContain("const value")
    } finally {
      await act(async () => setup.renderer.destroy())
      syntax.destroy()
    }
  })
}

test("leader-space preview scrolls by line and half-page without changing query, draft, or transcript", async () => {
  const id = threadId("telescope-preview")
  let state = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id,
      title: "Picker",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  state = transitionWorkbench(state, {
    type: "composer.change",
    text: "Keep this draft",
    cursorOffset: 3,
  }).state
  const candidates: MentionCandidate[] = [
    "App component more.tsx",
    "App2 component more.tsx",
  ].map((name) => ({
    kind: "file",
    name: `src/${name}`,
    path: `/work/src/${name}`,
    preview: longPreview,
  }))
  const transcriptCommands: TranscriptUiCommand[] = []
  const draftChanges: string[] = []
  let searchCalls = 0
  const setup = await testRender(
    <VimexRoot
      state={state}
      controller={{
        ...inertController,
        async searchMentions() {
          searchCalls += 1
          return candidates
        },
        transcript(command) {
          transcriptCommands.push(command)
        },
        changeDraft(text) {
          draftChanges.push(text)
        },
      }}
    />,
    { width: 120, height: 36 },
  )
  const flush = async () => {
    await act(async () => setup.flush())
    await act(async () => setup.renderOnce())
  }
  const key = async (name: string, ctrl = false) => {
    await act(async () => {
      setup.mockInput.pressKey(name, { ctrl })
      await Bun.sleep(30)
      await setup.flush()
    })
    await flush()
  }
  try {
    await flush()
    await act(async () => {
      await setup.mockInput.typeText("  ")
      await setup.flush()
    })
    await flush()
    const find = (id: string) => setup.renderer.root.findDescendantById(id)!
    const scroll = find("telescope-preview") as ScrollBoxRenderable
    const input = find("telescope-query") as InputRenderable
    const composer = find("composer") as TextareaRenderable
    expect(scroll).toBeDefined()
    expect(scroll.viewport.height).toBeGreaterThan(5)
    expect(scroll.scrollTop).toBe(0)
    expect(input.focused).toBe(true)
    await act(async () => {
      await setup.mockInput.typeText("App")
      await setup.flush()
    })
    await flush()
    await act(async () => {
      await setup.mockInput.typeText(" component")
      await setup.flush()
    })
    await flush()
    expect(input.value).toBe("App component")
    expect(searchCalls).toBe(1)
    await key("ESCAPE")
    expect(input.focused).toBe(false)
    expect(setup.captureCharFrame()).toContain("NORMAL")
    await act(async () => {
      await setup.mockInput.typeText(" ")
      await setup.flush()
    })
    await flush()
    expect(setup.captureCharFrame()).toContain("✓")
    await key("i")
    expect(input.focused).toBe(true)
    await act(async () => {
      await setup.mockInput.typeText(" more")
      await setup.flush()
    })
    await flush()
    expect(input.value).toBe("App component more")
    const queryBeforeScroll = input.value
    transcriptCommands.length = 0
    await key("e", true)
    expect(scroll.scrollTop).toBe(1)
    await key("y", true)
    expect(scroll.scrollTop).toBe(0)
    await key("d", true)
    expect(scroll.scrollTop).toBe(Math.round(scroll.viewport.height / 2))
    await key("u", true)
    expect(scroll.scrollTop).toBeLessThanOrEqual(1)
    await key("d", true)
    await key("ARROW_DOWN")
    expect(scroll.scrollTop).toBe(0)
    expect(input.value).toBe(queryBeforeScroll)
    expect(composer.plainText).toBe("Keep this draft")
    expect(draftChanges).toEqual([])
    expect(transcriptCommands).toEqual([])
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})
