import { expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { itemId, turnId } from "@vimex/conversation"
import { graphemeCount, initialTranscript, syncTranscriptItem } from "@vimex/transcript"
import { act } from "react"
import { createEmberTideSyntax } from "../theme"
import { FileChange } from "./FileChange"
import { measureRenderedTranscript } from "./rendered-layout"

const repeatedPatch = "--- a/sample.ts\n+++ b/sample.ts\n@@ -1,4 +1,4 @@\n SAME\n-REPEAT\n----OLD\n+REPEAT\n++++NEW\n SAME\n"

test("split diff geometry maps repeated context and header-like code by hunk side", async () => {
  const patch = repeatedPatch
  const item = { id: itemId("edit"), turnId: turnId("turn"), kind: "edit" as const, title: "sample.ts", patch, status: "complete" as const }
  const state = syncTranscriptItem(initialTranscript(), item)
  const syntax = createEmberTideSyntax()
  const setup = await testRender(<scrollbox id="scroll"><box id={`transcript-item:${item.id}`}><FileChange item={item} folded={false} syntax={syntax} /></box></scrollbox>, { width: 140, height: 20 })
  try {
    for (let index = 0; index < 4; index++) await act(async () => { await setup.flush(); await setup.renderOnce() })
    const scroll = setup.renderer.root.findDescendantById("scroll") as ScrollBoxRenderable
    const points = measureRenderedTranscript(setup.renderer, scroll, state)!.points![item.id]!
    const offset = (token: string, from = 0) => graphemeCount(patch.slice(0, patch.indexOf(token, from)))
    const removedRepeat = points[offset("REPEAT")]!
    const addedRepeat = points[offset("REPEAT", patch.indexOf("REPEAT") + 1)]!
    const removedHeaderLike = points[offset("---OLD")]!
    const addedHeaderLike = points[offset("+++NEW")]!
    expect(addedRepeat.screenX).toBeGreaterThan(removedRepeat.screenX)
    expect(addedRepeat.screenY).toBe(removedRepeat.screenY)
    expect(addedHeaderLike.screenY).toBe(removedHeaderLike.screenY)
    expect(removedHeaderLike.screenY).toBeGreaterThan(removedRepeat.screenY)
  } finally {
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
})

test("unified and multi-file geometry preserve canonical source order", async () => {
  const secondPatch = "--- a/other.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-SECOND_OLD\n+SECOND_NEW\n"
  const patch = `${repeatedPatch}\n${secondPatch}`
  const item = { id: itemId("multi-edit"), turnId: turnId("turn"), kind: "edit" as const, title: "2 files", patch,
    changes: [
      { path: "sample.ts", action: "update" as const, patch: repeatedPatch },
      { path: "other.ts", action: "update" as const, patch: secondPatch },
    ], status: "complete" as const }
  const state = syncTranscriptItem(initialTranscript(), item)
  const syntax = createEmberTideSyntax()
  const setup = await testRender(<scrollbox id="scroll"><box id={`transcript-item:${item.id}`}><FileChange item={item} folded={false} syntax={syntax} /></box></scrollbox>, { width: 80, height: 30 })
  try {
    for (let index = 0; index < 4; index++) await act(async () => { await setup.flush(); await setup.renderOnce() })
    const scroll = setup.renderer.root.findDescendantById("scroll") as ScrollBoxRenderable
    const points = measureRenderedTranscript(setup.renderer, scroll, state)!.points![item.id]!
    const offset = (token: string, from = 0) => graphemeCount(patch.slice(0, patch.indexOf(token, from)))
    const removedRepeat = points[offset("REPEAT")]!
    const addedRepeat = points[offset("REPEAT", patch.indexOf("REPEAT") + 1)]!
    const secondOld = points[offset("SECOND_OLD")]!
    const secondNew = points[offset("SECOND_NEW")]!
    expect(addedRepeat.screenY).toBeGreaterThan(removedRepeat.screenY)
    expect(secondOld.screenY).toBeGreaterThan(addedRepeat.screenY)
    expect(secondNew.screenY).toBeGreaterThan(secondOld.screenY)
  } finally {
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
})

test("split padding does not capture later blank changed lines", async () => {
  const patch = "--- a/blank.ts\n+++ b/blank.ts\n@@ -1,5 +1,4 @@\n-REMOVE_ONE\n-REMOVE_TWO\n+ADD_ONE\n CONTEXT\n-\n+\n TAIL\n"
  const item = { id: itemId("blank-edit"), turnId: turnId("turn"), kind: "edit" as const, title: "blank.ts", patch, status: "complete" as const }
  const state = syncTranscriptItem(initialTranscript(), item)
  const syntax = createEmberTideSyntax()
  const setup = await testRender(<scrollbox id="scroll"><box id={`transcript-item:${item.id}`}><FileChange item={item} folded={false} syntax={syntax} /></box></scrollbox>, { width: 140, height: 24 })
  try {
    for (let index = 0; index < 4; index++) await act(async () => { await setup.flush(); await setup.renderOnce() })
    const scroll = setup.renderer.root.findDescendantById("scroll") as ScrollBoxRenderable
    const points = measureRenderedTranscript(setup.renderer, scroll, state)!.points![item.id]!
    const contextOffset = graphemeCount(patch.slice(0, patch.indexOf("CONTEXT")))
    const blankRemoveOffset = graphemeCount(patch.slice(0, patch.indexOf("\n-\n") + 1))
    const blankAddOffset = graphemeCount(patch.slice(0, patch.indexOf("\n+\n") + 1))
    expect(points[blankRemoveOffset]!.screenY).toBeGreaterThan(points[contextOffset]!.screenY)
    expect(points[blankAddOffset]!.screenY).toBe(points[blankRemoveOffset]!.screenY)
  } finally {
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
})
