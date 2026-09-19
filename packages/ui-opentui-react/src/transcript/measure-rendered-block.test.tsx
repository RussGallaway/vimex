import { expect, test } from "bun:test"
import { TextRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { createConversation, itemId, reduceConversation, threadId, turnId } from "@vimex/conversation"
import { buildTranscriptBlocks, initialTranscript, syncTranscriptItem, type TranscriptItemBlock, type TranscriptTurnActivityBlock } from "@vimex/transcript"
import { act, useState } from "react"
import { blockNativeRevision, measureRenderedBlock, takeDirtyRenderedBlocks } from "./measure-rendered-block"

function blockFor(markdown: string): TranscriptItemBlock {
  const thread = threadId("measure-thread"), turn = turnId("measure-turn"), id = itemId("measure-item")
  let conversation = reduceConversation(createConversation(thread), { type: "turn.started", threadId: thread, turnId: turn })
  conversation = reduceConversation(conversation, {
    type: "item.started",
    threadId: thread,
    item: { id, turnId: turn, kind: "assistant", markdown, status: "running" },
  })
  const transcript = syncTranscriptItem(initialTranscript(), conversation.items[id]!)
  const block = buildTranscriptBlocks({ conversation, transcript })[0]
  if (!block || !("projection" in block)) throw new Error("Expected an item block")
  return block
}

test("measures immutable block-local geometry and reuses unchanged identity", async () => {
  const block = blockFor("alpha beta gamma")
  const setup = await testRender(<box id="offset" paddingLeft={5} paddingTop={2}>
    <box id="block" width={8}><text>{block.projection.plain}</text></box>
  </box>, { width: 40, height: 10 })
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    const renderable = setup.renderer.root.findDescendantById("block") as Renderable
    const input = { renderer: setup.renderer, renderable, block, width: 8, styleRevision: "test", folded: false }
    const first = measureRenderedBlock(input)
    const second = measureRenderedBlock(input)

    expect(second).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.points)).toBe(true)
    expect(first.key).toEqual({ blockKey: `item:${block.key.itemId}:root`, contentRevision: block.contentRevision, width: 8, styleRevision: "test", folded: false })
    expect(first.rows).toBeGreaterThan(1)
    expect(first.points[0]).toMatchObject({ graphemeOffset: 0, x: 0, y: 0, row: 0, column: 0 })
    expect(Math.max(...Object.values(first.points).map(point => point.x))).toBeLessThanOrEqual(renderable.width)
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("native line events dirty only their owning block and preserve identity when geometry is unchanged", async () => {
  const block = blockFor("abcd")
  const setup = await testRender(<box id="block"><text id="native">{"ab\ncd"}</text></box>, { width: 30, height: 8 })
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    const renderable = setup.renderer.root.findDescendantById("block") as Renderable
    const native = setup.renderer.root.findDescendantById("native") as TextRenderable
    const input = { renderer: setup.renderer, renderable, block, width: 30, styleRevision: 1, folded: false }
    const first = measureRenderedBlock(input)
    const revision = blockNativeRevision(renderable)

    native.emit("line-info-change")
    expect(takeDirtyRenderedBlocks()).toEqual([expect.objectContaining({ renderable, blockKey: `item:${block.key.itemId}:root` })])
    expect(measureRenderedBlock(input)).toBe(first)
    expect(blockNativeRevision(renderable)).toBe(revision)

    native.content = "a\nbcd"
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    expect(takeDirtyRenderedBlocks()).toEqual([expect.objectContaining({ renderable })])
    const changed = measureRenderedBlock(input)
    expect(changed).not.toBe(first)
    expect(changed.nativeRevision).toBeGreaterThan(first.nativeRevision)
    expect(changed.points[1]?.row).toBe(1)
    expect(first.points[1]?.row).toBe(0)
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("folded geometry uses boundary sentinels instead of hidden per-grapheme points", async () => {
  const block = blockFor(Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n"))
  const setup = await testRender(<box id="block"><text>Collapsed</text></box>, { width: 60, height: 6 })
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    const renderable = setup.renderer.root.findDescendantById("block") as Renderable
    const geometry = measureRenderedBlock({ renderer: setup.renderer, renderable, block, width: 60, styleRevision: 1, folded: true })
    expect(Object.keys(geometry.points).length).toBeLessThan(20)
    expect(geometry.points[block.projection.sourceSpans.length]?.hidden).toBe(true)
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("activity-hidden blocks publish zero-row geometry without semantic points", async () => {
  const block = blockFor("hidden child")
  const setup = await testRender(<box id="block" height={0} flexShrink={0} />, { width: 60, height: 6 })
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    const renderable = setup.renderer.root.findDescendantById("block") as Renderable
    const geometry = measureRenderedBlock({ renderer: setup.renderer, renderable, block, width: 60, styleRevision: 1, folded: true, presentation: "activity-hidden" })
    expect(geometry.rows).toBe(0)
    expect(geometry.points).toEqual({})
    expect(geometry.key.presentation).toBe("activity-hidden")
  } finally { await act(async () => setup.renderer.destroy()) }
})

test("activity batch leads expose only logical boundary sentinels", async () => {
  const block = blockFor("canonical lead text that must not map onto the batch summary")
  const setup = await testRender(<box id="block"><text>Web research · 3 searches</text></box>, { width: 60, height: 6 })
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    const renderable = setup.renderer.root.findDescendantById("block") as Renderable
    const geometry = measureRenderedBlock({ renderer: setup.renderer, renderable, block, width: 60, styleRevision: 1, folded: true, presentation: "activity-lead" })
    expect(Object.keys(geometry.points).map(Number)).toEqual([0, block.projection.sourceSpans.length])
    expect(geometry.points[block.projection.sourceSpans.length]?.hidden).toBe(true)
    expect(geometry.key.presentation).toBe("activity-lead")
  } finally { await act(async () => setup.renderer.destroy()) }
})

test("source-less activity blocks report their complete outer footprint", async () => {
  const activity: TranscriptTurnActivityBlock = {
    key: { kind: "turn-activity", turnId: turnId("activity-turn") },
    turn: { id: turnId("activity-turn"), status: "complete", itemIds: [], durationMs: 2_000 },
    contentRevision: 1,
    estimatedRows: 2,
  }
  const setup = await testRender(<box id="activity-block" height={2}><text>Worked for 2s</text></box>, { width: 30, height: 8 })
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    const renderable = setup.renderer.root.findDescendantById("activity-block") as Renderable
    const geometry = measureRenderedBlock({ renderer: setup.renderer, renderable, block: activity, width: 30, styleRevision: 1, folded: false })
    expect(geometry.rows).toBe(2)
    expect(geometry.pointCount).toBe(0)
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("an item sub-block measures only its source span in global logical offsets", async () => {
  const root = blockFor("abcdef")
  const block: TranscriptItemBlock = Object.freeze({
    ...root,
    key: Object.freeze({ ...root.key, blockId: "suffix" }),
    renderItem: Object.freeze({ ...root.renderItem, markdown: "def" }),
    sourceSpan: Object.freeze({ from: 3, to: 6 }),
  })
  const setup = await testRender(<box id="block" width={30} height={1}><text>def</text></box>, { width: 30, height: 8 })
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    const renderable = setup.renderer.root.findDescendantById("block") as Renderable
    const geometry = measureRenderedBlock({ renderer: setup.renderer, renderable, block, width: 30, styleRevision: 1, folded: false })
    expect(geometry.points[0]).toBeUndefined()
    expect(geometry.points[3]?.graphemeOffset).toBe(3)
    expect(geometry.points[6]?.graphemeOffset).toBe(6)
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("a non-final item sub-block does not duplicate the next block boundary", async () => {
  const root = blockFor("abcdef")
  const block: TranscriptItemBlock = Object.freeze({
    ...root,
    key: Object.freeze({ ...root.key, blockId: "prefix" }),
    renderItem: Object.freeze({ ...root.renderItem, markdown: "abc" }),
    sourceSpan: Object.freeze({ from: 0, to: 3 }),
  })
  const setup = await testRender(<box id="block" width={30} height={1}><text>abc</text></box>, { width: 30, height: 8 })
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    const renderable = setup.renderer.root.findDescendantById("block") as Renderable
    const geometry = measureRenderedBlock({ renderer: setup.renderer, renderable, block, width: 30, styleRevision: 1, folded: false })
    expect(geometry.points[0]?.graphemeOffset).toBe(0)
    expect(geometry.points[2]?.graphemeOffset).toBe(2)
    expect(geometry.points[3]).toBeUndefined()
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("same-size native child replacement invalidates and observes the new tree", async () => {
  const block = blockFor("abcd")
  let replace = () => {}
  function Harness() {
    const [changed, setChanged] = useState(false)
    replace = () => setChanged(true)
    return <box id="block"><text key={changed ? "new" : "old"} id="native" content={changed ? "a\nbcd" : "ab\ncd"} /></box>
  }
  const setup = await testRender(<Harness />, { width: 30, height: 8 })
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    const renderable = setup.renderer.root.findDescendantById("block") as Renderable
    const input = { renderer: setup.renderer, renderable, block, width: 30, styleRevision: 1, folded: false }
    const first = measureRenderedBlock(input)
    await act(async () => { replace(); await setup.flush(); await setup.renderOnce() })
    expect((renderable.getRenderable("native") as TextRenderable).plainText).toBe("a\nbcd")
    expect(takeDirtyRenderedBlocks().some(entry => entry.renderable === renderable)).toBe(true)
    const changed = measureRenderedBlock(input)
    expect(changed).not.toBe(first)
    expect(changed.nativeRevision).toBeGreaterThan(first.nativeRevision)
    expect(changed.points[3]?.column).toBe(1)
    expect(first.points[3]?.column).toBe(0)
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("a remounted native root advances the revision for the same logical block", async () => {
  const block = blockFor("abcd")
  let remount = () => {}
  function Harness() {
    const [changed, setChanged] = useState(false)
    remount = () => setChanged(true)
    return <box>{changed
      ? <box key="new" id="block" width={30} height={2}><text content={"a\nbcd"} /></box>
      : <box key="old" id="block" width={30} height={2}><text content={"ab\ncd"} /></box>}</box>
  }
  const setup = await testRender(<Harness />, { width: 30, height: 8 })
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    const firstRoot = setup.renderer.root.findDescendantById("block") as Renderable
    const first = measureRenderedBlock({ renderer: setup.renderer, renderable: firstRoot, block, width: 30, styleRevision: 1, folded: false })
    await act(async () => { remount(); await setup.flush(); await setup.renderOnce() })
    const secondRoot = setup.renderer.root.findDescendantById("block") as Renderable
    const second = measureRenderedBlock({ renderer: setup.renderer, renderable: secondRoot, block, width: 30, styleRevision: 1, folded: false })
    expect(secondRoot).not.toBe(firstRoot)
    expect(second.nativeRevision).toBeGreaterThan(first.nativeRevision)
    expect(second).not.toBe(first)
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})
