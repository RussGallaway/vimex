import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useMemo, useState } from "react"
import { threadId, type ThreadId } from "@vimex/conversation"
import { initialWorkbench, transitionWorkbench } from "@vimex/workbench"
import { VimexRoot } from "../index"
import { inertController, type VimexUiController } from "../contracts"

async function fixture() {
  const active = threadId("active"), other = threadId("other")
  let initial = initialWorkbench()
  for (const id of [other, active]) initial = transitionWorkbench(initial, { type: "thread.open", summary: {
    id, title: id === active ? "Active session" : "Other session", cwd: "/tmp", model: "test", reasoningEffort: "high", status: "idle", updatedAt: id === active ? 20 : 10,
  } }).state
  initial = { ...initial, threadOrder: [active, other] }
  initial = transitionWorkbench(initial, { type: "interaction.command", command: { type: "overlay.open", overlay: "sessions" } }).state
  const renamed: { id: ThreadId; title: string }[] = [], favorites: ThreadId[] = []
  function Harness() {
    const [state, setState] = useState(initial)
    const controller = useMemo<VimexUiController>(() => ({ ...inertController,
      dispatchInteraction(command) { setState(current => transitionWorkbench(current, { type: "interaction.command", command }).state) },
      renameThread(id, title) { renamed.push({ id, title }); setState(current => ({ ...current, summaries: { ...current.summaries, [id]: { ...current.summaries[id]!, title } } })) },
      toggleFavorite(id) { favorites.push(id); setState(current => ({ ...current, favoriteThreadIds: current.favoriteThreadIds.includes(id) ? current.favoriteThreadIds.filter(value => value !== id) : [...current.favoriteThreadIds, id] })) },
    }), [])
    return <VimexRoot state={state} controller={controller} />
  }
  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => { setup = await testRender(<Harness />, { width: 110, height: 30 }); await setup.flush() })
  return { ...setup, active, other, renamed, favorites }
}

test("favorites keep the selected non-active session targeted after reordering", async () => {
  const setup = await fixture()
  try {
    await act(async () => { setup.mockInput.pressKey("ARROW_DOWN"); await setup.flush() })
    await act(async () => { setup.mockInput.pressKey("f", { ctrl: true }); await setup.flush() })
    expect(setup.favorites).toEqual([setup.other])
    expect(setup.captureCharFrame()).toContain("★")
    await act(async () => { setup.mockInput.pressKey("r", { ctrl: true }); await setup.flush() })
    expect(setup.captureCharFrame()).toContain("Rename: Other session")
    await act(async () => { setup.mockInput.pressKey("u", { ctrl: true }); await setup.mockInput.typeText("Renamed other"); setup.mockInput.pressEnter(); await setup.flush() })
    expect(setup.renamed).toEqual([{ id: setup.other, title: "Renamed other" }])
    expect(setup.captureCharFrame()).toContain("Sessions")
    expect(setup.captureCharFrame()).not.toContain("Rename:")
  } finally { await act(async () => setup.renderer.destroy()) }
})

test("Escape cancels inline rename without closing the picker or changing the title", async () => {
  const setup = await fixture()
  try {
    await act(async () => { setup.mockInput.pressKey("r", { ctrl: true }); await setup.flush() })
    await act(async () => { await setup.mockInput.typeText(" edited"); await setup.flush() })
    await act(async () => { setup.mockInput.pressKey("ESCAPE"); await new Promise(resolve => setTimeout(resolve, 60)); await setup.flush() })
    expect(setup.renamed).toEqual([])
    expect(setup.captureCharFrame()).toContain("Sessions")
    expect(setup.captureCharFrame()).not.toContain("Rename:")
    await act(async () => { await setup.mockInput.typeText("Other"); await setup.flush() })
    expect(setup.captureCharFrame()).toContain("/ Other")
  } finally { await act(async () => setup.renderer.destroy()) }
})
