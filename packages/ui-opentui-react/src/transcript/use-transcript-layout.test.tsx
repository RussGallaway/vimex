import { expect, test } from "bun:test"
import type { DiffRenderable, ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { itemId, threadId } from "@vimex/conversation"
import { blockKey, initialTranscript, reduceTranscript, syncTranscriptItem, TranscriptRuntime } from "@vimex/transcript"
import { assistantMessage, buildTranscriptScalingFixture } from "@vimex/testkit"
import { act, useRef, useState, useSyncExternalStore } from "react"
import { inertController } from "../contracts"
import { createEmberTideSyntax } from "../theme"
import { measuredPoint, transcriptBlockRenderableId } from "./rendered-layout"
import { TranscriptNode } from "./TranscriptNode"
import { TurnActivity } from "./TurnActivity"
import { useTranscriptLayout } from "./use-transcript-layout"

test("reapplies a detached anchor when native geometry settles without transcript changes", async () => {
  const id = itemId("answer")
  let transcript = syncTranscriptItem(initialTranscript(), assistantMessage("answer", Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")))
  transcript = reduceTranscript(transcript, { type: "viewport.anchor", point: { itemId: id, graphemeOffset: 64 }, preferredScreenRow: 2 })
  let grow = () => {}
  let latest: ReturnType<typeof useTranscriptLayout> | undefined
  function Harness() {
    const [spacer, setSpacer] = useState(1)
    const scrollRef = useRef<ScrollBoxRenderable>(null)
    grow = () => setSpacer(6)
    latest = useTranscriptLayout({ threadId: threadId("thread"), transcript, width: 40, height: 10, scrollRef, controller: inertController })
    return <scrollbox id="scroll" ref={scrollRef} width={40} height={10}>
      <box id="native-spacer" height={spacer} flexShrink={0} />
      <box id={`transcript-item:${id}`} flexShrink={0}><text>{transcript.projectionById[id]!.plain}</text></box>
    </scrollbox>
  }
  const setup = await testRender(<Harness />, { width: 40, height: 10 })
  try {
    for (let index = 0; index < 4; index++) await act(async () => { await setup.flush(); await setup.renderOnce() })
    const scroll = setup.renderer.root.findDescendantById("scroll") as ScrollBoxRenderable
    const before = measuredPoint(latest!.measuredLayout.current!, transcript.viewport.kind === "point" ? transcript.viewport.point : undefined)!
    expect(before.screenY - scroll.viewport.screenY).toBe(2)

    await act(async () => { grow(); await setup.flush(); await setup.renderOnce() })
    for (let index = 0; index < 4; index++) await act(async () => { await setup.flush(); await setup.renderOnce() })
    const after = measuredPoint(latest!.measuredLayout.current!, transcript.viewport.kind === "point" ? transcript.viewport.point : undefined)!
    expect(after.screenY - scroll.viewport.screenY).toBe(2)
  } finally { await act(async () => setup.renderer.destroy()) }
})

test("windowed correction preserves a detached logical anchor through reflow above, within, and below it", async () => {
  const fixture = buildTranscriptScalingFixture(100)
  const projection = fixture.before.transcript.projectionById[fixture.targets.middle]!
  const anchor = Object.freeze({ itemId: fixture.targets.middle, graphemeOffset: Math.min(5, projection.sourceSpans.length) })
  const transcript = Object.freeze({
    ...fixture.before.transcript,
    cursor: anchor,
    viewport: Object.freeze({ kind: "point" as const, point: anchor, preferredScreenRow: 2 }),
  })
  const runtime = new TranscriptRuntime({
    threadId: fixture.threadId,
    canonicalGeneration: 0,
    canonicalRevision: fixture.before.canonicalRevision,
    conversation: fixture.before.conversation,
    transcript,
    mode: "detached",
    canonicalDamage: { kind: "full" },
  }, { windowPolicy: { viewportRows: 10, overscanRows: 10 } })
  const eventOrder: string[] = []
  const reportMeasurements = runtime.reportMeasurements.bind(runtime)
  runtime.reportMeasurements = batch => {
    eventOrder.push("measurement")
    return reportMeasurements(batch)
  }
  const syntax = createEmberTideSyntax()
  const anchorKey = blockKey(runtime.getSnapshot().window.blocks.find(block => block.key.kind === "item" && block.key.itemId === anchor.itemId)!)
  const initialKeys = runtime.getSnapshot().window.blocks.map(blockKey)
  const anchorIndex = initialKeys.indexOf(anchorKey)
  const aboveKey = initialKeys[Math.max(0, anchorIndex - 1)]!
  const belowKey = initialKeys[Math.min(initialKeys.length - 1, anchorIndex + 1)]!
  let resizeBlock = (_key: string, _rows: number) => {}
  let latest: ReturnType<typeof useTranscriptLayout> | undefined

  function Harness() {
    const frame = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
    const [rowsByKey, setRowsByKey] = useState<Readonly<Record<string, number>>>({})
    const scrollRef = useRef<ScrollBoxRenderable>(null)
    resizeBlock = (key, rows) => setRowsByKey(current => ({ ...current, [key]: rows }))
    latest = useTranscriptLayout({
      threadId: fixture.threadId,
      transcript: frame.transcript,
      frame,
      runtime,
      styleRevision: "anchor-window-test",
      width: 40,
      height: 10,
      scrollRef,
      controller: inertController,
      onAnchor: () => { eventOrder.push("anchor") },
    })
    return <scrollbox id="scroll" ref={scrollRef} width={40} height={10}>
      <box height={Math.max(1, frame.window.topSpacerRows)} visible={frame.window.topSpacerRows > 0} flexShrink={0} />
      {frame.window.blocks.map(block => <box key={blockKey(block)} id={transcriptBlockRenderableId(block)}
        height={rowsByKey[blockKey(block)] ?? 1} flexShrink={0}>
        {"projection" in block
          ? <TranscriptNode item={block.renderItem} folded={false} syntax={syntax} />
          : <TurnActivity turn={block.turn} />}
      </box>)}
      <box height={Math.max(1, frame.window.bottomSpacerRows)} visible={frame.window.bottomSpacerRows > 0} flexShrink={0} />
    </scrollbox>
  }

  const setup = await testRender(<Harness />, { width: 40, height: 10 })
  const settle = async () => {
    for (let index = 0; index < 6; index++) await act(async () => { await setup.flush(); await setup.renderOnce() })
  }
  try {
    await settle()
    const scroll = setup.renderer.root.findDescendantById("scroll") as ScrollBoxRenderable
    const anchorRow = () => measuredPoint(latest!.measuredLayout.current!, anchor)!.screenY - scroll.viewport.screenY
    expect(anchorRow()).toBe(2)

    for (const [key, rows] of [[aboveKey, 5], [anchorKey, 7], [belowKey, 4]] as const) {
      await act(async () => { resizeBlock(key, rows) })
      await settle()
      expect(anchorRow()).toBe(2)
      expect(runtime.getSnapshot().geometry.blockRows.length).toBe(runtime.getSnapshot().window.blocks.length)
    }

    eventOrder.length = 0
    const priorScrollTop = scroll.scrollTop
    const anchorNative = setup.renderer.root.findDescendantById(`diff:${anchor.itemId}`) as DiffRenderable
    let manuallyScrolled = false
    await act(async () => {
      scroll.scrollBy(1, "step")
      manuallyScrolled = scroll.scrollTop !== priorScrollTop
      latest!.onManualScroll()
      anchorNative.diff = `${projection.source}\n@@ -3 +3 @@\n-before late\n+after late`
      await setup.flush(); await setup.renderOnce()
    })
    await settle()
    expect(manuallyScrolled).toBe(true)
    expect(eventOrder.indexOf("anchor")).toBeGreaterThanOrEqual(0)
    expect(eventOrder.indexOf("measurement")).toBeGreaterThan(eventOrder.indexOf("anchor"))
  } finally {
    runtime.dispose()
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
})
