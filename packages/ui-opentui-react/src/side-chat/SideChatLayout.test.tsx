import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { act, useMemo, useState } from "react"
import { itemId, threadId, turnId } from "@vimex/conversation"
import { initialWorkbench, transitionWorkbench, type WorkbenchCommand } from "@vimex/workbench"
import { VimexRoot } from "../index"
import { inertController, type VimexUiController } from "../contracts"

const parent = threadId("parent"), child = threadId("side")
async function harness(width = 140, height = 36, initiallyOpen = true) {
  let initial = initialWorkbench()
  for (const id of [parent, child]) {
    initial = transitionWorkbench(initial, { type: "thread.open", summary: { id, title: id === parent ? "Parent task" : "Side questions", cwd: "/tmp", model: "test", reasoningEffort: "medium", status: "working" } }).state
    initial = transitionWorkbench(initial, { type: "conversation.event", event: { type: "item.started", threadId: id, item: { id: itemId(`${id}-answer`), turnId: turnId(`${id}-turn`), kind: "assistant", markdown: `${id} unique answer\n\n` + Array.from({ length: 35 }, (_, n) => `${id} line ${n}`).join("\n\n"), status: "running" } } }).state
    initial = transitionWorkbench(initial, { type: "composer.change", text: `${id} draft`, cursorOffset: 2 }).state
    initial = transitionWorkbench(initial, { type: "interaction.command", command: { type: "focus.set", surface: "composer" } }).state
  }
  initial = { ...initial, sideChats: { [parent]: { parentId: parent, threadId: child, visible: true, maximized: false, contextLabel: "Parent snapshot" } } }
  if (!initiallyOpen) initial = { ...initial, activeThreadId: parent, sideChats: {} }
  let beginOpening!: () => void
  let associate!: (open: boolean) => void
  let observed = initial
  let update!: (command: WorkbenchCommand) => void
  const actions: string[] = []
  function Harness() {
    const [state, setState] = useState(initial)
    beginOpening = () => setState(current => ({ ...current, activeThreadId: parent, sideChats: { [parent]: { parentId: parent, visible: true, maximized: false, status: "creating" } } }))
    associate = open => setState(current => ({ ...current, activeThreadId: open ? child : parent, sideChats: open ? { [parent]: { parentId: parent, threadId: child, visible: true, maximized: false } } : {} }))
    observed = state
    update = command => setState(current => transitionWorkbench(current, command).state)
    const controller = useMemo<VimexUiController>(() => ({ ...inertController,
      dispatchInteraction(command) { update({ type: "interaction.command", command }) },
      changeDraft(text, cursorOffset) { update({ type: "composer.change", text, cursorOffset }) },
      anchorThread(threadId, point, preferredScreenRow) { update({ type: "transcript.command", threadId, command: { type: "viewport.anchor", point, preferredScreenRow } }) },
      sideChat(action) {
        actions.push(action)
        setState(current => {
          const side = current.sideChats[parent]!
          if (action === "parent" || action === "side" || action === "cycle") return { ...current, activeThreadId: action === "parent" || (action === "cycle" && current.activeThreadId === child) ? parent : child }
          if (action === "close") return { ...current, activeThreadId: parent, sideChats: { [parent]: { ...side, visible: false } } }
          return { ...current, sideChats: { [parent]: { ...side, maximized: action === "maximize" ? !side.maximized : false } } }
        })
      },
    }), [])
    return <VimexRoot state={state} controller={controller} />
  }
  const setup = await testRender(<Harness />, { width, height })
  const settle = async () => act(async () => { await setup.flush(); await setup.renderOnce() })
  await settle()
  const key = async (name: string, ctrl = false) => act(async () => { setup.mockInput.pressKey(name, { ctrl }); if (name === "ESCAPE") await Bun.sleep(30); await setup.flush(); await setup.renderOnce() })
  const windowKey = async (name: string) => { await key("w", true); await key(name); await settle() }
  return { ...setup, settle, key, windowKey, actions, state: () => observed, update, beginOpening: () => beginOpening(), associate: (open: boolean) => associate(open), close: () => act(async () => setup.renderer.destroy()) }
}

test("side split shows both transcripts, routes input to focused composer, and maximizes/restores", async () => {
  const h = await harness()
  try {
    expect(h.captureCharFrame()).toContain("SIDE · focused")
    const main = h.renderer.root.findDescendantById("main-pane")!
    const side = h.renderer.root.findDescendantById("side-pane")!
    expect(main.x).toBe(0)
    expect(side.x).toBeGreaterThan(main.width)
    expect(main.findDescendantById("transcript")).toBeDefined()
    expect(side.findDescendantById("transcript")).toBeDefined()
    await h.key("i")
    await act(async () => { await h.mockInput.typeText("X"); await h.flush() })
    expect(h.state().workspaces[child]!.composer.text).toContain("X")
    expect(h.state().workspaces[parent]!.composer.text).toBe("parent draft")
    await h.windowKey("h")
    expect(h.state().activeThreadId).toBe(parent)
    await h.windowKey("l")
    expect(h.state().activeThreadId).toBe(child)
    await h.windowKey("|")
    expect(h.renderer.root.findDescendantById("main-pane")!.visible).toBe(false)
    expect(h.renderer.root.findDescendantById("side-pane")!.width).toBe(140)
    await h.windowKey("=")
    expect(h.renderer.root.findDescendantById("main-pane")).toBeDefined()
    await h.windowKey("w")
    expect(h.state().activeThreadId).toBe(parent)
    await h.windowKey("c")
    expect(h.renderer.root.findDescendantById("side-chat-layout")).toBeUndefined()
    expect(h.state().workspaces[child]!.composer.text).toContain("X")
  } finally { await h.close() }
})

test("narrow side layout stacks panes and rename leader hints focused title", async () => {
  const h = await harness(80, 32)
  try {
    const main = h.renderer.root.findDescendantById("main-pane")!
    const side = h.renderer.root.findDescendantById("side-pane")!
    expect(side.y).toBeGreaterThan(main.y + main.height)
    expect(side.width).toBe(80)
    expect(h.renderer.root.findDescendantById("inactive-composer")).toBeUndefined()
    await act(async () => { await h.mockInput.typeText(" r"); await h.flush(); await h.renderOnce() })
    expect(h.state().workspaces[child]!.interaction.commandLine).toBe("rename ")
    expect(h.captureCharFrame()).toContain("Current name: Side questions")
    expect(h.state().workspaces[parent]!.interaction.mode).toBe("normal")
  } finally { await h.close() }
})

test("Flash labels use side-local coordinates and jumping preserves the other pane", async () => {
  const h = await harness()
  try {
    await h.key("s")
    await act(async () => { await h.mockInput.typeText("line 34"); await h.flush(); await h.renderOnce() })
    const label = h.renderer.root.findDescendantById("flash-label:a")!
    const side = h.renderer.root.findDescendantById("side-pane")!
    expect(label).toBeDefined()
    expect(label.screenX).toBeGreaterThan(side.screenX)
    expect(label.screenX).toBeLessThan(side.screenX + side.width)
    await h.key("RETURN")
    expect(h.state().workspaces[parent]!.composer.text).toBe("parent draft")
  } finally { await h.close() }
})


test("pane focus retains composer Visual selection and Ex history", async () => {
  const h = await harness()
  try {
    await h.key("v")
    await h.key("l")
    const side = h.renderer.root.findDescendantById("side-pane")!
    const composer = side.findDescendantById("composer") as TextareaRenderable
    const selection = composer.getSelection()
    expect(selection).not.toBeNull()
    await h.windowKey("h")
    await h.windowKey("l")
    expect(side.findDescendantById("composer")).toBe(composer)
    expect(composer.getSelection()).toEqual(selection)
    await h.key("ESCAPE")
    await act(async () => { await h.mockInput.typeText(":rename Side renamed"); await h.flush() })
    await h.key("RETURN")
    await h.windowKey("h")
    await h.windowKey("l")
    await h.key(":")
    await h.key("p", true)
    expect(h.state().workspaces[child]!.interaction.commandLine).toBe("rename Side renamed")
  } finally { await h.close() }
})

test("short terminals maximize active pane while retaining live parent status", async () => {
  const h = await harness(80, 16)
  try {
    expect(h.renderer.root.findDescendantById("main-pane")!.visible).toBe(false)
    const side = h.renderer.root.findDescendantById("side-pane")!
    expect(side.visible).toBe(true)
    expect(side.findDescendantById("transcript")!.height).toBeGreaterThan(0)
    expect(h.captureCharFrame()).toContain("Main:")
    await h.windowKey("h")
    expect(h.renderer.root.findDescendantById("main-pane")!.visible).toBe(true)
    expect(h.renderer.root.findDescendantById("side-pane")!.visible).toBe(false)
  } finally { await h.close() }
})

test("mouse wheel in unfocused parent preserves side draft and updates only parent anchor", async () => {
  const h = await harness()
  try {
    const main = h.renderer.root.findDescendantById("main-pane")!
    const scroll = main.findDescendantById("transcript") as ScrollBoxRenderable
    const sideViewport = h.state().workspaces[child]!.transcript.viewport
    await act(async () => {
      await h.mockMouse.scroll(scroll.screenX + 8, scroll.screenY + 3, "up")
      await h.flush(); await h.renderOnce()
    })
    await h.settle()
    expect(h.state().activeThreadId).toBe(child)
    expect(h.state().workspaces[parent]!.transcript.viewport.kind).toBe("point")
    expect(h.state().workspaces[child]!.transcript.viewport).toEqual(sideViewport)
    expect(h.state().workspaces[child]!.composer.text).toBe("side draft")
  } finally { await h.close() }
})


test("first side open and retirement preserve the mounted parent composer", async () => {
  const h = await harness(140, 36, false)
  try {
    const composer = h.renderer.root.findDescendantById("main-pane")!.findDescendantById("composer") as TextareaRenderable
    await h.key("v")
    await h.key("l")
    const selection = composer.getSelectedText()
    expect(selection.length).toBeGreaterThan(0)
    await act(async () => { h.associate(true); await h.flush(); await h.renderOnce() })
    await h.settle()
    expect(h.renderer.root.findDescendantById("main-pane")!.findDescendantById("composer") === composer).toBe(true)
    await act(async () => { h.associate(false); await h.flush(); await h.renderOnce() })
    await h.settle()
    expect(h.renderer.root.findDescendantById("main-pane")!.findDescendantById("composer") === composer).toBe(true)
    expect(composer.getSelectedText()).toBe(selection)
    expect(h.state().workspaces[parent]!.interaction.mode).toBe("visual")
    expect(h.captureCharFrame()).not.toContain("SIDE ·")
  } finally { await h.close() }
})


test("pending side creation immediately shows a right placeholder without stealing parent input", async () => {
  const h = await harness(140, 36, false)
  try {
    const composer = h.renderer.root.findDescendantById("main-pane")!.findDescendantById("composer")
    await act(async () => { h.beginOpening(); await h.flush() })
    await h.settle()
    const main = h.renderer.root.findDescendantById("main-pane")!
    const opening = h.renderer.root.findDescendantById("side-opening")!
    expect(Boolean(opening)).toBe(true)
    expect(opening.screenX).toBeGreaterThan(main.screenX + main.width)
    expect(main.findDescendantById("composer") === composer).toBe(true)
    expect(h.captureCharFrame()).toContain("Opening side chat…")
    await h.key("i")
    await act(async () => { await h.mockInput.typeText("X"); await h.flush() })
    expect(h.state().activeThreadId).toBe(parent)
    expect(h.state().workspaces[parent]!.composer.text).toContain("X")
    expect(h.state().workspaces[child]!.composer.text).toBe("side draft")
    await act(async () => { h.associate(true); await h.flush() })
    await h.settle()
    expect(h.renderer.root.findDescendantById("side-opening")).toBeUndefined()
    expect(h.renderer.root.findDescendantById("side-pane")!.visible).toBe(true)
  } finally { await h.close() }
})
