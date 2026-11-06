import { expect, test } from "bun:test"
import {
  createConversation,
  reduceConversation,
  threadId,
  itemId,
  turnId,
} from "@vimex/conversation"
import { syncTranscriptItem } from "./application/project-conversation"
import { initialTranscript } from "./domain/transcript-document"
import { TranscriptRuntime, type TranscriptRuntimeInput } from "./runtime"
import { createHeightIndex } from "./height-index"
import {
  blockKey,
  planTranscriptWindow,
  type TranscriptItemBlock,
  type TranscriptWindow,
} from "./window"

function item(
  name: string,
  estimatedRows = 1,
  source = "x",
): TranscriptItemBlock {
  const id = itemId(name)
  const projection = Object.freeze({
    plain: source,
    source,
    sourceSpans: Object.freeze(
      [...source].map((_, index) =>
        Object.freeze({ from: index, to: index + 1 }),
      ),
    ),
    links: Object.freeze([]),
    revision: 1,
  })
  const value = Object.freeze({
    id,
    turnId: turnId("turn"),
    kind: "assistant" as const,
    markdown: source,
    status: "complete" as const,
  })
  return Object.freeze({
    key: Object.freeze({ kind: "item" as const, itemId: id, blockId: "root" }),
    turnId: turnId("turn"),
    item: value,
    renderItem: value,
    projection,
    sourceSpan: Object.freeze({ from: 0, to: source.length }),
    contentRevision: 1,
    estimatedRows,
    followedByActivity: false,
  })
}

const blocks = Object.freeze(
  Array.from({ length: 1000 }, (_, i) => item(`row-${i}`)),
)
const heights = createHeightIndex(blocks)!
function plan(
  position: number,
  retainedWindow?: TranscriptWindow,
  overrides = {},
) {
  return planTranscriptWindow({
    blocks,
    heights,
    viewportRows: 10,
    overscanRows: 10,
    recentTailRows: 120,
    recentTailBlocks: 120,
    retainWindow: true,
    retainedWindow,
    attachment: {
      kind: "point",
      point: { itemId: itemId(`row-${position}`), graphemeOffset: 0 },
      preferredScreenRow: 0,
    },
    ...overrides,
  })
}

test("interior row movements retain a fixed window until its inner boundary", () => {
  const initial = plan(500)
  expect(initial.blocks).toHaveLength(120)
  let current = initial
  for (let row = 501; row <= 535; row++) {
    current = plan(row, current)
    expect(current.blocks).toEqual(initial.blocks)
  }
  const crossed = plan(546, current)
  expect(crossed.blocks).not.toEqual(initial.blocks)
  expect(crossed.blocks).toHaveLength(120)
  expect(crossed.blocks.some((b) => blockKey(b) === "item:row-546:root")).toBe(
    true,
  )
  expect(plan(545, crossed).blocks).toEqual(crossed.blocks)
})

test("head, middle, and tail receive the same bounded neighborhood", () => {
  for (const row of [0, 500, 999]) expect(plan(row).blocks).toHaveLength(120)
  expect(plan(0).topSpacerRows).toBe(0)
  expect(plan(999).bottomSpacerRows).toBe(0)
})

test("distant jumps replace retained endpoints rather than dragging old content", () => {
  const initial = plan(500)
  const jumped = plan(100, initial)
  expect(jumped.blocks).toHaveLength(120)
  expect(jumped.blocks.some((b) => blockKey(b) === "item:row-100:root")).toBe(
    true,
  )
  expect(jumped.blocks.some((b) => blockKey(b) === "item:row-500:root")).toBe(
    false,
  )
})

test("retention is optional and never retains a whole pass-through history", () => {
  expect(
    plan(500, undefined, { retainWindow: false }).blocks.length,
  ).toBeLessThan(40)
  const oversized = { ...plan(500), blocks }
  expect(plan(500, oversized).blocks).toHaveLength(120)
})

test("reveal outside the retained range still materializes its destination", () => {
  const next = plan(500, plan(500), {
    reveal: { itemId: itemId("row-50"), graphemeOffset: 0 },
  })
  expect(next.blocks.some((b) => blockKey(b) === "item:row-50:root")).toBe(true)
  expect(next.blocks.length).toBeLessThanOrEqual(120)
})

test("retained endpoints use refined heights rather than stale spacer coordinates", () => {
  const before = plan(500)
  const changed = heights.replaceHeight({
    blockKey: blockKey(blocks[0]!),
    contentRevision: 1,
    rows: 40,
  })!
  const after = plan(501, before, { heights: changed })
  expect(after.blocks).toEqual(before.blocks)
  expect(after.topSpacerRows).toBe(before.topSpacerRows + 39)
})

test("large measured growth outside the viewport bounds the retained range again", () => {
  const before = plan(500)
  const changed = heights.replaceHeight({
    blockKey: blockKey(blocks[470]!),
    contentRevision: 1,
    rows: 1000,
  })!
  const after = plan(500, before, { heights: changed })
  expect(after.blocks.map(blockKey)).not.toEqual(before.blocks.map(blockKey))
  expect(after.blocks.some((b) => blockKey(b) === "item:row-500:root")).toBe(
    true,
  )
  expect(after.blocks.length).toBeLessThanOrEqual(120)
})

test("runtime retains detached content across streaming, relocation, and layout reset", () => {
  const thread = threadId("retained-runtime")
  let conversation = reduceConversation(createConversation(thread), {
    type: "turn.started",
    threadId: thread,
    turnId: turnId("turn"),
  })
  let transcript = initialTranscript()
  for (const block of blocks) {
    conversation = reduceConversation(conversation, {
      type: "item.started",
      threadId: thread,
      item: block.item,
    })
    transcript = syncTranscriptItem(transcript, block.item)
  }
  const point = { itemId: itemId("row-500"), graphemeOffset: 0 }
  transcript = {
    ...transcript,
    cursor: point,
    viewport: { kind: "point", point, preferredScreenRow: 0 },
  }
  let input: TranscriptRuntimeInput = {
    threadId: thread,
    conversation,
    transcript,
    canonicalGeneration: 1,
    canonicalRevision: 1,
    mode: "detached",
  }
  const runtime = new TranscriptRuntime(input, {
    windowPolicy: {
      retainWindow: true,
      viewportRows: 10,
      overscanRows: 10,
      recentTailRows: 120,
      recentTailBlocks: 120,
    },
  })
  const before = runtime.getSnapshot()
  const intent = runtime.getViewportIntentRevision()
  const appended = {
    ...blocks[999]!.item,
    id: itemId("new-tail"),
    status: "running" as const,
  }
  input = {
    ...input,
    canonicalRevision: 2,
    conversation: reduceConversation(conversation, {
      type: "item.started",
      threadId: thread,
      item: appended,
    }),
    transcript: syncTranscriptItem(transcript, appended),
    canonicalDamage: { kind: "blocks", itemIds: [appended.id] },
  }
  const streamed = runtime.update(input)
  expect(streamed.window.blocks.map(blockKey)).toEqual(
    before.window.blocks.map(blockKey),
  )
  expect(streamed.transcript.viewport).toEqual(before.transcript.viewport)
  expect(runtime.getViewportIntentRevision()).toBe(intent)
  const target = { itemId: itemId("row-100"), graphemeOffset: 0 }
  const jumped = runtime.update({
    ...input,
    canonicalDamage: { kind: "none" },
    presentationDamage: { kind: "view" },
    transcript: {
      ...input.transcript,
      viewport: { kind: "point", point: target, preferredScreenRow: 0 },
    },
  })
  expect(
    jumped.window.blocks.some((b) => blockKey(b) === "item:row-100:root"),
  ).toBe(true)
  expect(
    jumped.window.blocks.some((b) => blockKey(b) === "item:row-500:root"),
  ).toBe(false)
  expect(jumped.transcript.cursor).toEqual(before.transcript.cursor)
  const reset = runtime.resetLayout("width")
  expect(reset.geometry.generation).toBeGreaterThan(jumped.geometry.generation)
  expect(reset.transcript.viewport).toEqual(jumped.transcript.viewport)
  expect(reset.window.blocks.length).toBeLessThanOrEqual(120)
  runtime.dispose()
})
