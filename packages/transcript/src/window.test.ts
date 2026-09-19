import { expect, test } from "bun:test"
import { createConversation, itemId, reduceConversation, threadId, turnId, type ConversationEvent } from "@vimex/conversation"
import { initialTranscript } from "./domain/transcript-document"
import { syncTranscriptItem } from "./application/project-conversation"
import { blockGraphemeRange, blockKey, buildTranscriptBlocks, passThroughWindow, pointIsMaterialized, transcriptActivityPresentation, type TranscriptItemBlock } from "./window"

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
  const { conversation, transcript, firstItem, emptyItem } = fixture()
  const blocks = buildTranscriptBlocks({ conversation, transcript })
  const first = blocks.find(block => block.key.kind === "item" && block.key.itemId === firstItem)
  const empty = blocks.find(block => block.key.kind === "item" && block.key.itemId === emptyItem)

  expect(first).toMatchObject({ turnId: "first-turn", item: { status: "complete" }, sourceSpan: { from: 0, to: 5 }, estimatedRows: 1 })
  expect(empty).toMatchObject({ item: { status: "interrupted" }, sourceSpan: { from: 0, to: 0 }, estimatedRows: 1 })
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

test("pass-through materializes every block with no spacers or overscan", () => {
  const { conversation, transcript } = fixture()
  const blocks = buildTranscriptBlocks({ conversation, transcript })
  const window = passThroughWindow(blocks, transcript)
  expect(window).toEqual({ blocks, activityBatches: [], activityBatchByItem: {}, activityPresentation: {}, topSpacerRows: 0, bottomSpacerRows: 0, overscanRows: 0 })
  expect(window.blocks).toBe(blocks)
  expect(Object.isFrozen(window)).toBe(true)
})

test("derives adjacent settled web, read, and provider activity batches without hiding canonical blocks", () => {
  const thread = threadId("activity-thread"), turn = turnId("activity-turn")
  const items = [
    { id: itemId("web-1"), turnId: turn, kind: "tool" as const, title: "Web search", detail: "one", activity: { family: "web-research" as const }, status: "complete" as const },
    { id: itemId("web-2"), turnId: turn, kind: "tool" as const, title: "Web search", detail: "two", activity: { family: "web-research" as const }, status: "complete" as const },
    { id: itemId("message"), turnId: turn, kind: "assistant" as const, markdown: "progress", status: "complete" as const },
    { id: itemId("read-1"), turnId: turn, kind: "command" as const, title: "Read /repo/a.ts", detail: "a", activity: { family: "read" as const }, status: "complete" as const },
    { id: itemId("read-2"), turnId: turn, kind: "command" as const, title: "Read /repo/b.ts", detail: "b", activity: { family: "read" as const }, status: "complete" as const },
    { id: itemId("linear-1"), turnId: turn, kind: "tool" as const, title: "codex_apps · linear.search_documentation", detail: "a", activity: { family: "provider" as const, label: "Linear" }, status: "complete" as const, durationMs: 833 },
    { id: itemId("linear-2"), turnId: turn, kind: "tool" as const, title: "codex_apps · linear.get_issue", detail: "b", activity: { family: "provider" as const, label: "Linear" }, status: "complete" as const, durationMs: 965 },
    { id: itemId("linear-error"), turnId: turn, kind: "tool" as const, title: "codex_apps · linear.list_comments", detail: "error", status: "error" as const },
  ]
  let conversation = reduceConversation(createConversation(thread), { type: "turn.started", threadId: thread, turnId: turn })
  let transcript = initialTranscript()
  for (const item of items) {
    conversation = reduceConversation(conversation, { type: "item.started", threadId: thread, item })
    transcript = syncTranscriptItem(transcript, item)
  }
  const blocks = buildTranscriptBlocks({ conversation, transcript })
  const window = passThroughWindow(blocks, transcript)

  expect(window.blocks).toHaveLength(items.length)
  expect(window.activityBatches).toEqual([
    expect.objectContaining({ family: "web-research", label: "Web research", countLabel: "2 searches", leadItemId: itemId("web-1"), itemIds: [itemId("web-1"), itemId("web-2")] }),
    expect.objectContaining({ family: "read", label: "Read files", countLabel: "2 reads", leadItemId: itemId("read-1"), itemIds: [itemId("read-1"), itemId("read-2")] }),
    expect.objectContaining({ family: "provider", label: "Linear", countLabel: "2 actions", leadItemId: itemId("linear-1"), itemIds: [itemId("linear-1"), itemId("linear-2")], durationMs: 1798 }),
  ])
  expect(window.activityBatches[0]?.durationMs).toBeUndefined()
  expect(window.activityBatches.every(Object.isFrozen)).toBe(true)

  const first = blocks.find(block => block.key.kind === "item" && block.key.itemId === itemId("web-1")) as TranscriptItemBlock
  const boundary = first.sourceSpan.from + 1
  const prefix = Object.freeze({ ...first, sourceSpan: Object.freeze({ from: first.sourceSpan.from, to: boundary }) })
  const split = Object.freeze({ ...first, key: Object.freeze({ ...first.key, blockId: "result" }), sourceSpan: Object.freeze({ from: boundary, to: first.sourceSpan.to }) })
  const splitState = { ...transcript, folded: { ...transcript.folded, [itemId("web-1")]: true, [itemId("web-2")]: true } }
  const splitWindow = passThroughWindow(Object.freeze([prefix, split, ...blocks.slice(1)]), splitState)
  expect(splitWindow.activityBatches[0]?.countLabel).toBe("2 searches")
  expect(splitWindow.activityBatches[0]?.itemIds).toEqual([itemId("web-1"), itemId("web-2")])
  expect(splitWindow.activityPresentation[`item:web-1:root`]?.kind).toBe("activity-lead")
  expect(splitWindow.activityPresentation[`item:web-1:result`]?.kind).toBe("activity-hidden")
  expect(splitWindow.activityPresentation[`item:web-2:root`]?.kind).toBe("activity-hidden")
  const outsideLead = splitWindow.activityBatches[0]!.leadGraphemeTo + (splitWindow.activityBatches[0]!.leadIncludesEnd ? 1 : 0)
  expect(transcriptActivityPresentation(splitWindow, { ...splitState, cursor: { itemId: itemId("web-1"), graphemeOffset: outsideLead } })).toEqual({})
})

test("activity presentation compacts only fully folded groups and reveals a precise hidden target", () => {
  const thread = threadId("batch-state"), turn = turnId("batch-turn")
  const ids = [itemId("batch-a"), itemId("batch-b")]
  const items = ids.map((id, index) => ({ id, turnId: turn, kind: "tool" as const, title: "Web search", detail: String(index), activity: { family: "web-research" as const }, status: "complete" as const }))
  let conversation = reduceConversation(createConversation(thread), { type: "turn.started", threadId: thread, turnId: turn })
  let transcript = initialTranscript()
  for (const item of items) {
    conversation = reduceConversation(conversation, { type: "item.started", threadId: thread, item })
    transcript = syncTranscriptItem(transcript, item)
  }
  const folded = { ...transcript, folded: { [ids[0]!]: true, [ids[1]!]: true } }
  const window = passThroughWindow(buildTranscriptBlocks({ conversation, transcript }), folded)
  expect(transcriptActivityPresentation(window, folded)).toMatchObject({
    [`item:${ids[0]}:root`]: { kind: "activity-lead", itemId: ids[0] },
    [`item:${ids[1]}:root`]: { kind: "activity-hidden", itemId: ids[1] },
  })
  expect(window.activityPresentation).toMatchObject({
    [`item:${ids[0]}:root`]: { kind: "activity-lead", itemId: ids[0] },
    [`item:${ids[1]}:root`]: { kind: "activity-hidden", itemId: ids[1] },
  })
  expect(transcriptActivityPresentation(window, { ...folded, cursor: { itemId: ids[1]!, graphemeOffset: 0 } })).toEqual({})
  expect(transcriptActivityPresentation(window, { ...folded, folded: { ...folded.folded, [ids[0]!]: false } })).toEqual({})
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
