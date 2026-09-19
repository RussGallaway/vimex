import { expect, test } from "bun:test"
import { createConversation, itemId, reduceConversation, threadId, turnId, type ConversationEvent } from "@vimex/conversation"
import { initialTranscript } from "./domain/transcript-document"
import { syncTranscriptItem } from "./application/project-conversation"
import { blockGraphemeRange, blockKey, buildTranscriptBlocks, passThroughWindow, pointIsMaterialized, type TranscriptItemBlock } from "./window"

function fixture() {
  const thread = threadId("thread")
  const firstTurn = turnId("first-turn"), emptyTurn = turnId("empty-turn"), finalTurn = turnId("final-turn")
  const firstItem = itemId("first-item"), emptyItem = itemId("empty-item"), finalItem = itemId("final-item"), decoration = itemId("decoration")
  const events: ConversationEvent[] = [
    { type: "turn.started", threadId: thread, turnId: firstTurn },
    { type: "item.started", threadId: thread, item: { id: firstItem, turnId: firstTurn, kind: "assistant", markdown: "first", status: "running" } },
    { type: "turn.completed", threadId: thread, turnId: firstTurn, outcome: "complete", startedAt: 100, completedAt: 350, durationMs: 250 },
    { type: "turn.started", threadId: thread, turnId: emptyTurn },
    { type: "item.started", threadId: thread, item: { id: decoration, turnId: emptyTurn, kind: "agent", action: "activity", activity: "completed", agentPath: "/root/worker", detail: "", agentThreadIds: [], status: "complete" } },
    { type: "turn.completed", threadId: thread, turnId: emptyTurn, outcome: "failed" },
    { type: "turn.started", threadId: thread, turnId: finalTurn },
    { type: "item.started", threadId: thread, item: { id: emptyItem, turnId: finalTurn, kind: "assistant", markdown: "", status: "running" } },
    { type: "item.started", threadId: thread, item: { id: finalItem, turnId: finalTurn, kind: "assistant", markdown: "final", status: "complete" } },
    { type: "turn.completed", threadId: thread, turnId: finalTurn, outcome: "interrupted" },
  ]
  const conversation = events.reduce(reduceConversation, createConversation(thread))
  // Deliberately reverse semantic order: the block plan follows canonical turn
  // and item chronology rather than incidental projection insertion order.
  let transcript = initialTranscript()
  for (const id of [finalItem, emptyItem, firstItem]) transcript = syncTranscriptItem(transcript, conversation.items[id]!)
  return { conversation, transcript, firstTurn, emptyTurn, finalTurn, firstItem, emptyItem, finalItem }
}

test("builds frozen item and activity blocks in canonical turn chronology", () => {
  const { conversation, transcript, firstItem, emptyItem, finalItem } = fixture()
  const blocks = buildTranscriptBlocks({ conversation, transcript })

  expect(blocks.map(blockKey)).toEqual([
    `item:${firstItem}:root`,
    "turn-activity:first-turn",
    "turn-activity:empty-turn",
    `item:${emptyItem}:root`,
    `item:${finalItem}:root`,
    "turn-activity:final-turn",
  ])
  expect(Object.isFrozen(blocks)).toBe(true)
  expect(blocks.every(block => Object.isFrozen(block) && Object.isFrozen(block.key))).toBe(true)
})

test("item blocks snapshot effective status, share readonly projections, and retain full source spans", () => {
  const { conversation, transcript, firstItem, emptyItem, finalItem } = fixture()
  const blocks = buildTranscriptBlocks({ conversation, transcript })
  const first = blocks.find(block => block.key.kind === "item" && block.key.itemId === firstItem)
  const empty = blocks.find(block => block.key.kind === "item" && block.key.itemId === emptyItem)
  const final = blocks.find(block => block.key.kind === "item" && block.key.itemId === finalItem)

  expect(first).toMatchObject({ turnId: "first-turn", item: { status: "complete" }, sourceSpan: { from: 0, to: 5 }, estimatedRows: 1 })
  expect(empty).toMatchObject({ item: { status: "interrupted" }, sourceSpan: { from: 0, to: 0 }, estimatedRows: 1 })
  expect(first).toMatchObject({ followedByActivity: true })
  expect(empty && "projection" in empty ? empty.followedByActivity : undefined).toBe(false)
  expect(final).toMatchObject({ followedByActivity: true })
  if (!first || !("projection" in first)) throw new Error("Expected first item block")
  expect(first.projection).toBe(transcript.projectionById[firstItem]!)
  expect(Object.isFrozen(first.item)).toBe(true)
})

test("published item payloads do not expose nested canonical objects", () => {
  const thread = threadId("thread"), turn = turnId("turn"), id = itemId("edit")
  const change = { path: "before.ts", action: "update" as const, patch: "-old\n+new" }
  const events: ConversationEvent[] = [
    { type: "turn.started", threadId: thread, turnId: turn },
    { type: "item.started", threadId: thread, item: { id, turnId: turn, kind: "edit", title: "Edit", patch: change.patch, changes: [change], status: "complete" } },
  ]
  const conversation = events.reduce(reduceConversation, createConversation(thread))
  const transcript = syncTranscriptItem(initialTranscript(), conversation.items[id]!)
  const block = buildTranscriptBlocks({ conversation, transcript }).find(candidate => candidate.key.kind === "item")
  if (!block || !("projection" in block) || block.item.kind !== "edit") throw new Error("Expected edit block")

  expect(block.item).not.toBe(conversation.items[id])
  expect(block.item.changes).not.toBe((conversation.items[id] as Extract<typeof conversation.items[string], { kind: "edit" }>).changes)
  expect(Object.isFrozen(block.item.changes)).toBe(true)
  expect(block.item.changes?.every(Object.isFrozen)).toBe(true)
  expect(block.item.changes?.[0]?.path).toBe("before.ts")
})

test("excluded turns remove both semantic items and their activity decoration", () => {
  const { conversation, transcript, firstTurn, finalTurn } = fixture()
  const blocks = buildTranscriptBlocks({ conversation, transcript, excludedTurnIds: new Set([firstTurn, finalTurn]) })
  expect(blocks.map(blockKey)).toEqual(["turn-activity:empty-turn"])
})

test("activity revisions are stable across fresh builds and change with render-relevant timing", () => {
  const { conversation, transcript, firstTurn } = fixture()
  const first = buildTranscriptBlocks({ conversation, transcript }).find(block => block.key.kind === "turn-activity" && block.key.turnId === firstTurn)
  const rebuilt = buildTranscriptBlocks({ conversation: { ...conversation, turns: { ...conversation.turns, [firstTurn]: { ...conversation.turns[firstTurn]!, itemIds: [...conversation.turns[firstTurn]!.itemIds] } } }, transcript })
    .find(block => block.key.kind === "turn-activity" && block.key.turnId === firstTurn)
  const changed = buildTranscriptBlocks({ conversation: { ...conversation, turns: { ...conversation.turns, [firstTurn]: { ...conversation.turns[firstTurn]!, durationMs: 251 } } }, transcript })
    .find(block => block.key.kind === "turn-activity" && block.key.turnId === firstTurn)

  expect(rebuilt?.contentRevision).toBe(first?.contentRevision)
  expect(changed?.contentRevision).not.toBe(first?.contentRevision)
})

test("item revisions include render-visible metadata as well as projection revision", () => {
  const { conversation, transcript, firstItem } = fixture()
  const first = buildTranscriptBlocks({ conversation, transcript }).find(block => block.key.kind === "item" && block.key.itemId === firstItem)
  const changedConversation = {
    ...conversation,
    items: { ...conversation.items, [firstItem]: { ...conversation.items[firstItem]!, durationMs: 999 } },
  }
  const changed = buildTranscriptBlocks({ conversation: changedConversation, transcript }).find(block => block.key.kind === "item" && block.key.itemId === firstItem)

  expect(changed && "projection" in changed ? changed.projection.revision : undefined)
    .toBe(first && "projection" in first ? first.projection.revision : undefined)
  expect(changed?.contentRevision).not.toBe(first?.contentRevision)
})

test("activity adjacency is immutable block metadata and invalidates the final item footprint", () => {
  const { conversation, transcript, finalTurn, finalItem } = fixture()
  const withActivity = buildTranscriptBlocks({ conversation, transcript }).find(block => block.key.kind === "item" && block.key.itemId === finalItem)
  const runningConversation = {
    ...conversation,
    turns: { ...conversation.turns, [finalTurn]: { ...conversation.turns[finalTurn]!, status: "running" as const, completedAt: undefined, durationMs: undefined } },
  }
  const withoutActivity = buildTranscriptBlocks({ conversation: runningConversation, transcript }).find(block => block.key.kind === "item" && block.key.itemId === finalItem)
  expect(withActivity).toMatchObject({ followedByActivity: true })
  expect(withoutActivity && "projection" in withoutActivity ? withoutActivity.followedByActivity : undefined).toBe(false)
  expect(withoutActivity?.contentRevision).not.toBe(withActivity?.contentRevision)
})

test("activity adjacency follows the last semantic item when later telemetry is omitted", () => {
  const thread = threadId("telemetry-thread"), turn = turnId("telemetry-turn")
  const answer = itemId("telemetry-answer"), telemetry = itemId("telemetry-only")
  const events: ConversationEvent[] = [
    { type: "turn.started", threadId: thread, turnId: turn },
    { type: "item.started", threadId: thread, item: { id: answer, turnId: turn, kind: "assistant", markdown: "answer", status: "complete" } },
    { type: "item.started", threadId: thread, item: { id: telemetry, turnId: turn, kind: "agent", action: "wait", detail: "", agentThreadIds: [], status: "complete" } },
    { type: "turn.completed", threadId: thread, turnId: turn, outcome: "complete", durationMs: 10 },
  ]
  const conversation = events.reduce(reduceConversation, createConversation(thread))
  const transcript = syncTranscriptItem(initialTranscript(), conversation.items[answer]!)
  const blocks = buildTranscriptBlocks({ conversation, transcript })
  expect(blocks.map(blockKey)).toEqual([`item:${answer}:root`, `turn-activity:${turn}`])
  expect(blocks[0]).toMatchObject({ followedByActivity: true })
})

test("pass-through materializes every block with no spacers or overscan", () => {
  const { conversation, transcript } = fixture()
  const blocks = buildTranscriptBlocks({ conversation, transcript })
  const window = passThroughWindow(blocks)
  expect(window).toEqual({ blocks, topSpacerRows: 0, bottomSpacerRows: 0, overscanRows: 0 })
  expect(window.blocks).toBe(blocks)
  expect(Object.isFrozen(window)).toBe(true)
})

test("logical targets materialize only through item blocks, including empty source", () => {
  const { conversation, transcript, emptyTurn, emptyItem } = fixture()
  const blocks = buildTranscriptBlocks({ conversation, transcript })
  const activityOnly = blocks.filter(block => block.key.kind === "turn-activity" && block.key.turnId === emptyTurn)

  expect(pointIsMaterialized(blocks, { itemId: emptyItem, graphemeOffset: 0 })).toBe(true)
  expect(pointIsMaterialized(blocks, { itemId: emptyItem, graphemeOffset: 1 })).toBe(false)
  expect(pointIsMaterialized(activityOnly, { itemId: itemId("empty-turn"), graphemeOffset: 0 })).toBe(false)
  expect(activityOnly[0]?.sourceSpan).toBeUndefined()
})

test("extensible item block identities and source spans address sub-block materialization", () => {
  const { conversation, transcript, firstItem } = fixture()
  const root = buildTranscriptBlocks({ conversation, transcript }).find(block => block.key.kind === "item" && block.key.itemId === firstItem)
  if (!root || !("projection" in root)) throw new Error("Expected item block")
  const prefix: TranscriptItemBlock = Object.freeze({
    ...root,
    key: Object.freeze({ kind: "item", itemId: firstItem, blockId: "markdown:paragraph:0" }),
    renderItem: Object.freeze({ ...root.renderItem, markdown: "f" }),
    sourceSpan: Object.freeze({ from: 0, to: 1 }),
  })
  const suffix: TranscriptItemBlock = Object.freeze({
    ...root,
    key: Object.freeze({ kind: "item", itemId: firstItem, blockId: "markdown:paragraph:1" }),
    renderItem: Object.freeze({ ...root.renderItem, markdown: root.projection.source.slice(1) }),
    sourceSpan: Object.freeze({ from: 1, to: root.projection.source.length }),
  })

  expect(blockKey(prefix)).toBe(`item:${firstItem}:markdown:paragraph:0`)
  expect(blockGraphemeRange(prefix)).toEqual({ from: 0, to: 1 })
  expect(prefix.renderItem).not.toBe(prefix.item)
  expect(pointIsMaterialized([prefix], { itemId: firstItem, graphemeOffset: 0 })).toBe(true)
  expect(pointIsMaterialized([prefix], { itemId: firstItem, graphemeOffset: 1 })).toBe(false)
  expect(pointIsMaterialized([prefix, suffix], { itemId: firstItem, graphemeOffset: 1 })).toBe(true)
  expect(pointIsMaterialized([prefix], { itemId: firstItem, graphemeOffset: 2 })).toBe(false)
})
