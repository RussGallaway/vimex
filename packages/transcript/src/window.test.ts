import { expect, test } from "bun:test"
import { createConversation, itemId, reduceConversation, threadId, turnId, type ConversationEvent } from "@vimex/conversation"
import { buildOversizedTranscriptFixtures } from "@vimex/testkit"
import { initialTranscript, setTranscriptFoldValue } from "./domain/transcript-document"
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

test("completed command output becomes stable contiguous production sub-blocks with exact root fallbacks", () => {
  const thread = threadId("command-fragments"), turn = turnId("command-fragments-turn"), id = itemId("large-command")
  const detail = Array.from({ length: 240 }, (_, index) => `${String(index).padStart(4, "0")}: ${"literal output ".repeat(6)}`).join("\n")
  const item = { id, turnId: turn, kind: "command" as const, title: "Large command", executionCommand: "bun test",
    detail, status: "complete" as const }
  const events: ConversationEvent[] = [
    { type: "turn.started", threadId: thread, turnId: turn },
    { type: "item.started", threadId: thread, item },
    { type: "turn.completed", threadId: thread, turnId: turn, outcome: "complete", durationMs: 1 },
  ]
  const conversation = events.reduce(reduceConversation, createConversation(thread))
  const transcript = syncTranscriptItem(initialTranscript(), conversation.items[id]!)
  const blocks = buildTranscriptBlocks({ conversation, transcript })
  const itemBlocks = blocks.filter((block): block is TranscriptItemBlock => "projection" in block)
  const rebuilt = buildTranscriptBlocks({ conversation, transcript })
    .filter((block): block is TranscriptItemBlock => "projection" in block)

  expect(itemBlocks.length).toBeGreaterThan(1)
  expect(rebuilt.every((block, index) => block === itemBlocks[index])).toBe(true)
  expect(new Set(itemBlocks.map(blockKey)).size).toBe(itemBlocks.length)
  expect(itemBlocks[0]?.key.blockId).toBe("command:header")
  expect(itemBlocks[0]?.sourceSpan.from).toBe(0)
  expect(itemBlocks.at(-1)?.sourceSpan.to).toBe(transcript.projectionById[id]!.source.length)
  expect(itemBlocks.every((block, index) => index === 0 || itemBlocks[index - 1]!.sourceSpan.to === block.sourceSpan.from)).toBe(true)
  expect(itemBlocks.every(block => block.sourceSpan.to - block.sourceSpan.from <= 4_096)).toBe(true)
  expect(itemBlocks.every(block => block.item === itemBlocks[0]!.item && block.projection === transcript.projectionById[id])).toBe(true)
  expect(itemBlocks.map(block => block.followedByActivity)).toEqual(itemBlocks.map((_, index) => index === itemBlocks.length - 1))
  expect(itemBlocks.map(block => {
    if (block.renderItem.kind !== "command") throw new Error("Expected command render payload")
    return [block.renderItem.title, block.renderItem.executionCommand, block.renderItem.detail].filter(Boolean).join("\n")
  })).toEqual(itemBlocks.map(block => block.projection.source.slice(block.sourceSpan.from, block.sourceSpan.to)))

  for (let offset = 0; offset <= itemBlocks[0]!.projection.sourceSpans.length; offset++) {
    expect(itemBlocks.filter(block => pointIsMaterialized([block], { itemId: id, graphemeOffset: offset }))).toHaveLength(1)
  }

  const folded = { ...transcript, folded: setTranscriptFoldValue(transcript.folded, id, true) }
  expect(buildTranscriptBlocks({ conversation, transcript: folded }).filter(block => "projection" in block).map(blockKey))
    .toEqual([`item:${id}:root`])

  const runningConversation = [events[0]!, { type: "item.started", threadId: thread,
    item: { ...item, status: "running" as const } } satisfies ConversationEvent]
    .reduce(reduceConversation, createConversation(thread))
  const runningTranscript = syncTranscriptItem(initialTranscript(), runningConversation.items[id]!)
  expect(buildTranscriptBlocks({ conversation: runningConversation, transcript: runningTranscript }).map(blockKey))
    .toEqual([`item:${id}:root`])

  const longLineItem = { ...item, id: itemId("unbreakable-command"), detail: "x".repeat(8_192) }
  const longLineConversation = [events[0]!, { type: "item.started", threadId: thread, item: longLineItem } satisfies ConversationEvent]
    .reduce(reduceConversation, createConversation(thread))
  const longLineTranscript = syncTranscriptItem(initialTranscript(), longLineConversation.items[longLineItem.id]!)
  expect(buildTranscriptBlocks({ conversation: longLineConversation, transcript: longLineTranscript }).map(blockKey))
    .toEqual([`item:${longLineItem.id}:root`])

  const crlfItem = { ...item, id: itemId("crlf-command"), detail: `${"line\r\n".repeat(1_000)}` }
  const crlfConversation = [events[0]!, { type: "item.started", threadId: thread, item: crlfItem } satisfies ConversationEvent]
    .reduce(reduceConversation, createConversation(thread))
  const crlfTranscript = syncTranscriptItem(initialTranscript(), crlfConversation.items[crlfItem.id]!)
  expect(buildTranscriptBlocks({ conversation: crlfConversation, transcript: crlfTranscript }).map(blockKey))
    .toEqual([`item:${crlfItem.id}:root`])

  const blankBoundaryItem = { ...item, id: itemId("blank-boundary-command"), title: "t".repeat(4_094),
    executionCommand: undefined, detail: `\n${"visible output\n".repeat(400)}` }
  const blankBoundaryConversation = [events[0]!, {
    type: "item.started", threadId: thread, item: blankBoundaryItem,
  } satisfies ConversationEvent].reduce(reduceConversation, createConversation(thread))
  const blankBoundaryTranscript = syncTranscriptItem(initialTranscript(), blankBoundaryConversation.items[blankBoundaryItem.id]!)
  expect(buildTranscriptBlocks({ conversation: blankBoundaryConversation, transcript: blankBoundaryTranscript }).map(blockKey))
    .toEqual([`item:${blankBoundaryItem.id}:root`])
})

test("completed oversized Markdown composes exact stable projection fragments with conservative root fallbacks", () => {
  const oversized = buildOversizedTranscriptFixtures().find(candidate => candidate.shape === "markdown")!
  if (oversized.item.kind !== "assistant") throw new Error("Expected Markdown fixture")
  const thread = threadId("markdown-fragments")
  const events: ConversationEvent[] = [
    { type: "turn.started", threadId: thread, turnId: oversized.item.turnId },
    { type: "item.started", threadId: thread, item: oversized.item },
    { type: "turn.completed", threadId: thread, turnId: oversized.item.turnId, outcome: "complete", durationMs: 1 },
  ]
  const conversation = events.reduce(reduceConversation, createConversation(thread))
  const transcript = syncTranscriptItem(initialTranscript(), conversation.items[oversized.item.id]!)
  const itemBlocks = buildTranscriptBlocks({ conversation, transcript })
    .filter((block): block is TranscriptItemBlock => "projection" in block)
  const rebuilt = buildTranscriptBlocks({ conversation, transcript })
    .filter((block): block is TranscriptItemBlock => "projection" in block)

  expect(itemBlocks.length).toBeGreaterThan(1)
  expect(rebuilt.every((block, index) => block === itemBlocks[index])).toBe(true)
  expect(new Set(itemBlocks.map(blockKey)).size).toBe(itemBlocks.length)
  expect(itemBlocks.every(block => block.fragment?.kind === "markdown")).toBe(true)
  expect(itemBlocks.every(block => block.sourceSpan.to - block.sourceSpan.from <= 4_096)).toBe(true)
  expect(itemBlocks.every((block, index) => index === 0 || itemBlocks[index - 1]!.sourceSpan.to === block.sourceSpan.from)).toBe(true)
  expect(itemBlocks[0]?.sourceSpan.from).toBe(0)
  expect(itemBlocks.at(-1)?.sourceSpan.to).toBe(oversized.source.length)
  expect(itemBlocks.every(block => block.item === itemBlocks[0]!.item && block.projection === transcript.projectionById[oversized.item.id])).toBe(true)
  expect(itemBlocks.map(block => block.followedByActivity)).toEqual(itemBlocks.map((_, index) => index === itemBlocks.length - 1))
  expect(itemBlocks.map(block => block.renderItem.kind === "assistant" ? block.renderItem.markdown : undefined))
    .toEqual(itemBlocks.map(block => oversized.source.slice(block.sourceSpan.from, block.sourceSpan.to)))
  for (let offset = 0; offset <= itemBlocks[0]!.projection.sourceSpans.length; offset++) {
    expect(itemBlocks.filter(block => pointIsMaterialized([block], { itemId: oversized.item.id, graphemeOffset: offset }))).toHaveLength(1)
  }

  const folded = { ...transcript, folded: setTranscriptFoldValue(transcript.folded, oversized.item.id, true) }
  expect(buildTranscriptBlocks({ conversation, transcript: folded }).filter(block => "projection" in block).map(blockKey))
    .toEqual([`item:${oversized.item.id}:root`])

  for (const [name, markdown] of [
    ["running", oversized.item.markdown],
    ["crlf", oversized.item.markdown.replaceAll("\n", "\r\n")],
    ["list", `${"- list item\n\n".repeat(600)}`],
    ["cross-reference", `${"[shared] reference paragraph.\n\n".repeat(200)}[shared]: https://vimex.test`],
    ["single-paragraph", "one indivisible paragraph ".repeat(300)],
  ] as const) {
    const id = itemId(`markdown-fallback-${name}`)
    const item = { ...oversized.item, id, markdown, status: name === "running" ? "running" as const : "complete" as const }
    const fallbackEvents: ConversationEvent[] = [
      { type: "turn.started", threadId: thread, turnId: item.turnId },
      { type: "item.started", threadId: thread, item },
    ]
    if (name !== "running") fallbackEvents.push({ type: "turn.completed", threadId: thread, turnId: item.turnId, outcome: "complete" })
    const fallbackConversation = fallbackEvents.reduce(reduceConversation, createConversation(thread))
    const fallbackTranscript = syncTranscriptItem(initialTranscript(), fallbackConversation.items[id]!)
    expect(buildTranscriptBlocks({ conversation: fallbackConversation, transcript: fallbackTranscript }).filter(block => "projection" in block).map(blockKey))
      .toEqual([`item:${id}:root`])
  }
})

test("completed multi-file edits become exact stable per-file fragments with metadata fallbacks", () => {
  const oversized = buildOversizedTranscriptFixtures().find(candidate => candidate.shape === "split-diff")!
  if (oversized.item.kind !== "edit" || !oversized.item.changes) throw new Error("Expected edit fixture")
  const thread = threadId("edit-fragments")
  const events: ConversationEvent[] = [
    { type: "turn.started", threadId: thread, turnId: oversized.item.turnId },
    { type: "item.started", threadId: thread, item: oversized.item },
    { type: "turn.completed", threadId: thread, turnId: oversized.item.turnId, outcome: "complete", durationMs: 1 },
  ]
  const conversation = events.reduce(reduceConversation, createConversation(thread))
  const transcript = syncTranscriptItem(initialTranscript(), conversation.items[oversized.item.id]!)
  const itemBlocks = buildTranscriptBlocks({ conversation, transcript })
    .filter((block): block is TranscriptItemBlock => "projection" in block)
  const rebuilt = buildTranscriptBlocks({ conversation, transcript })
    .filter((block): block is TranscriptItemBlock => "projection" in block)

  expect(itemBlocks).toHaveLength(oversized.item.changes.length)
  expect(rebuilt.every((block, index) => block === itemBlocks[index])).toBe(true)
  expect(new Set(itemBlocks.map(blockKey)).size).toBe(itemBlocks.length)
  expect(itemBlocks[0]?.fragment?.kind).toBe("edit-header")
  expect(itemBlocks.slice(1).every(block => block.fragment?.kind === "edit-file")).toBe(true)
  expect(itemBlocks.every((block, index) => index === 0 || itemBlocks[index - 1]!.sourceSpan.to === block.sourceSpan.from)).toBe(true)
  expect(itemBlocks[0]?.sourceSpan.from).toBe(0)
  expect(itemBlocks.at(-1)?.sourceSpan.to).toBe(oversized.source.length)
  expect(itemBlocks.every(block => block.sourceSpan.to - block.sourceSpan.from <= 240)).toBe(true)
  expect(itemBlocks.every(block => block.item === itemBlocks[0]!.item && block.projection === transcript.projectionById[oversized.item.id])).toBe(true)
  expect(itemBlocks.map(block => block.followedByActivity)).toEqual(itemBlocks.map((_, index) => index === itemBlocks.length - 1))
  for (let offset = 0; offset <= itemBlocks[0]!.projection.sourceSpans.length; offset++) {
    expect(itemBlocks.filter(block => pointIsMaterialized([block], { itemId: oversized.item.id, graphemeOffset: offset }))).toHaveLength(1)
  }

  const duplicatePaths = { ...oversized.item, id: itemId("duplicate-edit-paths"),
    changes: oversized.item.changes.map(change => ({ ...change, path: "same.ts" })) }
  const duplicateConversation = [events[0]!, { type: "item.started", threadId: thread, item: duplicatePaths } satisfies ConversationEvent]
    .reduce(reduceConversation, createConversation(thread))
  const duplicateTranscript = syncTranscriptItem(initialTranscript(), duplicateConversation.items[duplicatePaths.id]!)
  const duplicateKeys = buildTranscriptBlocks({ conversation: duplicateConversation, transcript: duplicateTranscript }).map(blockKey)
  expect(new Set(duplicateKeys).size).toBe(duplicateKeys.length)

  const folded = { ...transcript, folded: setTranscriptFoldValue(transcript.folded, oversized.item.id, true) }
  expect(buildTranscriptBlocks({ conversation, transcript: folded }).filter(block => "projection" in block).map(blockKey))
    .toEqual([`item:${oversized.item.id}:root`])

  for (const item of [
    { ...oversized.item, id: itemId("running-edit"), status: "running" as const },
    { ...oversized.item, id: itemId("missing-edit-metadata"), changes: undefined },
    { ...oversized.item, id: itemId("inconsistent-edit-metadata"), changes: oversized.item.changes.slice(1) },
    { ...oversized.item, id: itemId("single-file-edit"), patch: oversized.item.changes[0]!.patch, changes: oversized.item.changes.slice(0, 1) },
  ]) {
    const fallbackConversation = [events[0]!, { type: "item.started", threadId: thread, item } satisfies ConversationEvent]
      .reduce(reduceConversation, createConversation(thread))
    const fallbackTranscript = syncTranscriptItem(initialTranscript(), fallbackConversation.items[item.id]!)
    expect(buildTranscriptBlocks({ conversation: fallbackConversation, transcript: fallbackTranscript }).filter(block => "projection" in block).map(blockKey))
      .toEqual([`item:${item.id}:root`])
  }
})
