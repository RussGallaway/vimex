import { expect, test } from "bun:test"
import { createConversation, itemId, reduceConversation, threadId, turnId, type ConversationEvent, type ItemId } from "@vimex/conversation"
import { syncTranscriptItem } from "./application/project-conversation"
import { initialTranscript, type TranscriptState } from "./domain/transcript-document"
import { TranscriptRuntime, type TranscriptDamage, type TranscriptRuntimeInput } from "./runtime"
import { blockKey } from "./window"
import type { BlockGeometry, BlockMeasurementBatch } from "./geometry"

interface Source {
  conversation: ReturnType<typeof createConversation>
  transcript: TranscriptState
  revision: number
}

const thread = threadId("thread"), turn = turnId("turn"), answer = itemId("answer")

function apply(source: Source, event: ConversationEvent): Source {
  const conversation = reduceConversation(source.conversation, event)
  let transcript = source.transcript
  const changed = event.type === "item.delta" ? event.itemId
    : event.type === "item.started" || event.type === "item.completed" ? event.item.id : undefined
  if (changed && conversation.items[changed]) transcript = syncTranscriptItem(transcript, conversation.items[changed]!)
  return { conversation, transcript, revision: source.revision + (conversation === source.conversation ? 0 : 1) }
}

function fixture(): Source {
  let source: Source = { conversation: createConversation(thread), transcript: initialTranscript(), revision: 0 }
  source = apply(source, { type: "turn.started", threadId: thread, turnId: turn })
  source = apply(source, { type: "item.started", threadId: thread, item: { id: answer, turnId: turn, kind: "assistant", markdown: "hello", status: "running" } })
  return source
}

let revealId = 0
function input(source: Source, mode: "follow" | "detached", canonicalDamage: TranscriptDamage = { kind: "none" }, reveal?: { itemId: ItemId; graphemeOffset: number }): TranscriptRuntimeInput {
  return { threadId: thread, canonicalGeneration: 0, canonicalRevision: source.revision, conversation: source.conversation, transcript: source.transcript, mode, canonicalDamage,
    reveal: reveal && { id: ++revealId, point: reveal, reason: "jump" } }
}

function semanticFrame(frame: ReturnType<TranscriptRuntime["getSnapshot"]>) {
  return {
    displayedCanonicalRevision: frame.displayedCanonicalRevision,
    mode: frame.mode,
    keys: frame.blocks.map(blockKey),
    blocks: frame.blocks.map(block => "projection" in block
      ? { key: blockKey(block), item: block.item, source: block.projection.source, sourceSpan: block.sourceSpan }
      : { key: blockKey(block), turn: block.turn, sourceSpan: block.sourceSpan }),
    window: { topSpacerRows: frame.window.topSpacerRows, bottomSpacerRows: frame.window.bottomSpacerRows, overscanRows: frame.window.overscanRows },
  }
}

function measurement(runtime: TranscriptRuntime, key: string, options: Partial<BlockGeometry["key"]> & { nativeRevision?: number } = {}): BlockGeometry {
  const frame = runtime.getSnapshot()
  const block = frame.blocks.find(candidate => blockKey(candidate) === key)!
  return {
    key: {
      blockKey: key,
      contentRevision: options.contentRevision ?? block.contentRevision,
      width: options.width ?? 80,
      styleRevision: options.styleRevision ?? "default",
      folded: options.folded ?? false,
    },
    nativeRevision: options.nativeRevision ?? 1,
    rows: 1,
    points: { 0: { graphemeOffset: 0, x: 0, y: 0, row: 0, column: 0 } },
    lines: [{ from: 0, to: 0, row: 0 }],
  }
}

function batch(runtime: TranscriptRuntime, measurements: readonly BlockGeometry[]): BlockMeasurementBatch {
  const frame = runtime.getSnapshot()
  return {
    threadId: runtime.getThreadId(),
    canonicalGeneration: 0,
    displayedCanonicalRevision: frame.displayedCanonicalRevision,
    basePresentationRevision: frame.presentationRevision,
    geometryGeneration: frame.geometry.generation,
    measurements,
  }
}

test("commits a current geometry batch atomically and rejects a mixed stale batch", () => {
  let source = fixture()
  const history = itemId("geometry-history")
  source = apply(source, { type: "item.started", threadId: thread, item: { id: history, turnId: turn, kind: "assistant", markdown: "history", status: "complete" } })
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const keys = runtime.getSnapshot().blocks.filter(block => block.key.kind === "item").map(blockKey)
  let notifications = 0
  runtime.subscribe(() => { notifications++ })
  const committed = runtime.reportMeasurements(batch(runtime, keys.map(key => measurement(runtime, key))))
  expect(notifications).toBe(1)
  expect(Object.keys(committed.geometry.byBlockKey)).toEqual(keys)
  expect(Object.isFrozen(committed.geometry.byBlockKey[keys[0]!]!.points)).toBe(true)

  const before = runtime.getSnapshot()
  const stale = measurement(runtime, keys[1]!, { contentRevision: 999, nativeRevision: 2 })
  const current = measurement(runtime, keys[0]!, { nativeRevision: 2 })
  expect(runtime.reportMeasurements(batch(runtime, [current, stale]))).toBe(before)
  expect(notifications).toBe(1)
})

test("geometry guards reject old presentation and layout generations", () => {
  const runtime = new TranscriptRuntime(input(fixture(), "follow"))
  const key = blockKey(runtime.getSnapshot().blocks.find(block => block.key.kind === "item")!)
  const oldBatch = batch(runtime, [measurement(runtime, key)])
  const reset = runtime.resetLayout("width")
  expect(runtime.reportMeasurements(oldBatch)).toBe(reset)
  const currentBatch = batch(runtime, [measurement(runtime, key, { width: 40 })])
  const committed = runtime.reportMeasurements(currentBatch)
  expect(committed.geometry.width).toBe(40)
  expect(runtime.reportMeasurements(currentBatch)).toBe(committed)
})

test("retains one complete geometry variant per block instead of accumulating large revisions", () => {
  const runtime = new TranscriptRuntime(input(fixture(), "follow"))
  const key = blockKey(runtime.getSnapshot().blocks.find(block => block.key.kind === "item")!)
  const large = (nativeRevision: number, count: number): BlockGeometry => ({
    ...measurement(runtime, key, { nativeRevision }),
    points: Object.fromEntries(Array.from({ length: count }, (_, offset) => [offset, {
      graphemeOffset: offset, x: offset, y: 0, row: 0, column: offset,
    }])),
    lines: [{ from: 0, to: count - 1, row: 0 }],
  })
  const first = runtime.reportMeasurements(batch(runtime, [large(1, 10_000)]))
  const prior = first.geometry.byBlockKey[key]
  const second = runtime.reportMeasurements(batch(runtime, [large(2, 12_000)]))
  expect(Object.keys(second.geometry.byBlockKey)).toEqual([key])
  expect(second.geometry.byBlockKey[key]).not.toBe(prior)
  expect(second.geometry.totalPoints).toBe(12_000)
})

test("tail geometry updates retain historical block-local identities", () => {
  let source = fixture()
  const history = itemId("measured-history")
  source = apply(source, { type: "item.started", threadId: thread, item: { id: history, turnId: turn, kind: "assistant", markdown: "settled", status: "complete" } })
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const keys = runtime.getSnapshot().blocks.filter(block => block.key.kind === "item").map(blockKey)
  runtime.reportMeasurements(batch(runtime, keys.map(key => measurement(runtime, key))))
  const historicalGeometry = runtime.getSnapshot().geometry.byBlockKey[`item:${history}:root`]
  source = apply(source, { type: "item.delta", threadId: thread, itemId: answer, delta: " tail" })
  runtime.update(input(source, "follow", { kind: "blocks", itemIds: [answer] }))
  expect(runtime.getSnapshot().geometry.byBlockKey[`item:${history}:root`]).toBe(historicalGeometry)
  expect(runtime.getSnapshot().geometry.byBlockKey[`item:${answer}:root`]).toBeUndefined()
  runtime.reportMeasurements(batch(runtime, [measurement(runtime, `item:${answer}:root`, { nativeRevision: 2 })]))
  expect(runtime.getSnapshot().geometry.byBlockKey[`item:${history}:root`]).toBe(historicalGeometry)
})

test("presentation-only navigation retains the exact geometry snapshot", () => {
  const source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const key = blockKey(runtime.getSnapshot().blocks.find(block => block.key.kind === "item")!)
  runtime.reportMeasurements(batch(runtime, [measurement(runtime, key)]))
  const measured = runtime.getSnapshot()
  const transcript = {
    ...source.transcript,
    cursor: { itemId: answer, graphemeOffset: 2 },
    viewport: { kind: "point" as const, point: { itemId: answer, graphemeOffset: 2 }, preferredScreenRow: 3 },
  }
  const moved = runtime.update({
    ...input({ ...source, transcript }, "follow"),
    presentationDamage: { kind: "view" },
  })
  expect(moved).not.toBe(measured)
  expect(moved.geometry).toBe(measured.geometry)
  expect(moved.geometry.byBlockKey[key]).toBe(measured.geometry.byBlockKey[key])
})

test("returns one cached immutable snapshot until selected frame data changes", () => {
  const source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const initial = runtime.getSnapshot()
  let notifications = 0
  runtime.subscribe(() => { notifications++ })
  expect(runtime.update(input(source, "follow"))).toBe(initial)
  expect(runtime.getSnapshot()).toBe(initial)
  expect(notifications).toBe(0)
  expect(Object.isFrozen(initial)).toBe(true)
  expect(Object.isFrozen(initial.blocks)).toBe(true)
  expect(Object.isFrozen(initial.window)).toBe(true)
})

test("follow reconciliation replaces a changed item and retains historical block identity", () => {
  let source = fixture()
  const history = itemId("history")
  source = apply(source, { type: "item.started", threadId: thread, item: { id: history, turnId: turn, kind: "reasoning", markdown: "settled", status: "complete" } })
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const before = runtime.getSnapshot()
  const answerBlock = before.blocks.find(block => block.key.kind === "item" && block.key.itemId === answer)
  const historyBlock = before.blocks.find(block => block.key.kind === "item" && block.key.itemId === history)
  source = apply(source, { type: "item.delta", threadId: thread, itemId: answer, delta: " world" })
  const after = runtime.update(input(source, "follow", { kind: "blocks", itemIds: [answer] }))
  expect(after).not.toBe(before)
  expect(after.transcript.order).toBe(before.transcript.order)
  expect(after.blocks.find(block => block.key.kind === "item" && block.key.itemId === answer)).not.toBe(answerBlock)
  expect(after.blocks.find(block => block.key.kind === "item" && block.key.itemId === history)).toBe(historyBlock)
  expect(after.transcript.projectionById[history]).toBe(before.transcript.projectionById[history])
})

test("block damage updates one growing item without rebuilding a large historical plan", () => {
  let source = fixture()
  for (let index = 0; index < 300; index++) {
    source = apply(source, { type: "item.started", threadId: thread, item: {
      id: itemId(`history-${index}`), turnId: turn, kind: "assistant", markdown: `settled ${index}`, status: "complete",
    } })
  }
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const before = runtime.getSnapshot()
  source = apply(source, { type: "item.delta", threadId: thread, itemId: answer, delta: " growing tail" })
  const after = runtime.update(input(source, "follow", { kind: "blocks", itemIds: [answer] }))

  expect(after.transcript.order).toBe(before.transcript.order)
  expect(after.blocks.filter((block, index) => block === before.blocks[index])).toHaveLength(before.blocks.length - 1)
  expect(after.transcript.projectionById[itemId("history-299")]).toBe(before.transcript.projectionById[itemId("history-299")])
})

test("detached tail streaming retains exact frame identity while canonical input advances", () => {
  let source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  runtime.update(input(source, "detached"))
  const detached = runtime.getSnapshot()
  let notifications = 0
  runtime.subscribe(() => { notifications++ })
  for (let index = 0; index < 100; index++) {
    source = apply(source, { type: "item.delta", threadId: thread, itemId: answer, delta: String(index % 10) })
    expect(runtime.update(input(source, "detached", { kind: "blocks", itemIds: [answer] }))).toBe(detached)
  }
  expect(runtime.getSnapshot()).toBe(detached)
  expect(runtime.getSnapshot().displayedCanonicalRevision).toBe(2)
  expect(notifications).toBe(0)
})

test("detachment atomically includes canonical events ordered before its boundary", () => {
  let source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  source = apply(source, { type: "item.delta", threadId: thread, itemId: answer, delta: " before detach" })
  const detached = runtime.update(input(source, "detached", { kind: "blocks", itemIds: [answer] }))
  const block = detached.blocks.find(block => block.key.kind === "item" && block.key.itemId === answer)
  expect(block && "projection" in block ? block.projection.source : undefined).toBe("hello before detach")
  expect(detached.displayedCanonicalRevision).toBe(source.revision)
})

test("detached presentation damage stays on pinned blocks and explicit missing targets reveal latest content", () => {
  let source = fixture()
  const runtime = new TranscriptRuntime(input(source, "detached"))
  const pinned = runtime.getSnapshot()
  source = apply(source, { type: "item.delta", threadId: thread, itemId: answer, delta: " hidden" })
  runtime.update(input(source, "detached", { kind: "blocks", itemIds: [answer] }))
  const layout = runtime.update({ ...input(source, "detached"), presentationDamage: { kind: "layout" } })
  expect(layout.blocks).toBe(pinned.blocks)
  expect(layout.displayedCanonicalRevision).toBe(pinned.displayedCanonicalRevision)
  expect(layout.damage.kind).toBe("layout")
  const revealed = runtime.update({
    ...input(source, "detached", { kind: "none" }, { itemId: answer, graphemeOffset: source.transcript.projectionById[answer]!.sourceSpans.length }),
    presentationDamage: { kind: "layout" },
  })
  expect(revealed.displayedCanonicalRevision).toBe(source.revision)
  expect(revealed.blocks).not.toBe(pinned.blocks)
  expect(revealed.mode).toBe("detached")
  expect(revealed.damage.kind).toBe("layout")
})

test("detached reveal distinguishes retained points from hidden append boundaries and rewrites", () => {
  const appendCase = (offset: (before: Source, after: Source) => number) => {
    const before = fixture()
    const runtime = new TranscriptRuntime(input(before, "detached"), { windowPolicy: { viewportRows: 2, overscanRows: 2 } })
    const pinned = runtime.getSnapshot()
    const after = apply(before, { type: "item.delta", threadId: thread, itemId: answer, delta: " hidden" })
    expect(runtime.update(input(after, "detached", { kind: "blocks", itemIds: [answer] }))).toBe(pinned)
    const revealed = runtime.update(input(after, "detached", { kind: "none" }, { itemId: answer, graphemeOffset: offset(before, after) }))
    runtime.dispose()
    return { before, after, pinned, revealed }
  }

  const retained = appendCase(() => 0)
  expect(retained.revealed.blocks).toBe(retained.pinned.blocks)
  expect(retained.revealed.displayedCanonicalRevision).toBe(retained.before.revision)

  const firstAppended = appendCase(before => before.transcript.projectionById[answer]!.sourceSpans.length)
  expect(firstAppended.revealed.displayedCanonicalRevision).toBe(firstAppended.after.revision)
  expect(firstAppended.revealed.blocks).not.toBe(firstAppended.pinned.blocks)

  const newEnd = appendCase((_before, after) => after.transcript.projectionById[answer]!.sourceSpans.length)
  expect(newEnd.revealed.displayedCanonicalRevision).toBe(newEnd.after.revision)
  expect(newEnd.revealed.blocks).not.toBe(newEnd.pinned.blocks)

  const before = fixture()
  const rewrittenRuntime = new TranscriptRuntime(input(before, "detached"), { windowPolicy: { viewportRows: 2, overscanRows: 2 } })
  const rewrittenPinned = rewrittenRuntime.getSnapshot()
  const rewritten = apply(before, { type: "item.completed", threadId: thread, item: {
    id: answer, turnId: turn, kind: "assistant", markdown: "jello", status: "complete",
  } })
  expect(rewrittenRuntime.update(input(rewritten, "detached", { kind: "blocks", itemIds: [answer] }))).toBe(rewrittenPinned)
  const revealedRewrite = rewrittenRuntime.update(input(rewritten, "detached", { kind: "none" }, { itemId: answer, graphemeOffset: 0 }))
  expect(revealedRewrite.displayedCanonicalRevision).toBe(rewritten.revision)
  expect(revealedRewrite.blocks).not.toBe(rewrittenPinned.blocks)
  rewrittenRuntime.dispose()
})

test("explicit targets in new items materialize and activity remains source-less", () => {
  let source = fixture()
  const runtime = new TranscriptRuntime(input(source, "detached"))
  const next = itemId("next")
  source = apply(source, { type: "item.started", threadId: thread, item: { id: next, turnId: turn, kind: "assistant", markdown: "new", status: "complete" } })
  runtime.update(input(source, "detached", { kind: "blocks", itemIds: [next] }))
  const revealed = runtime.update(input(source, "detached", { kind: "none" }, { itemId: next, graphemeOffset: 0 }))
  expect(revealed.blocks.some(block => block.key.kind === "item" && block.key.itemId === next)).toBe(true)
  source = apply(source, { type: "turn.completed", threadId: thread, turnId: turn, outcome: "complete", durationMs: 500 })
  const followed = runtime.update(input(source, "follow", { kind: "view" }))
  const activity = followed.blocks.find(block => block.key.kind === "turn-activity")
  expect(activity?.sourceSpan).toBeUndefined()
})

test("invalid reveals stay frozen and visible semantic changes map onto retained projections", () => {
  const source = fixture()
  const runtime = new TranscriptRuntime(input(source, "detached"))
  const pinned = runtime.getSnapshot()
  const invalid = runtime.update({ ...input(source, "detached"), reveal: { id: ++revealId, point: { itemId: itemId("missing"), graphemeOffset: 0 }, reason: "search" } })
  expect(invalid).toBe(pinned)
  const transcript = { ...source.transcript, cursor: { itemId: answer, graphemeOffset: 2 }, viewport: { kind: "point" as const, point: { itemId: answer, graphemeOffset: 2 }, preferredScreenRow: 4 } }
  const moved = runtime.update({
    ...input({ ...source, transcript }, "detached", { kind: "none" }, { itemId: answer, graphemeOffset: 2 }),
    presentationDamage: { kind: "layout" },
  })
  expect(moved.transcript.cursor).toEqual({ itemId: answer, graphemeOffset: 2 })
  expect(moved.blocks).toBe(pinned.blocks)
  expect(moved.damage.kind).toBe("layout")
})

test("same-source completion replaces renderer metadata despite an unchanged projection revision", () => {
  let source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const before = runtime.getSnapshot().blocks.find(block => block.key.kind === "item" && block.key.itemId === answer)
  source = apply(source, { type: "item.completed", threadId: thread, item: { id: answer, turnId: turn, kind: "assistant", markdown: "hello", status: "complete", durationMs: 20 } })
  const after = runtime.update(input(source, "follow", { kind: "blocks", itemIds: [answer] }))
  const completed = after.blocks.find(block => block.key.kind === "item" && block.key.itemId === answer)
  expect(completed).not.toBe(before)
  expect(completed && "item" in completed ? completed.item : undefined).toMatchObject({ status: "complete", durationMs: 20 })
})

test("reattachment adopts the newest canonical revision once and equals a fresh build", () => {
  let source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  runtime.update(input(source, "detached"))
  for (const delta of [" one", " two", " three"]) {
    source = apply(source, { type: "item.delta", threadId: thread, itemId: answer, delta })
    runtime.update(input(source, "detached", { kind: "blocks", itemIds: [answer] }))
  }
  let notifications = 0
  runtime.subscribe(() => { notifications++ })
  const attached = runtime.update(input(source, "follow"))
  expect(notifications).toBe(1)
  expect(attached.displayedCanonicalRevision).toBe(source.revision)
  expect(semanticFrame(attached)).toEqual(semanticFrame(new TranscriptRuntime(input(source, "follow")).getSnapshot()))
  expect(runtime.update(input(source, "follow"))).toBe(attached)
  expect(notifications).toBe(1)
})

test("two presentations over one source retain independent attachment and revisions", () => {
  let source = fixture()
  const following = new TranscriptRuntime(input(source, "follow"))
  const detached = new TranscriptRuntime(input(source, "detached"))
  const pinned = detached.getSnapshot()
  source = apply(source, { type: "item.delta", threadId: thread, itemId: answer, delta: " change" })
  following.update(input(source, "follow", { kind: "blocks", itemIds: [answer] }))
  detached.update(input(source, "detached", { kind: "blocks", itemIds: [answer] }))
  expect(following.getSnapshot().displayedCanonicalRevision).toBe(source.revision)
  expect(detached.getSnapshot()).toBe(pinned)
})

test("listener faults are isolated and reentrant updates settle after publication", () => {
  let source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const first = apply(source, { type: "item.delta", threadId: thread, itemId: answer, delta: " one" })
  const second = apply(first, { type: "item.delta", threadId: thread, itemId: answer, delta: " two" })
  let healthyCalls = 0
  runtime.subscribe(() => { throw new Error("renderer failed") })
  runtime.subscribe(() => {
    healthyCalls++
    if (healthyCalls === 1) runtime.update(input(second, "follow", { kind: "blocks", itemIds: [answer] }))
  })
  const settled = runtime.update(input(first, "follow", { kind: "blocks", itemIds: [answer] }))
  expect(healthyCalls).toBe(2)
  expect(settled.displayedCanonicalRevision).toBe(second.revision)
  expect(runtime.getSnapshot()).toBe(settled)
})

test("reentrant listeners drain every queued input and cannot overwrite a newer revision", () => {
  const source = fixture()
  const first = apply(source, { type: "item.delta", threadId: thread, itemId: answer, delta: " one" })
  const older = apply(first, { type: "item.delta", threadId: thread, itemId: answer, delta: " older" })
  const newer = apply(older, { type: "item.delta", threadId: thread, itemId: answer, delta: " newest" })
  const runtime = new TranscriptRuntime(input(source, "follow"))
  let queued = false
  runtime.subscribe(() => {
    if (queued) return
    queued = true
    runtime.update(input(newer, "follow", { kind: "blocks", itemIds: [answer] }))
  })
  runtime.subscribe(() => {
    if (runtime.getSnapshot().displayedCanonicalRevision === first.revision) {
      runtime.update(input(older, "follow", { kind: "blocks", itemIds: [answer] }))
    }
  })
  const settled = runtime.update(input(first, "follow", { kind: "blocks", itemIds: [answer] }))
  expect(settled.displayedCanonicalRevision).toBe(newer.revision)
  expect(settled.transcript.projectionById[answer]?.source).toBe("hello one older newest")
})

test("same-revision divergent canonical input takes the guarded full-rebuild fallback", () => {
  const source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const corrected = apply(source, { type: "item.delta", threadId: thread, itemId: answer, delta: " corrected" })
  const rebuilt = runtime.update({ ...input(corrected, "follow", { kind: "blocks", itemIds: [answer] }), canonicalRevision: source.revision })
  expect(rebuilt.damage.kind).toBe("full")
  expect(rebuilt.displayedCanonicalRevision).toBe(source.revision)
  expect(rebuilt.transcript.projectionById[answer]?.source).toBe("hello corrected")
})

test("forward revision gaps accept summarized damage while stale input is ignored and new lineage rebuilds", () => {
  const source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const jumped = { ...source, revision: source.revision + 10 }
  const frame = runtime.update(input(jumped, "follow", { kind: "blocks", itemIds: [answer] }))
  expect(frame.damage.kind).toBe("blocks")
  expect(frame.displayedCanonicalRevision).toBe(jumped.revision)
  expect(runtime.update(input(source, "follow"))).toBe(frame)
  const reset = runtime.update({ ...input(source, "follow"), canonicalGeneration: 1 })
  expect(reset.damage.kind).toBe("full")
  expect(reset.displayedCanonicalRevision).toBe(source.revision)
  expect(reset.blocks[0]).not.toBe(frame.blocks[0])
  const otherThread = threadId("other-thread")
  const switched = runtime.update({ ...input(source, "follow"), threadId: otherThread, canonicalGeneration: 1 })
  expect(switched.damage.kind).toBe("full")
  expect(runtime.getThreadId()).toBe(otherThread)
  expect(switched.blocks[0]).not.toBe(reset.blocks[0])
})
