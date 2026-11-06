import { expect, test } from "bun:test"
import type { ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import {
  createConversation,
  itemId,
  reduceConversation,
  threadId,
  turnId,
} from "@vimex/conversation"
import {
  blockKey,
  initialTranscript,
  syncTranscriptItem,
  TranscriptRuntime,
} from "@vimex/transcript"
import { act } from "react"
import { materializedSelectionEndpoints } from "./layout"
import { takeDirtyRenderedBlocks } from "./measure-rendered-block"
import {
  measuredPoint,
  measureRenderedTranscript,
  readRenderedTranscriptLayout,
  transcriptBlockRenderableId,
} from "./rendered-layout"
import { ToolCall } from "./ToolCall"

async function fixture() {
  const thread = threadId("committed-layout")
  const turn = turnId("committed-layout-turn")
  const items = [
    {
      id: itemId("committed-first"),
      turnId: turn,
      kind: "command" as const,
      title: "First",
      detail: "alpha ".repeat(20) + "\ntarget row\nlast row",
      status: "complete" as const,
    },
    {
      id: itemId("committed-second"),
      turnId: turn,
      kind: "command" as const,
      title: "Second",
      detail: "following row\nnext row",
      status: "complete" as const,
    },
  ]
  let conversation = createConversation(thread)
  let transcript = initialTranscript()
  for (const item of items) {
    conversation = reduceConversation(conversation, {
      type: "item.started",
      threadId: thread,
      item,
    })
    transcript = syncTranscriptItem(transcript, item)
  }
  const runtime = new TranscriptRuntime({
    threadId: thread,
    canonicalGeneration: 0,
    canonicalRevision: 2,
    conversation,
    transcript,
    mode: "follow",
  })
  const blocks = runtime.getSnapshot().window.blocks
  const setup = await testRender(
    <scrollbox id="committed-scroll" width={42} height={8}>
      {blocks.flatMap((block) =>
        "item" in block && block.renderItem.kind === "command"
          ? [
              <box
                key={blockKey(block)}
                id={transcriptBlockRenderableId(block)}
                flexShrink={0}
              >
                <ToolCall item={block.renderItem} folded={false} />
              </box>,
            ]
          : [],
      )}
    </scrollbox>,
    { width: 42, height: 8 },
  )
  const scroll = setup.renderer.root.findDescendantById(
    "committed-scroll",
  ) as ScrollBoxRenderable
  const render = async () => {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
  }
  const measure = () =>
    measureRenderedTranscript(setup.renderer, scroll, {
      frame: runtime.getSnapshot(),
      runtime,
      styleRevision: "committed-test",
    })!
  await render()
  measure()
  measure()
  return {
    ...setup,
    items,
    runtime,
    scroll,
    render,
    measure,
    async close() {
      await act(async () => setup.renderer.destroy())
      runtime.dispose()
    },
  }
}

test("placement reader preserves dirty native work until ordered measurement publishes it", async () => {
  const h = await fixture()
  try {
    const before = h.runtime.getSnapshot()
    const firstBlock = before.window.blocks.find(
      (block) =>
        block.key.kind === "item" && block.key.itemId === h.items[0]!.id,
    )!
    const root = h.scroll.getRenderable(
      transcriptBlockRenderableId(firstBlock),
    )!
    const output = h.renderer.root.findDescendantById(
      `tool-output:${h.items[0]!.id}`,
    ) as TextRenderable
    const priorRows = before.geometry.byBlockKey[blockKey(firstBlock)]!.rows
    const secondPoint = { itemId: h.items[1]!.id, graphemeOffset: 0 }
    const priorPlacement = measuredPoint(
      readRenderedTranscriptLayout(h.scroll, before)!,
      secondPoint,
    )!
    let publications = 0
    const unsubscribe = h.runtime.subscribe(() => publications++)
    try {
      output.width = 18
      await h.render()
      expect(root.height).toBeGreaterThan(priorRows)
      const dirty = takeDirtyRenderedBlocks().filter(
        (entry) => entry.renderable === root,
      )
      expect(dirty.length).toBeGreaterThan(0)
      const read = readRenderedTranscriptLayout(h.scroll, before)!
      expect(h.runtime.getSnapshot()).toBe(before)
      expect(publications).toBe(0)
      expect(read.geometry).toBe(before.geometry)
      expect(
        takeDirtyRenderedBlocks().filter((entry) => entry.renderable === root),
      ).toEqual(dirty)
      expect(measuredPoint(read, secondPoint)!.screenY).toBeGreaterThan(
        priorPlacement.screenY,
      )
      h.measure()
      expect(publications).toBeGreaterThan(0)
      expect(
        h.runtime.getSnapshot().geometry.byBlockKey[blockKey(firstBlock)]!.rows,
      ).toBe(root.height)
      expect(
        h.runtime.getSnapshot().geometry.byBlockKey[blockKey(firstBlock)]!.rows,
      ).toBeGreaterThan(priorRows)
      expect(
        takeDirtyRenderedBlocks().some((entry) => entry.renderable === root),
      ).toBe(false)
    } finally {
      unsubscribe()
    }
  } finally {
    await h.close()
  }
})

test("read-only scroll refresh places cursor and selection on actual cells without publication", async () => {
  const h = await fixture()
  try {
    const frame = h.runtime.getSnapshot()
    const id = h.items[0]!.id
    const offset = frame.transcript.projectionById[id]!.plain.indexOf("target")
    expect(offset).toBeGreaterThan(0)
    const point = { itemId: id, graphemeOffset: offset }
    const initial = readRenderedTranscriptLayout(h.scroll, frame)!
    const before = measuredPoint(initial, point)!
    h.scroll.scrollBy(2, "step")
    await h.render()
    const read = readRenderedTranscriptLayout(h.scroll, frame)!
    expect(h.runtime.getSnapshot()).toBe(frame)
    expect(read.geometry).toBe(frame.geometry)
    const cursor = measuredPoint(read, point)!
    expect(cursor.screenY).toBe(before.screenY - 2)
    const selection = materializedSelectionEndpoints(
      {
        ...frame.transcript,
        selection: {
          anchor: point,
          head: { itemId: id, graphemeOffset: offset + 5 },
          shape: "character",
        },
      },
      read,
      undefined,
      h.scroll.viewport,
    )!
    expect(selection).toBeDefined()
    const cells = h.captureCharFrame().split("\n")
    expect(cells[cursor.screenY]![cursor.screenX]).toBe("t")
    expect(selection.anchor.screenY).toBe(cursor.screenY)
    expect(selection.anchor.screenX).toBe(cursor.screenX)
    expect(cells[selection.head.screenY]![selection.head.screenX]).toBe("t")
  } finally {
    await h.close()
  }
})
