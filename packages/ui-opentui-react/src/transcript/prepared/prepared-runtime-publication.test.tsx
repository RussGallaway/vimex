import { expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, createRef, useSyncExternalStore } from "react"
import {
  createConversation,
  itemId,
  reduceConversation,
  threadId,
  turnId,
} from "@vimex/conversation"
import {
  blockKey,
  blockGraphemeRange,
  initialTranscript,
  syncTranscriptItem,
  TranscriptRuntime,
} from "@vimex/transcript"
import { createEmberTideSyntax } from "../../theme"
import { TranscriptViewport } from "../TranscriptViewport"
import { invalidateRenderedBlock } from "../native-layout/measure-rendered-block"
import {
  getPreparedRuntimeGeometryDiagnostics,
  measureRenderedTranscript,
  measuredPoint,
  readRenderedTranscriptLayout,
  releaseRenderedTranscriptLayout,
  synchronizeRenderedTranscriptWindow,
  transcriptBlockRenderableId,
} from "../native-layout/rendered-layout"

async function fixture() {
  const thread = threadId("prepared-publication")
  const item = {
    id: itemId("large-command"),
    turnId: turnId("prepared-turn"),
    kind: "command" as const,
    title: "Command output",
    detail: Array.from(
      { length: 240 },
      (_, i) => `line ${i} alpha beta gamma delta 界`,
    ).join("\n"),
    status: "complete" as const,
  }
  const conversation = reduceConversation(createConversation(thread), {
    type: "item.started",
    threadId: thread,
    item,
  })
  const transcript = syncTranscriptItem(initialTranscript(), item)
  const runtime = new TranscriptRuntime({
    threadId: thread,
    canonicalGeneration: 0,
    canonicalRevision: 1,
    conversation,
    transcript,
    mode: "follow",
  })
  const syntax = createEmberTideSyntax()
  const scrollRef = createRef<ScrollBoxRenderable>()
  function View() {
    const frame = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot)
    return (
      <TranscriptViewport
        window={frame.window}
        state={frame.transcript}
        surface="transcript"
        syntax={syntax}
        scrollRef={scrollRef}
      />
    )
  }
  const setup = await testRender(<View />, { width: 55, height: 18 })
  const render = async () => {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
  }
  await render()
  const scroll = scrollRef.current!
  const measure = (enabled: boolean) => {
    act(() => {
      measureRenderedTranscript(setup.renderer, scroll, {
        frame: runtime.getSnapshot(),
        runtime,
        styleRevision: "test",
        preparedGeometry: enabled,
      })
    })
  }
  measure(false)
  await render()
  measure(false)
  const block = runtime
    .getSnapshot()
    .window.blocks.find(
      (b) =>
        "fragment" in b &&
        b.fragment?.kind === "command-output" &&
        b.fragment.index === b.fragment.count - 1,
    )!
  if (!block || !("item" in block))
    throw new Error("Missing final command fragment")
  const root = scroll.getRenderable(transcriptBlockRenderableId(block))!
  return {
    ...setup,
    runtime,
    scroll,
    block,
    root,
    measure,
    render,
    async close() {
      releaseRenderedTranscriptLayout(scroll)
      await act(async () => setup.renderer.destroy())
      syntax.destroy()
      runtime.dispose()
    },
  }
}

test("prepared completion never publishes; ordered measurement preserves native runtime geometry", async () => {
  const h = await fixture()
  try {
    const before = h.runtime.getSnapshot()
    const geometry = before.geometry.byBlockKey[blockKey(h.block)]!
    expect(geometry).toBeDefined()
    expect(getPreparedRuntimeGeometryDiagnostics(h.scroll)).toBeUndefined()
    const point = {
      itemId: h.block.key.itemId,
      graphemeOffset: blockGraphemeRange(h.block).from + 5,
    }
    const beforePoint = measuredPoint(
      readRenderedTranscriptLayout(h.scroll, before)!,
      point,
    )
    invalidateRenderedBlock(h.root)
    h.measure(true)
    const afterFallback = h.runtime.getSnapshot()
    let publications = 0
    const unsubscribe = h.runtime.subscribe(() => publications++)
    try {
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(
        getPreparedRuntimeGeometryDiagnostics(h.scroll)!.prepared,
      ).toBeGreaterThan(0)
      expect(h.runtime.getSnapshot()).toBe(afterFallback)
      expect(publications).toBe(0)
      readRenderedTranscriptLayout(h.scroll, afterFallback)
      expect(publications).toBe(0)
      h.measure(true)
      expect(
        getPreparedRuntimeGeometryDiagnostics(h.scroll)!.hits,
      ).toBeGreaterThan(0)
      const after = h.runtime.getSnapshot()
      const actual = after.geometry.byBlockKey[blockKey(h.block)]!
      expect(actual.points).toEqual(geometry.points)
      expect(actual.lines).toEqual(geometry.lines)
      expect(actual.rows).toBe(geometry.rows)
      expect(
        measuredPoint(readRenderedTranscriptLayout(h.scroll, after)!, point),
      ).toEqual(beforePoint)
    } finally {
      unsubscribe()
    }
  } finally {
    await h.close()
  }
})

test("disabling or releasing the bridge cancels preparation without runtime publication", async () => {
  const h = await fixture()
  try {
    invalidateRenderedBlock(h.root)
    h.measure(true)
    expect(getPreparedRuntimeGeometryDiagnostics(h.scroll)).toBeDefined()
    h.measure(false)
    expect(getPreparedRuntimeGeometryDiagnostics(h.scroll)).toBeUndefined()
    const before = h.runtime.getSnapshot()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.runtime.getSnapshot()).toBe(before)
    invalidateRenderedBlock(h.root)
    h.measure(true)
    releaseRenderedTranscriptLayout(h.scroll)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getPreparedRuntimeGeometryDiagnostics(h.scroll)).toBeUndefined()
    expect(h.runtime.getSnapshot()).toBe(before)
  } finally {
    await h.close()
  }
})

test("layout generation changes cancel queued preparation before its timer can invalidate roots", async () => {
  const h = await fixture()
  try {
    invalidateRenderedBlock(h.root)
    h.measure(true)
    act(() => {
      h.runtime.resetLayout("width")
    })
    const reset = h.runtime.getSnapshot()
    synchronizeRenderedTranscriptWindow(h.scroll, reset)
    const before = getPreparedRuntimeGeometryDiagnostics(h.scroll)!.prepared
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getPreparedRuntimeGeometryDiagnostics(h.scroll)!.prepared).toBe(
      before,
    )
    expect(h.runtime.getSnapshot()).toBe(reset)
  } finally {
    await h.close()
  }
})
