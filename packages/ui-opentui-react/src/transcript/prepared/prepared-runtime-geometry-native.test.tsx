import { expect, test } from "bun:test"
import {
  Selection,
  type Renderable,
  type ScrollBoxRenderable,
  type TextRenderable,
} from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import {
  createConversation,
  itemId,
  reduceConversation,
  threadId,
  turnId,
} from "@vimex/conversation"
import {
  blockGraphemeRange,
  createTranscriptFrame,
  initialTranscript,
  syncTranscriptItem,
  type BlockGeometry,
  type TranscriptItemBlock,
} from "@vimex/transcript"
import { act, createRef } from "react"
import { createEmberTideSyntax } from "../../theme"
import { TranscriptViewport } from "../TranscriptViewport"
import { transcriptBlockRenderableId } from "../native-layout/rendered-layout"
import {
  invalidateRenderedBlock,
  measureRenderedBlock,
} from "../native-layout/measure-rendered-block"
import { PreparedRuntimeGeometryBridge } from "./prepared-runtime-geometry"

function fixture(tail: string) {
  const thread = threadId("prepared-native-thread")
  const turn = turnId("prepared-native-turn")
  const id = itemId("prepared-native-command")
  const detail = "x".repeat(4087) + "\n" + "y".repeat(4095) + "\n" + tail
  let conversation = reduceConversation(createConversation(thread), {
    type: "turn.started",
    threadId: thread,
    turnId: turn,
  })
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
  conversation = reduceConversation(conversation, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "complete",
    durationMs: 1,
  })
  const transcript = syncTranscriptItem(
    initialTranscript(),
    conversation.items[id]!,
  )
  const frame = createTranscriptFrame({
    threadId: thread,
    canonicalGeneration: 0,
    canonicalRevision: 1,
    conversation,
    transcript,
    mode: "follow",
  })
  const block = frame.blocks
    .filter(
      (candidate): candidate is TranscriptItemBlock => "item" in candidate,
    )
    .at(-1)!
  if (
    block.fragment?.kind !== "command-output" ||
    block.fragment.index !== block.fragment.count - 1
  )
    throw new Error("Fixture must produce final command-output fragment")
  return { frame, block }
}

function shape(geometry: BlockGeometry) {
  const { nativeRevision: _, ...rest } = geometry
  return rest
}

async function mount(tail: string, width: number) {
  const { frame, block } = fixture(tail)
  const syntax = createEmberTideSyntax()
  const scrollRef = createRef<ScrollBoxRenderable>()
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
    { width, height: 120 },
  )
  await act(async () => {
    await setup.flush()
    await setup.renderOnce()
  })
  const root = setup.renderer.root.findDescendantById(
    transcriptBlockRenderableId(block),
  ) as Renderable
  const body = root.findDescendantById(
    `tool-output:${block.key.itemId}:${block.key.blockId}`,
  ) as TextRenderable
  const callbacks: Array<() => void> = []
  const bridge = new PreparedRuntimeGeometryBridge(setup.renderer, {
    schedule: (callback) => {
      callbacks.push(callback)
      return callbacks.length
    },
    cancel: () => {},
  })
  bridge.begin(frame, "native-parity")
  const input = () => ({
    renderer: setup.renderer,
    renderable: root,
    block,
    width: scrollRef.current!.viewport.width,
    styleRevision: "native-parity",
    folded: false,
  })
  const measure = () =>
    measureRenderedBlock({
      ...input(),
      preparedPoints: (value, text) => bridge.points(value, text),
    })
  const drain = () => {
    for (let attempts = 0; callbacks.length && attempts < 100; attempts++)
      callbacks.shift()!()
  }
  return {
    setup,
    frame,
    block,
    root,
    body,
    bridge,
    input,
    measure,
    drain,
    async close() {
      bridge.dispose()
      await act(async () => setup.renderer.destroy())
      syntax.destroy()
    },
  }
}

for (const width of [24, 40, 80])
  for (const [name, text] of [
    [
      "wrapped ASCII",
      "alpha beta  gamma delta and more ordinary words\nsecond line ends here",
    ],
    ["Unicode", "Café 界面 👩‍💻 and more text with 🙂 wide cells\nlast界"],
    ["trailing blanks", "first source row\n\nthird row\n\n"],
  ] as const)
    test(`prepared runtime geometry matches native final fragment ${name} at ${width}`, async () => {
      const h = await mount(text, width)
      try {
        const original = measureRenderedBlock(h.input())
        const before = h.setup.captureCharFrame()
        invalidateRenderedBlock(h.root)
        const cold = h.measure()
        expect(shape(cold)).toEqual(shape(original))
        h.drain()
        const warm = h.measure()
        expect(h.bridge.diagnostics.hits).toBeGreaterThan(0)
        expect(shape(warm)).toEqual(shape(original))
        expect(h.setup.captureCharFrame()).toBe(before)
        const range = blockGraphemeRange(h.block)
        expect(Math.min(...Object.keys(warm.points).map(Number))).toBe(
          range.from,
        )
        expect(warm.points[range.to]).toBeDefined()
        expect(warm.points[range.from]!.x).toBe(h.body.x - h.root.x)
        expect(warm.points[range.from]!.y).toBe(h.body.y - h.root.y)
      } finally {
        await h.close()
      }
    })

test("prepared runtime bridge refuses tabs and folded presentations without changing native fallback", async () => {
  for (const text of ["alpha\tbeta\nnext row", "ordinary final output"]) {
    const h = await mount(text, 40)
    try {
      const original = measureRenderedBlock(h.input())
      invalidateRenderedBlock(h.root)
      h.measure()
      h.drain()
      const measured = h.measure()
      expect(shape(measured)).toEqual(shape(original))
      if (text.includes("\t")) expect(h.bridge.diagnostics.hits).toBe(0)
      const folded = { ...h.input(), folded: true }
      expect(h.bridge.points(folded, text)).toBeUndefined()
    } finally {
      await h.close()
    }
  }
})

test("prepared runtime geometry leaves native mouse selection and source text unchanged", async () => {
  const h = await mount(
    "first source row\nsecond source row\nthird source row",
    40,
  )
  try {
    const selection = new Selection(
      h.body,
      { x: h.body.x + 2, y: h.body.y },
      { x: h.body.x + 6, y: h.body.y + 1 },
    )
    selection.isStart = true
    h.body.onSelectionChanged(selection)
    await act(async () => {
      await h.setup.flush()
      await h.setup.renderOnce()
    })
    const text = h.body.getSelectedText()
    const before = h.setup.captureCharFrame()
    const foreground = Array.from(
      h.setup.renderer.currentRenderBuffer.buffers.fg,
    )
    const background = Array.from(
      h.setup.renderer.currentRenderBuffer.buffers.bg,
    )
    h.measure()
    h.drain()
    h.measure()
    await act(async () => {
      await h.setup.flush()
      await h.setup.renderOnce()
    })
    expect(h.bridge.diagnostics.hits).toBeGreaterThan(0)
    expect(h.body.getSelectedText()).toBe(text)
    expect(text.length).toBeGreaterThan(0)
    expect(h.setup.captureCharFrame()).toBe(before)
    expect(Array.from(h.setup.renderer.currentRenderBuffer.buffers.fg)).toEqual(
      foreground,
    )
    expect(Array.from(h.setup.renderer.currentRenderBuffer.buffers.bg)).toEqual(
      background,
    )
  } finally {
    await h.close()
  }
})

test("width and content changes cannot reuse prepared coordinates from an older variant", async () => {
  const h = await mount(
    "first source with enough words to wrap over several rows",
    40,
  )
  try {
    h.measure()
    h.drain()
    h.measure()
    const priorHits = h.bridge.diagnostics.hits
    await act(async () => {
      h.setup.resize(24, 120)
      await h.setup.flush()
      await h.setup.renderOnce()
    })
    h.bridge.begin(h.frame, "native-parity")
    const resized = measureRenderedBlock(h.input())
    invalidateRenderedBlock(h.root)
    expect(shape(h.measure())).toEqual(shape(resized))
    expect(h.bridge.diagnostics.hits).toBe(priorHits)
    h.drain()
    expect(shape(h.measure())).toEqual(shape(resized))
    expect(h.bridge.diagnostics.hits).toBeGreaterThan(priorHits)

    const changed = fixture("different source content\nlast界")
    await act(async () => {
      h.body.content =
        changed.block.renderItem.kind === "command"
          ? changed.block.renderItem.detail
          : ""
      await h.setup.flush()
      await h.setup.renderOnce()
    })
    h.bridge.begin(changed.frame, "native-parity")
    const input = { ...h.input(), block: changed.block }
    const native = measureRenderedBlock(input)
    const hits = h.bridge.diagnostics.hits
    invalidateRenderedBlock(h.root)
    const cold = measureRenderedBlock({
      ...input,
      preparedPoints: (value, text) => h.bridge.points(value, text),
    })
    expect(shape(cold)).toEqual(shape(native))
    expect(h.bridge.diagnostics.hits).toBe(hits)
    h.drain()
    const warm = measureRenderedBlock({
      ...input,
      preparedPoints: (value, text) => h.bridge.points(value, text),
    })
    expect(shape(warm)).toEqual(shape(native))
    expect(h.bridge.diagnostics.hits).toBeGreaterThan(hits)
  } finally {
    await h.close()
  }
})
