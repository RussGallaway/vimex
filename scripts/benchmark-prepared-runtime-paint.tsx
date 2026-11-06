/** Diagnostic native-wrapper probe, not input-to-paint or production latency. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { testRender } from "@opentui/react/test-utils"
import type { ScrollBoxRenderable } from "@opentui/core"
import { act, createRef } from "react"
import {
  createConversation,
  itemId,
  reduceConversation,
  threadId,
  turnId,
} from "@vimex/conversation"
import {
  createTranscriptFrame,
  initialTranscript,
  syncTranscriptItem,
  type TranscriptItemBlock,
} from "@vimex/transcript"
import { createEmberTideSyntax } from "../packages/ui-opentui-react/src/theme"
import { TranscriptViewport } from "../packages/ui-opentui-react/src/transcript/TranscriptViewport"
import { transcriptBlockRenderableId } from "../packages/ui-opentui-react/src/transcript/rendered-layout"
import {
  invalidateRenderedBlock,
  measureRenderedBlock,
} from "../packages/ui-opentui-react/src/transcript/measure-rendered-block"
import { PreparedRuntimeGeometryBridge } from "../packages/ui-opentui-react/src/transcript/prepared-runtime-geometry"

async function probe(paint: boolean, width: number) {
  const thread = threadId("paint-probe"),
    turn = turnId("paint-probe-turn"),
    id = itemId("paint-probe-command")
  const tail = Array.from(
    { length: 50 },
    (_, i) => `row ${i} alpha beta 界面 and wrapped ordinary output`,
  ).join("\n")
  const detail = "x".repeat(4087) + "\n" + "y".repeat(4095) + "\n" + tail
  let conversation = createConversation(thread)
  conversation = reduceConversation(conversation, {
    type: "item.started",
    threadId: thread,
    item: {
      id,
      turnId: turn,
      kind: "command",
      title: "Command",
      detail,
      status: "complete",
    },
  })
  const frame = createTranscriptFrame({
    threadId: thread,
    canonicalGeneration: 0,
    canonicalRevision: 1,
    conversation,
    transcript: syncTranscriptItem(
      initialTranscript(),
      conversation.items[id]!,
    ),
    mode: "follow",
  })
  const block = frame.blocks
    .filter((b): b is TranscriptItemBlock => "item" in b)
    .at(-1)!
  assert(block.fragment?.kind === "command-output")
  const syntax = createEmberTideSyntax(),
    scrollRef = createRef<ScrollBoxRenderable>()
  const setup = await testRender(
    <TranscriptViewport
      window={{
        ...frame.window,
        blocks: [block],
        topSpacerRows: 0,
        bottomSpacerRows: 0,
      }}
      state={frame.transcript}
      surface="transcript"
      syntax={syntax}
      scrollRef={scrollRef}
    />,
    { width, height: 20 },
  )
  const tasks: Array<() => void> = []
  const bridge = new PreparedRuntimeGeometryBridge(
    setup.renderer,
    {
      schedule: (fn) => {
        tasks.push(fn)
        return fn
      },
      cancel: (handle) => {
        const i = tasks.indexOf(handle as () => void)
        if (i >= 0) tasks.splice(i, 1)
      },
    },
    { paint },
  )
  const render = async () =>
    act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
  try {
    await render()
    const root = setup.renderer.root.findDescendantById(
      transcriptBlockRenderableId(block),
    )!
    bridge.begin(frame, "probe")
    const measure = (prepared: boolean) =>
      measureRenderedBlock({
        renderer: setup.renderer,
        renderable: root,
        block,
        width: scrollRef.current!.viewport.width,
        styleRevision: "probe",
        folded: false,
        preparedPoints: prepared ? bridge.points : undefined,
      })
    const first = performance.now()
    measure(paint)
    const coldNativeMeasurementMs = performance.now() - first
    const build = performance.now()
    while (tasks.length) tasks.shift()!()
    const preparedBuildMs = performance.now() - build
    invalidateRenderedBlock(root)
    const warm = performance.now()
    measure(paint)
    const warmMeasurementMs = performance.now() - warm
    await render()
    // Diagnostic wrapper only: separate actual body painting from the test
    // renderer's frame pacing/act overhead, without changing production code.
    const body = root.findDescendantById(
      `tool-output:${block.key.itemId}:${block.key.blockId}`,
    )! as unknown as { renderSelf: (...args: unknown[]) => unknown }
    const originalPaint = body.renderSelf
    const paintMs: number[] = []
    body.renderSelf = function (...args) {
      const start = performance.now()
      try {
        return originalPaint.apply(this, args)
      } finally {
        paintMs.push(performance.now() - start)
      }
    }
    const renderMs: number[] = [],
      frames: string[] = []
    const maximum = Math.max(
      0,
      scrollRef.current!.scrollHeight - scrollRef.current!.viewport.height,
    )
    const positions = Array.from({ length: 24 }, (_, i) =>
      Math.floor((maximum * i) / 23),
    )
    for (const position of [...positions, ...positions.toReversed()]) {
      const start = performance.now()
      scrollRef.current!.scrollTo(position)
      await render()
      renderMs.push(performance.now() - start)
      frames.push(
        createHash("sha256").update(setup.captureCharFrame()).digest("hex"),
      )
    }
    if (paint) assert(bridge.diagnostics.preparedPaints > 0)
    return {
      paint,
      width,
      sourceCodeUnits: tail.length,
      coldNativeMeasurementMs,
      preparedBuildMs,
      warmMeasurementMs,
      renderMs,
      paintMs,
      frames,
      diagnostics: bridge.diagnostics,
    }
  } finally {
    bridge.dispose()
    await act(async () => setup.renderer.destroy())
    syntax.destroy()
  }
}

const results = []
for (const width of [40, 80]) {
  const native = await probe(false, width),
    prepared = await probe(true, width)
  assert.deepEqual(prepared.frames, native.frames)
  results.push(native, prepared)
}
console.log(
  JSON.stringify({
    benchmark: "prepared-runtime-paint-v1",
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    opentui: "0.5.11",
    qualification:
      "Single native production-wrapper diagnostic after mount. 50 source rows,48 forward/reverse redraws percase. Includes test renderer/act/flush overhead; no actual keyboard dispatch or PTY. Cold measurement can be followed by additional prepared work; original native source/layout retained. Frame hashes compare char cells; separate native tests validate colors and selection. Not latency distributions or evidence of subjective improvement.",
    results,
  }),
)
