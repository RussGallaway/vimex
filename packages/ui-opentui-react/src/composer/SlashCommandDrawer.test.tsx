import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { TextareaRenderable } from "@opentui/core"
import { act, useMemo, useState } from "react"
import { threadId } from "@vimex/conversation"
import { initialWorkbench, transitionWorkbench } from "@vimex/workbench"
import { VimexRoot } from "../index"
import { inertController, type VimexUiController } from "../contracts"
import { slashCommandChoices } from "./slash-commands"

async function harness(width = 80, height = 24, kittyKeyboard = false) {
  const id = threadId("slash")
  let initial = transitionWorkbench(initialWorkbench(), { type: "thread.open", summary: {
    id, title: "Slash commands", cwd: "/work", model: "test", reasoningEffort: "high", status: "idle",
  } }).state
  initial = transitionWorkbench(initial, { type: "interaction.command", command: { type: "mode.insert" } }).state
  const executed: string[] = []
  const submitted: string[] = []
  let observed = initial
  function Harness() {
    const [state, setState] = useState(initial)
    observed = state
    const controller = useMemo<VimexUiController>(() => ({ ...inertController,
      dispatchInteraction(command) { setState(current => transitionWorkbench(current, { type: "interaction.command", command }).state) },
      changeDraft(text, cursorOffset) { setState(current => transitionWorkbench(current, { type: "composer.change", text, cursorOffset }).state) },
      executeCommand(command) { executed.push(command) },
      submit() { submitted.push(observed.workspaces[id]!.composer.text) },
    }), [])
    return <VimexRoot state={state} controller={controller} />
  }
  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => { setup = await testRender(<Harness />, { width, height, kittyKeyboard }); await setup.flush() })
  const keys = async (text: string) => {
    await act(async () => { await setup.mockInput.typeText(text); await setup.flush() })
    await act(async () => { await setup.flush(); await setup.renderOnce() })
  }
  return { ...setup, executed, submitted, keys, workspace: () => observed.workspaces[id]!, close: async () => { await act(async () => setup.renderer.destroy()) } }
}

test("slash choices reuse Ex commands, aliases and literal arguments", () => {
  expect(slashCommandChoices("/he")).toEqual(["help"])
  expect(slashCommandChoices("/models")).toEqual(["models"])
  expect(slashCommandChoices("/cwd /work/a path")).toEqual(["cwd /work/a path"])
  expect(slashCommandChoices("/theme ka")).toEqual(["theme kanagawa"])
  expect(slashCommandChoices("/unknown")).toEqual([])
  expect(slashCommandChoices("/help\ntext")).toEqual([])
})

for (const [width, height] of [[80, 24], [48, 18]] as const) {
  test(`slash drawer opens above fixed composer and Enter executes at ${width}x${height}`, async () => {
    const h = await harness(width, height)
    try {
      const composer = h.renderer.root.findDescendantById("composer-shell")!
      const before = { y: composer.y, height: composer.height }
      await h.keys("/he")
      const drawer = h.renderer.root.findDescendantById("slash-command-drawer")!
      expect(drawer).toBeDefined()
      expect(drawer.y).toBeGreaterThanOrEqual(0)
      expect(drawer.y + drawer.height).toBeLessThanOrEqual(composer.y)
      expect(composer.y).toBe(before.y)
      expect(composer.height).toBe(before.height)
      expect(h.captureCharFrame()).toContain("/help")
      expect(h.captureCharFrame()).toContain("Show keyboard help")
      await act(async () => { h.mockInput.pressKey("RETURN"); await h.flush() })
      expect(h.executed).toEqual(["help"])
      expect(h.submitted).toEqual([])
      expect(h.workspace().composer.text).toBe("")
      expect(h.workspace().interaction.mode).toBe("normal")
      expect(h.renderer.root.findDescendantById("slash-command-drawer")).toBeUndefined()
    } finally { await h.close() }
  })
}

test("slash selection keys and Tab complete without executing the first command", async () => {
  const h = await harness()
  try {
    await h.keys("/")
    await act(async () => { h.mockInput.pressKey("n", { ctrl: true }); h.mockInput.pressKey("TAB"); await h.flush() })
    expect((h.renderer.root.findDescendantById("composer") as TextareaRenderable).plainText).toBe("/sessions")
    expect(h.executed).toEqual([])
    await act(async () => { h.mockInput.pressKey("RETURN"); await h.flush() })
    expect(h.executed).toEqual(["sessions"])
  } finally { await h.close() }
})

test("unknown slash input cannot execute or submit and Escape dismisses into Normal", async () => {
  const h = await harness()
  try {
    await h.keys("/unknown")
    expect(h.captureCharFrame()).toContain("No matching commands")
    await act(async () => { h.mockInput.pressKey("RETURN"); await h.flush() })
    expect(h.executed).toEqual([])
    expect(h.submitted).toEqual([])
    expect(h.workspace().composer.text).toBe("/unknown")
    await act(async () => { h.mockInput.pressKey("ESCAPE"); await h.flush() })
    for (let n = 0; n < 20 && h.workspace().interaction.mode !== "normal"; n++) {
      await act(async () => { await Bun.sleep(5); await h.flush() })
    }
    expect(h.workspace().interaction.mode).toBe("normal")
    expect(h.renderer.root.findDescendantById("slash-command-drawer")).toBeUndefined()
  } finally { await h.close() }
})


test("batched slash text and Return use the live filtered command", async () => {
  const h = await harness()
  try {
    await act(async () => { await h.mockInput.pressKeys(["/", "h", "e", "RETURN"], 0); await h.flush() })
    expect(h.executed).toEqual(["help"])
    expect(h.submitted).toEqual([])
    expect(h.workspace().composer.text).toBe("")
  } finally { await h.close() }
})


test("batched unknown slash input remains editable after Return", async () => {
  const h = await harness()
  try {
    await act(async () => { await h.mockInput.pressKeys(["/", "z", "z", "z", "RETURN"], 0); await h.flush() })
    expect(h.executed).toEqual([])
    expect(h.submitted).toEqual([])
    expect(h.workspace().composer.text).toBe("/zzz")
    expect((h.renderer.root.findDescendantById("composer") as TextareaRenderable).plainText).toBe("/zzz")
  } finally { await h.close() }
})

test("Ctrl-Enter executes a slash command instead of steering its text", async () => {
  const h = await harness(80, 24, true)
  try {
    await h.keys("/he")
    await act(async () => { h.mockInput.pressEnter({ ctrl: true }); await h.flush() })
    expect(h.executed).toEqual(["help"])
    expect(h.submitted).toEqual([])
    expect(h.workspace().composer.text).toBe("")
  } finally { await h.close() }
})


test("Insert slash filtering keeps j/k as query letters", async () => {
  const h = await harness()
  try {
    await h.keys("/jk")
    expect((h.renderer.root.findDescendantById("composer") as TextareaRenderable).plainText).toBe("/jk")
    expect(h.captureCharFrame()).toContain("No matching commands")
    expect(h.executed).toEqual([])
  } finally { await h.close() }
})
