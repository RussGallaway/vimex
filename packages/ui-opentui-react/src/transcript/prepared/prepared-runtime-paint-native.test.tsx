import { expect, test } from "bun:test"
import {
  Selection,
  type Renderable,
  type ScrollBoxRenderable,
  type TextRenderable,
} from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
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
import { createEmberTideSyntax } from "../../theme"
import { TranscriptViewport } from "../TranscriptViewport"
import { PreparedRuntimeGeometryBridge } from "./prepared-runtime-geometry"
import {
  invalidateRenderedBlock,
  measureRenderedBlock,
} from "../native-layout/measure-rendered-block"
import { transcriptBlockRenderableId } from "../native-layout/rendered-layout"

function fixture(tail: string) {
  const thread = threadId("prepared-paint-native")
  const turn = turnId("paint-turn")
  const id = itemId("paint-command")
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
    .filter((value): value is TranscriptItemBlock => "item" in value)
    .at(-1)!
  if (
    block.fragment?.kind !== "command-output" ||
    block.fragment.index !== block.fragment.count - 1
  )
    throw new Error("Expected final output fragment")
  return { frame, block }
}

async function mount(tail: string, width: number, height = 30) {
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
    { width, height },
  )
  const render = async () => {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
  }
  await render()
  const root = setup.renderer.root.findDescendantById(
    transcriptBlockRenderableId(block),
  ) as Renderable
  const body = root.findDescendantById(
    `tool-output:${block.key.itemId}:${block.key.blockId}`,
  ) as TextRenderable
  const callbacks = new Map<object, () => void>()
  const bridge = new PreparedRuntimeGeometryBridge(
    setup.renderer,
    {
      schedule: (callback) => {
        const key = {}
        callbacks.set(key, callback)
        return key
      },
      cancel: (key) => {
        callbacks.delete(key as object)
      },
    },
    { paint: true },
  )
  bridge.begin(frame, "paint-native")
  const input = () => ({
    renderer: setup.renderer,
    renderable: root,
    block,
    width: scrollRef.current!.viewport.width,
    styleRevision: "paint-native",
    folded: false,
  })
  const measure = () =>
    measureRenderedBlock({ ...input(), preparedPoints: bridge.points })
  const drain = () => {
    for (let tries = 0; callbacks.size && tries < 100; tries++) {
      const [key, callback] = callbacks.entries().next().value!
      callbacks.delete(key)
      callback()
    }
  }
  const warm = async () => {
    invalidateRenderedBlock(root)
    measure()
    drain()
    measure()
    await render()
  }
  const capture = () => ({
    text: setup.captureCharFrame(),
    fg: Array.from(setup.renderer.currentRenderBuffer.buffers.fg),
    bg: Array.from(setup.renderer.currentRenderBuffer.buffers.bg),
    attributes: Array.from(
      setup.renderer.currentRenderBuffer.buffers.attributes,
    ),
  })
  return {
    setup,
    frame,
    block,
    root,
    body,
    bridge,
    render,
    input,
    measure,
    drain,
    warm,
    capture,
    scroll: scrollRef.current!,
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
      "alpha beta  gamma   delta and further words\nsecond row tail",
    ],
    ["Unicode", "Café 界面 👩‍💻 and ordinary words 🙂\nlast界"],
    ["blank rows", "first source row\n\nthird row\n\n"],
  ] as const)
    test(`prepared painter matches production native cells and colors ${name} at ${width}`, async () => {
      const h = await mount(text, width)
      try {
        const before = h.capture()
        const native = measureRenderedBlock(h.input())
        await h.warm()
        expect(h.bridge.diagnostics.preparedPaints).toBeGreaterThan(0)
        expect(h.capture()).toEqual(before)
        const prepared = h.measure()
        expect(prepared.points).toEqual(native.points)
        expect(prepared.lines).toEqual(native.lines)
        expect(prepared.rows).toBe(native.rows)
        expect(h.body.plainText).toBe(text)
      } finally {
        await h.close()
      }
    })

test("prepared painter clips scrolled rows and clears stale cells on reversal", async () => {
  const h = await mount(
    Array.from(
      { length: 20 },
      (_, i) => `ROW ${i} alpha beta 界面 many words`,
    ).join("\n"),
    30,
    9,
  )
  try {
    h.scroll.stickyScroll = false
    const baselines = []
    for (const top of [0, 5, 11, 2]) {
      h.scroll.scrollTo(top)
      await h.render()
      baselines.push(h.capture())
    }
    await h.warm()
    for (const [index, top] of [0, 5, 11, 2].entries()) {
      h.scroll.scrollTo(top)
      await h.render()
      expect(h.capture()).toEqual(baselines[index]!)
    }
    expect(h.bridge.diagnostics.preparedPaints).toBeGreaterThan(0)
  } finally {
    await h.close()
  }
})

test("native selection retains source and highlight while prepared painting resumes after clearing", async () => {
  const h = await mount(
    "first source row\nsecond source row\nthird source row",
    40,
  )
  try {
    const unselected = h.capture()
    const selection = new Selection(
      h.body,
      { x: h.body.x + 2, y: h.body.y },
      { x: h.body.x + 6, y: h.body.y + 1 },
    )
    selection.isStart = true
    h.body.onSelectionChanged(selection)
    await h.render()
    const selected = h.capture()
    const copied = h.body.getSelectedText()
    expect(copied).toBe("rst source row\nsecond ")
    await h.warm()
    expect(h.bridge.diagnostics.nativePaintFallbacks).toBeGreaterThan(0)
    expect(h.capture()).toEqual(selected)
    expect(h.body.getSelectedText()).toBe(copied)
    h.body.onSelectionChanged(null)
    await h.render()
    expect(h.bridge.diagnostics.preparedPaints).toBeGreaterThan(0)
    expect(h.capture()).toEqual(unselected)
  } finally {
    await h.close()
  }
})

test("resize, content mismatch and disposal cannot paint stale prepared rows", async () => {
  const h = await mount(
    "first source with enough words to wrap over several rows\nlast row",
    40,
  )
  try {
    await h.warm()
    const prepared = h.bridge.diagnostics.preparedPaints
    await act(async () => {
      h.setup.resize(24, 30)
      await h.setup.flush()
      await h.setup.renderOnce()
    })
    expect(h.bridge.diagnostics.preparedPaints).toBe(prepared)
    const resized = h.capture()
    await h.warm()
    expect(h.bridge.diagnostics.preparedPaints).toBeGreaterThan(prepared)
    expect(h.capture()).toEqual(resized)
    const beforeChange = h.bridge.diagnostics.preparedPaints
    h.body.content = "new source content\nnew tail"
    await h.render()
    expect(h.bridge.diagnostics.preparedPaints).toBe(beforeChange)
    expect(h.setup.captureCharFrame()).toContain("new source")
    expect(h.setup.captureCharFrame()).not.toContain("last row")
    const changed = h.capture()
    h.bridge.dispose()
    await h.render()
    expect(h.capture()).toEqual(changed)
  } finally {
    await h.close()
  }
})
