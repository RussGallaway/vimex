import { expect, test } from "bun:test"
import {
  createConversation,
  itemId,
  reduceConversation,
  threadId,
  turnId,
  type ConversationEvent,
  type ItemId,
} from "@vimex/conversation"
import { syncTranscriptItem } from "./application/project-conversation"
import { attachTail } from "./application/transcript-operations"
import {
  appendTranscriptOrder,
  appendTranscriptUnseenItemId,
  initialTranscript,
  persistentTranscriptUnseenItemIds,
  setTranscriptFoldValue,
  setTranscriptProjection,
  type TranscriptState,
} from "./domain/transcript-document"
import {
  createTranscriptFrame,
  TranscriptRuntime,
  type TranscriptDamage,
  type TranscriptRuntimeDiagnostics,
  type TranscriptRuntimeInput,
} from "./runtime"
import { blockKey, pointIsMaterialized } from "./window"
import type { BlockGeometry, BlockMeasurementBatch } from "./geometry"

interface Source {
  conversation: ReturnType<typeof createConversation>
  transcript: TranscriptState
  revision: number
}

const thread = threadId("thread"),
  turn = turnId("turn"),
  answer = itemId("answer")

function apply(source: Source, event: ConversationEvent): Source {
  const conversation = reduceConversation(source.conversation, event)
  let transcript = source.transcript
  const changed =
    event.type === "item.delta"
      ? event.itemId
      : event.type === "item.started" || event.type === "item.completed"
        ? event.item.id
        : undefined
  if (changed && conversation.items[changed])
    transcript = syncTranscriptItem(transcript, conversation.items[changed]!)
  return {
    conversation,
    transcript,
    revision: source.revision + (conversation === source.conversation ? 0 : 1),
  }
}

function fixture(): Source {
  let source: Source = {
    conversation: createConversation(thread),
    transcript: initialTranscript(),
    revision: 0,
  }
  source = apply(source, {
    type: "turn.started",
    threadId: thread,
    turnId: turn,
  })
  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: answer,
      turnId: turn,
      kind: "assistant",
      markdown: "hello",
      status: "running",
    },
  })
  return source
}

let revealId = 0
function input(
  source: Source,
  mode: "follow" | "detached",
  canonicalDamage: TranscriptDamage = { kind: "none" },
  reveal?: { itemId: ItemId; graphemeOffset: number },
): TranscriptRuntimeInput {
  return {
    threadId: thread,
    canonicalGeneration: 0,
    canonicalRevision: source.revision,
    conversation: source.conversation,
    transcript: source.transcript,
    mode,
    canonicalDamage,
    reveal: reveal && { id: ++revealId, point: reveal, reason: "jump" },
  }
}

function semanticFrame(frame: ReturnType<TranscriptRuntime["getSnapshot"]>) {
  return {
    displayedCanonicalRevision: frame.displayedCanonicalRevision,
    mode: frame.mode,
    keys: frame.blocks.map(blockKey),
    blocks: frame.blocks.map((block) =>
      "projection" in block
        ? {
            key: blockKey(block),
            item: block.item,
            source: block.projection.source,
            sourceSpan: block.sourceSpan,
          }
        : {
            key: blockKey(block),
            turn: block.turn,
            sourceSpan: block.sourceSpan,
          },
    ),
    window: {
      topSpacerRows: frame.window.topSpacerRows,
      bottomSpacerRows: frame.window.bottomSpacerRows,
      overscanRows: frame.window.overscanRows,
    },
  }
}

function measurement(
  runtime: TranscriptRuntime,
  key: string,
  options: Partial<BlockGeometry["key"]> & { nativeRevision?: number } = {},
): BlockGeometry {
  const frame = runtime.getSnapshot()
  const block = frame.blocks.find((candidate) => blockKey(candidate) === key)!
  return {
    key: {
      blockKey: key,
      contentRevision: options.contentRevision ?? block.contentRevision,
      width: options.width ?? 80,
      styleRevision: options.styleRevision ?? "default",
      folded: options.folded ?? false,
      ...(options.presentation && options.presentation !== "item"
        ? { presentation: options.presentation }
        : {}),
    },
    nativeRevision: options.nativeRevision ?? 1,
    rows: 1,
    points: { 0: { graphemeOffset: 0, x: 0, y: 0, row: 0, column: 0 } },
    lines: [{ from: 0, to: 0, row: 0 }],
  }
}

function batch(
  runtime: TranscriptRuntime,
  measurements: readonly BlockGeometry[],
): BlockMeasurementBatch {
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

function runtimeDiagnostics(): TranscriptRuntimeDiagnostics {
  return {
    completePlanBuilds: 0,
    completePlanBlockVisits: 0,
    orderIndexBuilds: 0,
    orderIndexItemVisits: 0,
    orderIndexCacheHits: 0,
    textLengthIndexBuilds: 0,
    textLengthItemVisits: 0,
    textLengthIndexCacheHits: 0,
    textLengthIndexUpdates: 0,
    textLengthNodeVisits: 0,
    urlIndexBuilds: 0,
    urlIndexItemVisits: 0,
    urlIndexCacheHits: 0,
    urlIndexUpdates: 0,
    urlIndexNodeVisits: 0,
    projectionRecordUpdates: 0,
    projectionRecordNodeVisits: 0,
    projectionRecordNodesCopied: 0,
    blockPlanUpdates: 0,
    blockPlanNodeVisits: 0,
    blockPlanNodesCopied: 0,
    heightIndexBuilds: 0,
    heightIndexBlockVisits: 0,
    heightIndexUpdates: 0,
    heightIndexNodeVisits: 0,
    heightIndexNodesCopied: 0,
    completeGeometryBlockVisits: 0,
    windowGeometryBlockVisits: 0,
    blockPlanWindowSliceItems: 0,
    changedItemBuilds: 0,
    hiddenDamageMerges: 0,
    hiddenDamageInputItemVisits: 0,
    hiddenDamageItemAdditions: 0,
    hiddenDamageSnapshots: 0,
    hiddenDamageSnapshotItemVisits: 0,
  }
}

test("windowed activity batches keep complete membership and bounded roots through reveal and follow", () => {
  for (const count of [10, 1_000]) {
    let source = fixture()
    source = {
      ...source,
      transcript: {
        ...source.transcript,
        foldDefaults: { reasoning: false, tools: true },
      },
    }
    const ids = Array.from({ length: count }, (_, index) =>
      itemId(`batch-child-${index}`),
    )
    for (const id of ids)
      source = apply(source, {
        type: "item.started",
        threadId: thread,
        item: {
          id,
          turnId: turn,
          kind: "tool",
          title: "Read",
          detail: "file contents",
          status: "complete",
          activity: { family: "read" },
        },
      })
    const runtime = new TranscriptRuntime(input(source, "follow"), {
      windowPolicy: { viewportRows: 4, overscanRows: 4 },
    })
    const initial = runtime.getSnapshot()
    expect(initial.window.activityBatches[0]?.itemIds).toEqual(ids)
    expect(initial.window.blocks.map(blockKey)).toEqual([
      `item:${answer}:root`,
      `item:${ids[0]}:root`,
    ])
    expect(initial.geometry.totalRows).toBe(3)
    const lead = measurement(runtime, `item:${ids[0]}:root`, {
      folded: true,
      presentation: "activity-lead",
    })
    const measured = runtime.reportMeasurements(
      batch(runtime, [{ ...lead, rows: 2 }]),
    )
    expect(measured).not.toBe(initial)
    expect(measured.window.activityBatches[0]).toBe(
      initial.window.activityBatches[0],
    )
    expect(measured.window.blocks.length).toBeLessThanOrEqual(8)

    const point = { itemId: ids[Math.floor(count / 2)]!, graphemeOffset: 3 }
    source = {
      ...source,
      transcript: {
        ...source.transcript,
        cursor: point,
        viewport: { kind: "point", point, preferredScreenRow: 1 },
      },
    }
    const revealed = runtime.update({
      ...input(source, "detached", { kind: "none" }, point),
      presentationDamage: { kind: "view" },
    })
    expect(pointIsMaterialized(revealed.window.blocks, point)).toBe(true)
    expect(
      revealed.window.activityPresentation[`item:${point.itemId}:root`],
    ).toBeUndefined()
    expect(revealed.window.blocks.length).toBeLessThanOrEqual(12)
    expect(revealed.geometry.totalRows).toBe(count + 1)

    source = {
      ...source,
      transcript: {
        ...source.transcript,
        cursor: { itemId: answer, graphemeOffset: 0 },
        viewport: { kind: "tail" },
      },
    }
    const followed = runtime.update({
      ...input(source, "follow"),
      presentationDamage: { kind: "view" },
    })
    expect(followed.window.blocks.map(blockKey)).toEqual(
      initial.window.blocks.map(blockKey),
    )
    expect(followed.geometry.totalRows).toBe(3)
    expect(followed.window.activityBatches[0]?.itemIds).toEqual(ids)
    expect(followed.transcript.order).toHaveLength(count + 1)
    runtime.dispose()
  }
})

test("commits a current geometry batch atomically and rejects a mixed stale batch", () => {
  let source = fixture()
  const history = itemId("geometry-history")
  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: history,
      turnId: turn,
      kind: "assistant",
      markdown: "history",
      status: "complete",
    },
  })
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const keys = runtime
    .getSnapshot()
    .blocks.filter((block) => block.key.kind === "item")
    .map(blockKey)
  let notifications = 0
  runtime.subscribe(() => {
    notifications++
  })
  const committed = runtime.reportMeasurements(
    batch(
      runtime,
      keys.map((key) => measurement(runtime, key)),
    ),
  )
  expect(notifications).toBe(1)
  expect(Object.keys(committed.geometry.byBlockKey)).toEqual(keys)
  expect(Object.isFrozen(committed.geometry.byBlockKey[keys[0]!]!.points)).toBe(
    true,
  )

  const before = runtime.getSnapshot()
  const stale = measurement(runtime, keys[1]!, {
    contentRevision: 999,
    nativeRevision: 2,
  })
  const current = measurement(runtime, keys[0]!, { nativeRevision: 2 })
  expect(runtime.reportMeasurements(batch(runtime, [current, stale]))).toBe(
    before,
  )
  expect(notifications).toBe(1)
})

test("geometry guards reject old presentation and layout generations", () => {
  const runtime = new TranscriptRuntime(input(fixture(), "follow"))
  const key = blockKey(
    runtime.getSnapshot().blocks.find((block) => block.key.kind === "item")!,
  )
  const oldBatch = batch(runtime, [measurement(runtime, key)])
  const reset = runtime.resetLayout("width")
  expect(runtime.reportMeasurements(oldBatch)).toBe(reset)
  const currentBatch = batch(runtime, [
    measurement(runtime, key, { width: 40 }),
  ])
  const committed = runtime.reportMeasurements(currentBatch)
  expect(committed.geometry.width).toBe(40)
  expect(runtime.reportMeasurements(currentBatch)).toBe(committed)
})

test("retains one complete geometry variant per block instead of accumulating large revisions", () => {
  const runtime = new TranscriptRuntime(input(fixture(), "follow"))
  const key = blockKey(
    runtime.getSnapshot().blocks.find((block) => block.key.kind === "item")!,
  )
  const large = (nativeRevision: number, count: number): BlockGeometry => ({
    ...measurement(runtime, key, { nativeRevision }),
    points: Object.fromEntries(
      Array.from({ length: count }, (_, offset) => [
        offset,
        {
          graphemeOffset: offset,
          x: offset,
          y: 0,
          row: 0,
          column: offset,
        },
      ]),
    ),
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
  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: history,
      turnId: turn,
      kind: "assistant",
      markdown: "settled",
      status: "complete",
    },
  })
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const keys = runtime
    .getSnapshot()
    .blocks.filter((block) => block.key.kind === "item")
    .map(blockKey)
  runtime.reportMeasurements(
    batch(
      runtime,
      keys.map((key) => measurement(runtime, key)),
    ),
  )
  const historicalGeometry =
    runtime.getSnapshot().geometry.byBlockKey[`item:${history}:root`]
  source = apply(source, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " tail",
  })
  runtime.update(input(source, "follow", { kind: "blocks", itemIds: [answer] }))
  expect(
    runtime.getSnapshot().geometry.byBlockKey[`item:${history}:root`],
  ).toBe(historicalGeometry)
  expect(
    runtime.getSnapshot().geometry.byBlockKey[`item:${answer}:root`],
  ).toBeUndefined()
  runtime.reportMeasurements(
    batch(runtime, [
      measurement(runtime, `item:${answer}:root`, { nativeRevision: 2 }),
    ]),
  )
  expect(
    runtime.getSnapshot().geometry.byBlockKey[`item:${history}:root`],
  ).toBe(historicalGeometry)
})

test("presentation-only navigation retains the exact geometry snapshot", () => {
  const source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const key = blockKey(
    runtime.getSnapshot().blocks.find((block) => block.key.kind === "item")!,
  )
  runtime.reportMeasurements(batch(runtime, [measurement(runtime, key)]))
  const measured = runtime.getSnapshot()
  const transcript = {
    ...source.transcript,
    cursor: { itemId: answer, graphemeOffset: 2 },
    viewport: {
      kind: "point" as const,
      point: { itemId: answer, graphemeOffset: 2 },
      preferredScreenRow: 3,
    },
  }
  const moved = runtime.update({
    ...input({ ...source, transcript }, "follow"),
    presentationDamage: { kind: "view" },
  })
  expect(moved).not.toBe(measured)
  expect(moved.geometry).toBe(measured.geometry)
  expect(moved.geometry.byBlockKey[key]).toBe(measured.geometry.byBlockKey[key])
})

test("activity batching changes disposable rows without replacing semantic items", () => {
  let source = fixture()
  const first = itemId("web-first"),
    second = itemId("web-second")
  for (const id of [first, second])
    source = apply(source, {
      type: "item.started",
      threadId: thread,
      item: {
        id,
        turnId: turn,
        kind: "tool",
        title: "Web search",
        detail: `result ${id}`,
        activity: { family: "web-research" },
        status: "complete",
      },
    })
  source = {
    ...source,
    transcript: {
      ...source.transcript,
      folded: { [first]: true, [second]: true },
    },
  }
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const compact = runtime.getSnapshot()
  expect(compact.window.activityBatches).toHaveLength(1)
  expect(compact.transcript.order).toContain(first)
  expect(compact.transcript.order).toContain(second)
  expect(
    compact.geometry.blockRows.find((row) => row.itemId === second)?.rows,
  ).toBe(0)

  source = {
    ...source,
    transcript: {
      ...source.transcript,
      folded: { ...source.transcript.folded, [first]: false },
    },
  }
  const expanded = runtime.update({
    ...input(source, "follow"),
    presentationDamage: { kind: "layout" },
  })
  expect(expanded.transcript.order).toEqual(compact.transcript.order)
  expect(
    expanded.geometry.blockRows.find((row) => row.itemId === first)?.rows,
  ).toBe(1)
  expect(
    expanded.geometry.blockRows.find((row) => row.itemId === second)?.rows,
  ).toBe(1)
})

test("incremental completion forms an activity batch immediately and damages every changed presentation", () => {
  let source = fixture()
  const first = itemId("settling-web-first"),
    second = itemId("settling-web-second")
  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: first,
      turnId: turn,
      kind: "tool",
      title: "Web search",
      detail: "first",
      activity: { family: "web-research" },
      status: "complete",
      durationMs: 100,
    },
  })
  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: second,
      turnId: turn,
      kind: "tool",
      title: "Web search",
      detail: "second",
      activity: { family: "web-research" },
      status: "running",
    },
  })
  source = {
    ...source,
    transcript: {
      ...source.transcript,
      folded: { [first]: true, [second]: true },
    },
  }
  const runtime = new TranscriptRuntime(input(source, "follow"))
  expect(runtime.getSnapshot().window.activityBatches).toHaveLength(0)

  source = apply(source, {
    type: "item.completed",
    threadId: thread,
    item: {
      id: second,
      turnId: turn,
      kind: "tool",
      title: "Web search",
      detail: "second",
      activity: { family: "web-research" },
      status: "complete",
      durationMs: 200,
    },
  })
  const settled = runtime.update(
    input(source, "follow", { kind: "blocks", itemIds: [second] }),
  )
  expect(settled.window.activityBatches).toEqual([
    expect.objectContaining({ itemIds: [first, second], durationMs: 300 }),
  ])
  expect(settled.window.activityPresentation[`item:${first}:root`]?.kind).toBe(
    "activity-lead",
  )
  expect(settled.window.activityPresentation[`item:${second}:root`]?.kind).toBe(
    "activity-hidden",
  )
  expect(
    settled.geometry.blockRows.find((row) => row.itemId === second)?.rows,
  ).toBe(0)
  expect(settled.damage).toEqual({ kind: "blocks", itemIds: [second, first] })
})

test("late authoritative provider completion refreshes aggregate duration", () => {
  let source = fixture()
  const first = itemId("late-linear-first"),
    second = itemId("late-linear-second")
  for (const id of [first, second])
    source = apply(source, {
      type: "item.started",
      threadId: thread,
      item: {
        id,
        turnId: turn,
        kind: "tool",
        title: "codex_apps · linear.read",
        detail: String(id),
        activity: { family: "provider", label: "Linear" },
        status: "running",
      },
    })
  source = apply(source, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "complete",
  })
  source = {
    ...source,
    transcript: {
      ...source.transcript,
      folded: { [first]: true, [second]: true },
    },
  }
  const runtime = new TranscriptRuntime(input(source, "follow"))
  expect(
    runtime.getSnapshot().window.activityBatches[0]?.durationMs,
  ).toBeUndefined()

  source = apply(source, {
    type: "item.completed",
    threadId: thread,
    item: {
      id: first,
      turnId: turn,
      kind: "tool",
      title: "codex_apps · linear.read",
      detail: "first",
      activity: { family: "provider", label: "Linear" },
      status: "complete",
      durationMs: 125,
    },
  })
  runtime.update(input(source, "follow", { kind: "blocks", itemIds: [first] }))
  source = apply(source, {
    type: "item.completed",
    threadId: thread,
    item: {
      id: second,
      turnId: turn,
      kind: "tool",
      title: "codex_apps · linear.read",
      detail: "second",
      activity: { family: "provider", label: "Linear" },
      status: "complete",
      durationMs: 375,
    },
  })
  const refreshed = runtime.update(
    input(source, "follow", { kind: "blocks", itemIds: [second] }),
  )
  expect(refreshed.window.activityBatches[0]?.durationMs).toBe(500)
})

test("batch-aware navigation preserves geometry unless a protected child changes presentation", () => {
  let source = fixture()
  const first = itemId("nav-web-first"),
    second = itemId("nav-web-second")
  for (const id of [first, second])
    source = apply(source, {
      type: "item.started",
      threadId: thread,
      item: {
        id,
        turnId: turn,
        kind: "tool",
        title: "Web search",
        detail: String(id),
        activity: { family: "web-research" },
        status: "complete",
      },
    })
  source = {
    ...source,
    transcript: {
      ...source.transcript,
      folded: { [first]: true, [second]: true },
    },
  }
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const compact = runtime.getSnapshot()

  let transcript = {
    ...source.transcript,
    cursor: { itemId: answer, graphemeOffset: 1 },
  }
  const outside = runtime.update({
    ...input({ ...source, transcript }, "follow"),
    presentationDamage: { kind: "view" },
  })
  expect(outside.geometry).toBe(compact.geometry)
  expect(outside.window).toBe(compact.window)

  transcript = { ...transcript, cursor: { itemId: second, graphemeOffset: 0 } }
  const revealed = runtime.update({
    ...input({ ...source, transcript }, "follow"),
    presentationDamage: { kind: "view" },
  })
  expect(revealed.window.activityPresentation).toEqual({})
  expect(revealed.geometry).not.toBe(outside.geometry)
  expect(revealed.damage).toEqual({ kind: "blocks", itemIds: [first, second] })
  expect(
    revealed.geometry.blockRows.find((row) => row.itemId === second)?.rows,
  ).toBe(1)
})

test("detached old-frame measurement cannot adopt hidden protection state", () => {
  let source = fixture()
  const first = itemId("detached-web-first"),
    second = itemId("detached-web-second")
  for (const id of [first, second])
    source = apply(source, {
      type: "item.started",
      threadId: thread,
      item: {
        id,
        turnId: turn,
        kind: "tool",
        title: "Web search",
        detail: String(id),
        activity: { family: "web-research" },
        status: "complete",
      },
    })
  source = {
    ...source,
    transcript: {
      ...source.transcript,
      folded: { [first]: true, [second]: true },
    },
  }
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const detached = runtime.update(input(source, "detached"))

  source = apply(source, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " hidden",
  })
  const hiddenTranscript = {
    ...source.transcript,
    cursor: { itemId: second, graphemeOffset: 0 },
  }
  const hiddenInput = input(
    { ...source, transcript: hiddenTranscript },
    "detached",
    { kind: "blocks", itemIds: [answer] },
  )
  expect(runtime.update(hiddenInput)).toBe(detached)
  const measured = runtime.reportMeasurements(
    batch(runtime, [
      measurement(runtime, `item:${first}:root`, {
        folded: true,
        presentation: "activity-lead",
      }),
    ]),
  )
  expect(measured).not.toBe(detached)

  const revealed = runtime.update({
    ...hiddenInput,
    presentationDamage: { kind: "view" },
  })
  expect(revealed.window.activityPresentation).toEqual({})
  expect(revealed.damage).toEqual({ kind: "blocks", itemIds: [first, second] })
})

test("a newly appended batch retains historical batch identity and damages only the new run", () => {
  let source = fixture()
  const old = [itemId("old-web-first"), itemId("old-web-second")]
  for (const id of old)
    source = apply(source, {
      type: "item.started",
      threadId: thread,
      item: {
        id,
        turnId: turn,
        kind: "tool",
        title: "Web search",
        detail: String(id),
        activity: { family: "web-research" },
        status: "complete",
      },
    })
  const separator = itemId("batch-separator")
  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: separator,
      turnId: turn,
      kind: "assistant",
      markdown: "progress",
      status: "complete",
    },
  })
  const first = itemId("new-web-first"),
    second = itemId("new-web-second")
  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: first,
      turnId: turn,
      kind: "tool",
      title: "Web search",
      detail: "first",
      activity: { family: "web-research" },
      status: "complete",
    },
  })
  source = {
    ...source,
    transcript: {
      ...source.transcript,
      folded: {
        ...Object.fromEntries(old.map((id) => [id, true])),
        [first]: true,
        [second]: true,
      },
    },
  }
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const historical = runtime.getSnapshot().window.activityBatches[0]!
  const historicalPresentation =
    runtime.getSnapshot().window.activityPresentation[`item:${old[0]}:root`]
  runtime.reportMeasurements(
    batch(runtime, [
      measurement(runtime, `item:${old[0]}:root`, {
        folded: true,
        presentation: "activity-lead",
      }),
    ]),
  )
  const historicalGeometry =
    runtime.getSnapshot().geometry.byBlockKey[`item:${old[0]}:root`]

  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: second,
      turnId: turn,
      kind: "tool",
      title: "Web search",
      detail: "second",
      activity: { family: "web-research" },
      status: "complete",
    },
  })
  const appended = runtime.update(
    input(source, "follow", { kind: "blocks", itemIds: [second] }),
  )
  expect(appended.window.activityBatches).toHaveLength(2)
  expect(appended.window.activityBatches[0]).toBe(historical)
  expect(appended.window.activityPresentation[`item:${old[0]}:root`]).toBe(
    historicalPresentation,
  )
  expect(appended.geometry.byBlockKey[`item:${old[0]}:root`]).toBe(
    historicalGeometry,
  )
  expect(appended.damage).toEqual({ kind: "blocks", itemIds: [second, first] })
  expect(appended.window.activityPresentation[`item:${first}:root`]?.kind).toBe(
    "activity-lead",
  )
  expect(
    appended.window.activityPresentation[`item:${second}:root`]?.kind,
  ).toBe("activity-hidden")
})

test("extending a compact run does not remeasure unchanged lead or hidden geometry", () => {
  let source = fixture()
  const ids = [
    itemId("extend-web-first"),
    itemId("extend-web-second"),
    itemId("extend-web-third"),
  ]
  for (const id of ids.slice(0, 2))
    source = apply(source, {
      type: "item.started",
      threadId: thread,
      item: {
        id,
        turnId: turn,
        kind: "tool",
        title: "Web search",
        detail: String(id),
        activity: { family: "web-research" },
        status: "complete",
      },
    })
  source = {
    ...source,
    transcript: {
      ...source.transcript,
      folded: Object.fromEntries(ids.map((id) => [id, true])),
    },
  }
  const runtime = new TranscriptRuntime(input(source, "follow"))
  runtime.reportMeasurements(
    batch(runtime, [
      measurement(runtime, `item:${ids[0]}:root`, {
        folded: true,
        presentation: "activity-lead",
      }),
    ]),
  )
  const leadGeometry =
    runtime.getSnapshot().geometry.byBlockKey[`item:${ids[0]}:root`]

  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: ids[2]!,
      turnId: turn,
      kind: "tool",
      title: "Web search",
      detail: String(ids[2]),
      activity: { family: "web-research" },
      status: "complete",
    },
  })
  const extended = runtime.update(
    input(source, "follow", { kind: "blocks", itemIds: [ids[2]!] }),
  )
  expect(extended.window.activityBatches[0]?.countLabel).toBe("3 searches")
  expect(extended.damage).toEqual({ kind: "blocks", itemIds: [ids[2]!] })
  expect(extended.geometry.byBlockKey[`item:${ids[0]}:root`]).toBe(leadGeometry)
})

test("returns one cached immutable snapshot until selected frame data changes", () => {
  const source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const initial = runtime.getSnapshot()
  let notifications = 0
  runtime.subscribe(() => {
    notifications++
  })
  expect(runtime.update(input(source, "follow"))).toBe(initial)
  expect(runtime.getSnapshot()).toBe(initial)
  expect(notifications).toBe(0)
  expect(Object.isFrozen(initial)).toBe(true)
  expect(Object.isFrozen(initial.blocks)).toBe(true)
  expect(Reflect.set(initial.blocks, "0", initial.blocks.at(-1))).toBe(false)
  expect(initial.blocks[0]).toBe(initial.window.blocks[0])
  expect(Object.isFrozen(initial.window)).toBe(true)
})

test("the frozen dense pass-through reference stays distinct from the windowed persistent plan", () => {
  const source = fixture()
  const reference = createTranscriptFrame(
    input(source, "follow", { kind: "full" }),
  )
  const runtime = new TranscriptRuntime(
    input(source, "follow", { kind: "full" }),
    {
      windowPolicy: { viewportRows: 1, overscanRows: 1 },
    },
  )
  const windowed = runtime.getSnapshot()

  expect(Object.isFrozen(reference.blocks)).toBe(true)
  expect(reference.window.blocks).toBe(reference.blocks)
  expect(windowed.blocks).not.toBe(reference.blocks)
  expect(Object.isFrozen(windowed.blocks)).toBe(false)
  expect([...windowed.blocks]).toEqual([...reference.blocks])
  expect(windowed.transcript).toEqual(reference.transcript)
  runtime.dispose()
})

test("follow reconciliation replaces a changed item and retains historical block identity", () => {
  let source = fixture()
  const history = itemId("history")
  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: history,
      turnId: turn,
      kind: "assistant",
      markdown: "settled",
      status: "complete",
    },
  })
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const before = runtime.getSnapshot()
  const answerBlock = before.blocks.find(
    (block) => block.key.kind === "item" && block.key.itemId === answer,
  )
  const historyBlock = before.blocks.find(
    (block) => block.key.kind === "item" && block.key.itemId === history,
  )
  source = apply(source, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " world",
  })
  const after = runtime.update(
    input(source, "follow", { kind: "blocks", itemIds: [answer] }),
  )
  expect(after).not.toBe(before)
  expect(after.transcript.order).toBe(before.transcript.order)
  expect(
    after.blocks.find(
      (block) => block.key.kind === "item" && block.key.itemId === answer,
    ),
  ).not.toBe(answerBlock)
  expect(
    after.blocks.find(
      (block) => block.key.kind === "item" && block.key.itemId === history,
    ),
  ).toBe(historyBlock)
  expect(after.transcript.projectionById[history]).toBe(
    before.transcript.projectionById[history],
  )
})

test("canonical reasoning streams never publish or damage the semantic transcript", () => {
  let source = fixture()
  const reasoning = itemId("reasoning")
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const before = runtime.getSnapshot()
  let notifications = 0
  runtime.subscribe(() => {
    notifications++
  })

  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: reasoning,
      turnId: turn,
      kind: "reasoning",
      markdown: "private",
      status: "running",
    },
  })
  expect(
    runtime.update(
      input(source, "follow", { kind: "blocks", itemIds: [reasoning] }),
    ),
  ).toBe(before)
  source = apply(source, {
    type: "item.delta",
    threadId: thread,
    itemId: reasoning,
    delta: " thought",
  })
  expect(
    runtime.update(
      input(source, "follow", { kind: "blocks", itemIds: [reasoning] }),
    ),
  ).toBe(before)
  source = apply(source, {
    type: "item.completed",
    threadId: thread,
    item: {
      id: reasoning,
      turnId: turn,
      kind: "reasoning",
      markdown: "private thought",
      status: "complete",
    },
  })
  expect(
    runtime.update(
      input(source, "follow", { kind: "blocks", itemIds: [reasoning] }),
    ),
  ).toBe(before)

  expect(source.conversation.items[reasoning]).toBeDefined()
  expect(source.transcript.order).not.toContain(reasoning)
  expect(runtime.getSnapshot().blocks).toBe(before.blocks)
  expect(runtime.getSnapshot().window).toBe(before.window)
  expect(runtime.getSnapshot().geometry).toBe(before.geometry)
  expect(notifications).toBe(0)

  source = apply(source, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " visible",
  })
  const visible = runtime.update(
    input(source, "follow", { kind: "blocks", itemIds: [answer] }),
  )
  expect(visible).not.toBe(before)
  expect(visible.displayedCanonicalRevision).toBe(source.revision)
  expect(notifications).toBe(1)
})

test("detached canonical reasoning stays silent and hidden-only reattachment retains presentation data", () => {
  let source = fixture()
  const reasoning = itemId("detached-reasoning")
  const runtime = new TranscriptRuntime(input(source, "follow"))
  runtime.update(input(source, "detached"))
  const pinned = runtime.getSnapshot()
  let notifications = 0
  runtime.subscribe(() => {
    notifications++
  })

  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: reasoning,
      turnId: turn,
      kind: "reasoning",
      markdown: "private",
      status: "running",
    },
  })
  expect(
    runtime.update(
      input(source, "detached", { kind: "blocks", itemIds: [reasoning] }),
    ),
  ).toBe(pinned)
  source = apply(source, {
    type: "item.delta",
    threadId: thread,
    itemId: reasoning,
    delta: " thought",
  })
  expect(
    runtime.update(
      input(source, "detached", { kind: "blocks", itemIds: [reasoning] }),
    ),
  ).toBe(pinned)
  expect(notifications).toBe(0)

  const followed = runtime.update(
    input(source, "follow", { kind: "blocks", itemIds: [reasoning] }),
  )
  expect(notifications).toBe(1)
  expect(followed.mode).toBe("follow")
  expect(followed.blocks).toBe(pinned.blocks)
  expect(followed.window).toBe(pinned.window)
  expect(followed.geometry).toBe(pinned.geometry)
  expect(followed.transcript.projectionById[reasoning]).toBeUndefined()
})

test("block damage updates one growing item without rebuilding a large historical plan", () => {
  let source = fixture()
  for (let index = 0; index < 300; index++) {
    source = apply(source, {
      type: "item.started",
      threadId: thread,
      item: {
        id: itemId(`history-${index}`),
        turnId: turn,
        kind: "assistant",
        markdown: `settled ${index}`,
        status: "complete",
      },
    })
  }
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const before = runtime.getSnapshot()
  source = apply(source, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " growing tail",
  })
  const after = runtime.update(
    input(source, "follow", { kind: "blocks", itemIds: [answer] }),
  )

  expect(after.transcript.order).toBe(before.transcript.order)
  expect(
    after.blocks.filter((block, index) => block === before.blocks[index]),
  ).toHaveLength(before.blocks.length - 1)
  expect(after.transcript.projectionById[itemId("history-299")]).toBe(
    before.transcript.projectionById[itemId("history-299")],
  )
})

test("validated empty-turn and item tail admissions append without rebuilding history", () => {
  let source = fixture()
  const diagnostics = runtimeDiagnostics()
  const runtime = new TranscriptRuntime(input(source, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics,
  })
  const before = runtime.getSnapshot()
  const initialCounters = { ...diagnostics }
  let publications = 0
  runtime.subscribe(() => {
    publications++
  })

  const nextTurn = turnId("structural-tail-turn"),
    nextItem = itemId("structural-tail-item")
  source = apply(source, {
    type: "turn.started",
    threadId: thread,
    turnId: nextTurn,
  })
  const afterTurn = runtime.update(
    input(source, "follow", { kind: "blocks", itemIds: [] }),
  )
  expect(afterTurn.displayedCanonicalRevision).toBe(source.revision)
  expect(afterTurn.blocks).toBe(before.blocks)
  expect(afterTurn.window).toBe(before.window)
  expect(afterTurn.geometry).toBe(before.geometry)
  expect(afterTurn.transcript).toBe(before.transcript)
  expect(
    diagnostics.completePlanBuilds - initialCounters.completePlanBuilds,
  ).toBe(0)
  expect(
    diagnostics.heightIndexBuilds - initialCounters.heightIndexBuilds,
  ).toBe(0)
  expect(
    diagnostics.windowGeometryBlockVisits -
      initialCounters.windowGeometryBlockVisits,
  ).toBe(0)

  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: nextItem,
      turnId: nextTurn,
      kind: "assistant",
      markdown: "new structural tail",
      status: "running",
    },
  })
  const beforeAppendCounters = { ...diagnostics }
  const appended = runtime.update(
    input(source, "follow", { kind: "blocks", itemIds: [nextItem] }),
  )
  const reference = createTranscriptFrame(
    input(source, "follow", { kind: "full" }),
  )
  expect(publications).toBe(2)
  expect(appended.blocks.map(blockKey)).toEqual(reference.blocks.map(blockKey))
  expect(
    appended.blocks
      .slice(0, before.blocks.length)
      .every((block, index) => block === before.blocks[index]),
  ).toBe(true)
  expect(appended.blocks.at(-1)?.key).toEqual({
    kind: "item",
    itemId: nextItem,
    blockId: "root",
  })
  expect(appended.transcript.order).toBe(source.transcript.order)
  expect(appended.window.blocks.length).toBeLessThanOrEqual(24)
  expect(
    diagnostics.completePlanBuilds - beforeAppendCounters.completePlanBuilds,
  ).toBe(0)
  expect(
    diagnostics.completePlanBlockVisits -
      beforeAppendCounters.completePlanBlockVisits,
  ).toBe(0)
  expect(
    diagnostics.heightIndexBuilds - beforeAppendCounters.heightIndexBuilds,
  ).toBe(0)
  expect(
    diagnostics.heightIndexBlockVisits -
      beforeAppendCounters.heightIndexBlockVisits,
  ).toBe(0)
  expect(
    diagnostics.completeGeometryBlockVisits -
      beforeAppendCounters.completeGeometryBlockVisits,
  ).toBe(0)
  expect(
    diagnostics.blockPlanUpdates - beforeAppendCounters.blockPlanUpdates,
  ).toBe(1)
  expect(
    diagnostics.heightIndexUpdates - beforeAppendCounters.heightIndexUpdates,
  ).toBe(1)
  expect(
    diagnostics.changedItemBuilds - beforeAppendCounters.changedItemBuilds,
  ).toBe(1)
  expect(
    diagnostics.orderIndexBuilds - beforeAppendCounters.orderIndexBuilds,
  ).toBe(0)
  expect(
    diagnostics.orderIndexItemVisits -
      beforeAppendCounters.orderIndexItemVisits,
  ).toBe(0)
  expect(
    diagnostics.windowGeometryBlockVisits -
      beforeAppendCounters.windowGeometryBlockVisits,
  ).toBeLessThanOrEqual(24)
  expect(
    diagnostics.blockPlanWindowSliceItems -
      beforeAppendCounters.blockPlanWindowSliceItems,
  ).toBeLessThanOrEqual(24)
})

test("validated tail completion replaces one item and appends source-less activity without rebuilding history", () => {
  let source = fixture()
  const diagnostics = runtimeDiagnostics()
  const runtime = new TranscriptRuntime(input(source, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics,
  })
  const before = runtime.getSnapshot()
  const baseline = { ...diagnostics }
  let publications = 0
  runtime.subscribe(() => {
    publications++
  })

  source = apply(source, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "complete",
    durationMs: 0,
  })
  const completed = runtime.update(
    input(source, "follow", { kind: "blocks", itemIds: [] }),
  )
  const reference = createTranscriptFrame(
    input(source, "follow", { kind: "full" }),
  )

  expect(publications).toBe(1)
  expect(semanticFrame(completed).blocks).toEqual(
    semanticFrame(reference).blocks,
  )
  expect(completed.blocks.map(blockKey)).toEqual([
    `item:${answer}:root`,
    `turn-activity:${turn}`,
  ])
  expect(completed.blocks[0]).not.toBe(before.blocks[0])
  expect(
    completed.blocks[0] && "projection" in completed.blocks[0]
      ? completed.blocks[0].followedByActivity
      : false,
  ).toBe(true)
  expect(completed.blocks[1]?.sourceSpan).toBeUndefined()
  expect(completed.transcript).toBe(before.transcript)
  expect(diagnostics.completePlanBuilds - baseline.completePlanBuilds).toBe(0)
  expect(
    diagnostics.completePlanBlockVisits - baseline.completePlanBlockVisits,
  ).toBe(0)
  expect(diagnostics.heightIndexBuilds - baseline.heightIndexBuilds).toBe(0)
  expect(
    diagnostics.heightIndexBlockVisits - baseline.heightIndexBlockVisits,
  ).toBe(0)
  expect(
    diagnostics.completeGeometryBlockVisits -
      baseline.completeGeometryBlockVisits,
  ).toBe(0)
  expect(diagnostics.blockPlanUpdates - baseline.blockPlanUpdates).toBe(2)
  expect(diagnostics.heightIndexUpdates - baseline.heightIndexUpdates).toBe(2)
  expect(diagnostics.changedItemBuilds - baseline.changedItemBuilds).toBe(1)
})

test("tail completion without activity replaces status only; an empty failed turn appends activity only", () => {
  let itemSource = fixture()
  const itemDiagnostics = runtimeDiagnostics()
  const itemRuntime = new TranscriptRuntime(input(itemSource, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics: itemDiagnostics,
  })
  const itemBaseline = { ...itemDiagnostics }
  itemSource = apply(itemSource, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "complete",
  })
  const itemFrame = itemRuntime.update(
    input(itemSource, "follow", { kind: "blocks", itemIds: [] }),
  )
  expect(itemFrame.blocks.map(blockKey)).toEqual([`item:${answer}:root`])
  expect(
    itemFrame.blocks[0] && "projection" in itemFrame.blocks[0]
      ? itemFrame.blocks[0].item.status
      : undefined,
  ).toBe("complete")
  expect(
    itemDiagnostics.completePlanBuilds - itemBaseline.completePlanBuilds,
  ).toBe(0)
  expect(itemDiagnostics.blockPlanUpdates - itemBaseline.blockPlanUpdates).toBe(
    1,
  )
  expect(
    itemDiagnostics.heightIndexUpdates - itemBaseline.heightIndexUpdates,
  ).toBe(1)

  let emptySource: Source = {
    conversation: createConversation(thread),
    transcript: initialTranscript(),
    revision: 0,
  }
  emptySource = apply(emptySource, {
    type: "turn.started",
    threadId: thread,
    turnId: turn,
  })
  const emptyDiagnostics = runtimeDiagnostics()
  const emptyRuntime = new TranscriptRuntime(input(emptySource, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics: emptyDiagnostics,
  })
  const emptyBaseline = { ...emptyDiagnostics }
  emptySource = apply(emptySource, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "failed",
  })
  const emptyFrame = emptyRuntime.update(
    input(emptySource, "follow", { kind: "blocks", itemIds: [] }),
  )
  expect(emptyFrame.blocks.map(blockKey)).toEqual([`turn-activity:${turn}`])
  expect(emptyFrame.blocks[0]?.sourceSpan).toBeUndefined()
  expect(
    emptyDiagnostics.completePlanBuilds - emptyBaseline.completePlanBuilds,
  ).toBe(0)
  expect(
    emptyDiagnostics.blockPlanUpdates - emptyBaseline.blockPlanUpdates,
  ).toBe(1)
  expect(
    emptyDiagnostics.heightIndexUpdates - emptyBaseline.heightIndexUpdates,
  ).toBe(1)
  expect(
    emptyDiagnostics.changedItemBuilds - emptyBaseline.changedItemBuilds,
  ).toBe(0)
})

test("ambiguous multi-item and mixed item-plus-completion changes retain the full reference fallback", () => {
  const initial = fixture()
  const second = itemId("completion-second")
  const multi = apply(initial, {
    type: "item.started",
    threadId: thread,
    item: {
      id: second,
      turnId: turn,
      kind: "assistant",
      markdown: "second",
      status: "running",
    },
  })
  const multiDiagnostics = runtimeDiagnostics()
  const multiRuntime = new TranscriptRuntime(input(multi, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics: multiDiagnostics,
  })
  const multiBaseline = { ...multiDiagnostics }
  const multiCompleted = apply(multi, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "interrupted",
  })
  const multiFrame = multiRuntime.update(
    input(multiCompleted, "follow", { kind: "blocks", itemIds: [] }),
  )
  expect(semanticFrame(multiFrame).blocks).toEqual(
    semanticFrame(
      createTranscriptFrame(input(multiCompleted, "follow", { kind: "full" })),
    ).blocks,
  )
  expect(
    multiDiagnostics.completePlanBuilds - multiBaseline.completePlanBuilds,
  ).toBe(1)

  let mixed = apply(initial, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " final",
  })
  mixed = apply(mixed, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "failed",
  })
  const mixedDiagnostics = runtimeDiagnostics()
  const mixedRuntime = new TranscriptRuntime(input(initial, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics: mixedDiagnostics,
  })
  const mixedBaseline = { ...mixedDiagnostics }
  const mixedFrame = mixedRuntime.update(
    input(mixed, "follow", { kind: "blocks", itemIds: [answer] }),
  )
  expect(semanticFrame(mixedFrame).blocks).toEqual(
    semanticFrame(
      createTranscriptFrame(input(mixed, "follow", { kind: "full" })),
    ).blocks,
  )
  expect(
    mixedDiagnostics.completePlanBuilds - mixedBaseline.completePlanBuilds,
  ).toBe(1)
})

test("detached structural completion intent survives prior item damage through reattach and missing-target reveal", () => {
  const initial = fixture()
  const hiddenDelta = apply(initial, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " hidden",
  })
  const completed = apply(hiddenDelta, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "failed",
    durationMs: 25,
  })
  const reference = createTranscriptFrame(
    input(completed, "follow", { kind: "full" }),
  )

  const reattachRuntime = new TranscriptRuntime(input(initial, "detached"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
  })
  const pinned = reattachRuntime.getSnapshot()
  expect(
    reattachRuntime.update(
      input(hiddenDelta, "detached", {
        kind: "blocks",
        itemIds: [answer],
      }),
    ),
  ).toBe(pinned)
  expect(
    reattachRuntime.update(
      input(completed, "detached", {
        kind: "blocks",
        itemIds: [],
      }),
    ),
  ).toBe(pinned)
  let reattachPublications = 0
  reattachRuntime.subscribe(() => {
    reattachPublications++
  })
  const reattached = reattachRuntime.update(input(completed, "follow"))
  expect(reattachPublications).toBe(1)
  expect(semanticFrame(reattached).blocks).toEqual(
    semanticFrame(reference).blocks,
  )
  expect(reattached.blocks.map(blockKey)).toEqual([
    `item:${answer}:root`,
    `turn-activity:${turn}`,
  ])

  const revealRuntime = new TranscriptRuntime(input(initial, "detached"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
  })
  const revealPinned = revealRuntime.getSnapshot()
  expect(
    revealRuntime.update(
      input(completed, "detached", {
        kind: "blocks",
        itemIds: [answer],
      }),
    ),
  ).toBe(revealPinned)
  const hiddenEnd =
    completed.transcript.projectionById[answer]!.sourceSpans.length
  const revealed = revealRuntime.update(
    input(
      completed,
      "detached",
      { kind: "none" },
      {
        itemId: answer,
        graphemeOffset: hiddenEnd,
      },
    ),
  )
  expect(revealed.mode).toBe("detached")
  expect(revealed.displayedCanonicalRevision).toBe(completed.revision)
  expect(semanticFrame(revealed).blocks).toEqual(
    semanticFrame(reference).blocks,
  )
  expect(revealed.blocks.map(blockKey)).toEqual([
    `item:${answer}:root`,
    `turn-activity:${turn}`,
  ])

  const retainedRuntime = new TranscriptRuntime(input(initial, "detached"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
  })
  const retainedPinned = retainedRuntime.getSnapshot()
  expect(
    retainedRuntime.update(
      input(completed, "detached", {
        kind: "blocks",
        itemIds: [answer],
      }),
    ),
  ).toBe(retainedPinned)
  const retained = retainedRuntime.update(
    input(
      completed,
      "detached",
      { kind: "none" },
      {
        itemId: answer,
        graphemeOffset: 0,
      },
    ),
  )
  expect(retained.blocks).toBe(retainedPinned.blocks)
  expect(retained.displayedCanonicalRevision).toBe(initial.revision)
  const retainedReattached = retainedRuntime.update(input(completed, "follow"))
  expect(semanticFrame(retainedReattached).blocks).toEqual(
    semanticFrame(reference).blocks,
  )
})

test("detached mixed replay preserves activity for a turn admitted and completed within one batch", () => {
  let initial = fixture()
  initial = apply(initial, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "complete",
  })
  let replayed = apply(initial, {
    type: "item.completed",
    threadId: thread,
    item: {
      id: answer,
      turnId: turn,
      kind: "assistant",
      markdown: "authoritative replay",
      status: "complete",
    },
  })
  const replayTurn = turnId("replay-empty-turn")
  replayed = apply(replayed, {
    type: "turn.started",
    threadId: thread,
    turnId: replayTurn,
  })
  replayed = apply(replayed, {
    type: "turn.completed",
    threadId: thread,
    turnId: replayTurn,
    outcome: "failed",
  })
  const reference = createTranscriptFrame(
    input(replayed, "follow", { kind: "full" }),
  )

  const reattachRuntime = new TranscriptRuntime(input(initial, "detached"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
  })
  const pinned = reattachRuntime.getSnapshot()
  expect(
    reattachRuntime.update(
      input(replayed, "detached", {
        kind: "blocks",
        itemIds: [answer],
      }),
    ),
  ).toBe(pinned)
  const reattached = reattachRuntime.update(input(replayed, "follow"))
  expect(semanticFrame(reattached).blocks).toEqual(
    semanticFrame(reference).blocks,
  )
  expect(reattached.blocks.map(blockKey)).toEqual([
    `item:${answer}:root`,
    `turn-activity:${replayTurn}`,
  ])

  const revealRuntime = new TranscriptRuntime(input(initial, "detached"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
  })
  const revealPinned = revealRuntime.getSnapshot()
  expect(
    revealRuntime.update(
      input(replayed, "detached", {
        kind: "blocks",
        itemIds: [answer],
      }),
    ),
  ).toBe(revealPinned)
  const revealed = revealRuntime.update(
    input(
      replayed,
      "detached",
      { kind: "none" },
      {
        itemId: answer,
        graphemeOffset:
          replayed.transcript.projectionById[answer]!.sourceSpans.length,
      },
    ),
  )
  expect(semanticFrame(revealed).blocks).toEqual(
    semanticFrame(reference).blocks,
  )
  expect(revealed.blocks.map(blockKey)).toContain(`turn-activity:${replayTurn}`)
})

test("detached mixed replay preserves an admitted activity while an older turn remains running", () => {
  const initial = fixture()
  let replayed = apply(initial, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " hidden replay",
  })
  const replayTurn = turnId("replay-after-active-turn")
  replayed = apply(replayed, {
    type: "turn.started",
    threadId: thread,
    turnId: replayTurn,
  })
  replayed = apply(replayed, {
    type: "turn.completed",
    threadId: thread,
    turnId: replayTurn,
    outcome: "failed",
  })
  const reference = createTranscriptFrame(
    input(replayed, "follow", { kind: "full" }),
  )

  for (const reveal of [false, true]) {
    const runtime = new TranscriptRuntime(input(initial, "detached"), {
      windowPolicy: { viewportRows: 12, overscanRows: 12 },
    })
    const pinned = runtime.getSnapshot()
    expect(
      runtime.update(
        input(replayed, "detached", {
          kind: "blocks",
          itemIds: [answer],
        }),
      ),
    ).toBe(pinned)
    const adopted = reveal
      ? runtime.update(
          input(
            replayed,
            "detached",
            { kind: "none" },
            {
              itemId: answer,
              graphemeOffset:
                replayed.transcript.projectionById[answer]!.sourceSpans.length,
            },
          ),
        )
      : runtime.update(input(replayed, "follow"))
    expect(semanticFrame(adopted).blocks).toEqual(
      semanticFrame(reference).blocks,
    )
    expect(adopted.blocks.map(blockKey)).toContain(
      `turn-activity:${replayTurn}`,
    )
  }
})

test("tail completion requires unexcluded follow presentation and exact persistent turn lineage", () => {
  const initial = fixture()
  const completed = apply(initial, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "failed",
    durationMs: 1,
  })

  const excludedDiagnostics = runtimeDiagnostics()
  const excludedRuntime = new TranscriptRuntime(
    { ...input(initial, "follow"), excludedTurnIds: [turn] },
    {
      windowPolicy: { viewportRows: 12, overscanRows: 12 },
      diagnostics: excludedDiagnostics,
    },
  )
  const excludedBaseline = { ...excludedDiagnostics }
  const excluded = excludedRuntime.update({
    ...input(completed, "follow", { kind: "blocks", itemIds: [] }),
    excludedTurnIds: [turn],
  })
  expect(excluded.blocks).toHaveLength(0)
  expect(
    excludedDiagnostics.completePlanBuilds -
      excludedBaseline.completePlanBuilds,
  ).toBe(1)

  const presentationDiagnostics = runtimeDiagnostics()
  const presentationRuntime = new TranscriptRuntime(input(initial, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics: presentationDiagnostics,
  })
  const presentationBaseline = { ...presentationDiagnostics }
  const presented = presentationRuntime.update({
    ...input(completed, "follow", { kind: "blocks", itemIds: [] }),
    presentationDamage: { kind: "view" },
  })
  expect(semanticFrame(presented).blocks).toEqual(
    semanticFrame(
      createTranscriptFrame(input(completed, "follow", { kind: "full" })),
    ).blocks,
  )
  expect(
    presentationDiagnostics.completePlanBuilds -
      presentationBaseline.completePlanBuilds,
  ).toBe(1)

  const revealDiagnostics = runtimeDiagnostics()
  const revealRuntime = new TranscriptRuntime(input(initial, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics: revealDiagnostics,
  })
  const revealBaseline = { ...revealDiagnostics }
  const revealed = revealRuntime.update(
    input(
      completed,
      "follow",
      { kind: "blocks", itemIds: [] },
      {
        itemId: answer,
        graphemeOffset: 0,
      },
    ),
  )
  expect(semanticFrame(revealed).blocks).toEqual(
    semanticFrame(
      createTranscriptFrame(input(completed, "follow", { kind: "full" })),
    ).blocks,
  )
  expect(
    revealDiagnostics.completePlanBuilds - revealBaseline.completePlanBuilds,
  ).toBe(1)

  const forgedDiagnostics = runtimeDiagnostics()
  const forgedRuntime = new TranscriptRuntime(input(initial, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics: forgedDiagnostics,
  })
  const forgedBaseline = { ...forgedDiagnostics }
  const forged = {
    ...completed,
    conversation: {
      ...completed.conversation,
      turns: { ...completed.conversation.turns },
    },
  }
  const forgedFrame = forgedRuntime.update(
    input(forged, "follow", { kind: "blocks", itemIds: [] }),
  )
  expect(semanticFrame(forgedFrame).blocks).toEqual(
    semanticFrame(
      createTranscriptFrame(input(forged, "follow", { kind: "full" })),
    ).blocks,
  )
  expect(
    forgedDiagnostics.completePlanBuilds - forgedBaseline.completePlanBuilds,
  ).toBe(1)
})

test("folding a completed command fragment plan takes the exact root rebuild fallback", () => {
  let source = fixture()
  source = apply(source, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "complete",
  })
  const commandTurn = turnId("fragment-command-turn"),
    commandId = itemId("fragment-command")
  source = apply(source, {
    type: "turn.started",
    threadId: thread,
    turnId: commandTurn,
  })
  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: commandId,
      turnId: commandTurn,
      kind: "command",
      title: "Large command",
      executionCommand: "bun test",
      detail: Array.from(
        { length: 180 },
        (_, index) =>
          `${String(index).padStart(4, "0")}: ${"output ".repeat(12)}`,
      ).join("\n"),
      status: "complete",
    },
  })
  source = apply(source, {
    type: "turn.completed",
    threadId: thread,
    turnId: commandTurn,
    outcome: "complete",
  })
  const diagnostics = runtimeDiagnostics()
  const runtime = new TranscriptRuntime(input(source, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics,
  })
  const unfolded = runtime.getSnapshot()
  const fragments = unfolded.blocks.filter(
    (block) => block.key.kind === "item" && block.key.itemId === commandId,
  )
  expect(fragments.length).toBeGreaterThan(1)
  expect(unfolded.window.blocks.length).toBeLessThan(unfolded.blocks.length)
  const baseline = { ...diagnostics }

  const foldedSource = {
    ...source,
    transcript: {
      ...source.transcript,
      folded: setTranscriptFoldValue(source.transcript.folded, commandId, true),
    },
  }
  const folded = runtime.update({
    ...input(foldedSource, "follow"),
    presentationDamage: { kind: "folds", itemIds: [commandId] },
  })
  const foldedReference = createTranscriptFrame(
    input(foldedSource, "follow", { kind: "full" }),
  )
  expect(semanticFrame(folded).blocks).toEqual(
    semanticFrame(foldedReference).blocks,
  )
  expect(
    folded.blocks
      .filter(
        (block) => block.key.kind === "item" && block.key.itemId === commandId,
      )
      .map(blockKey),
  ).toEqual([`item:${commandId}:root`])
  expect(diagnostics.completePlanBuilds - baseline.completePlanBuilds).toBe(1)

  const restored = runtime.update({
    ...input(source, "follow"),
    presentationDamage: { kind: "folds", itemIds: [commandId] },
  })
  expect(semanticFrame(restored).blocks).toEqual(
    semanticFrame(
      createTranscriptFrame(input(source, "follow", { kind: "full" })),
    ).blocks,
  )
  const restoredFragments = restored.blocks.filter(
    (block) => block.key.kind === "item" && block.key.itemId === commandId,
  )
  expect(
    restoredFragments.every((block, index) => block === fragments[index]),
  ).toBe(true)
  expect(diagnostics.completePlanBuilds - baseline.completePlanBuilds).toBe(2)
})

test("detached fragment fold fallbacks rebuild only the pinned revision and preserve hidden damage", () => {
  let displayed = fixture()
  displayed = apply(displayed, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "complete",
  })
  const commandTurn = turnId("detached-fragment-turn"),
    commandId = itemId("detached-fragment-command")
  displayed = apply(displayed, {
    type: "turn.started",
    threadId: thread,
    turnId: commandTurn,
  })
  displayed = apply(displayed, {
    type: "item.started",
    threadId: thread,
    item: {
      id: commandId,
      turnId: commandTurn,
      kind: "command",
      title: "Pinned large command",
      executionCommand: "bun test",
      detail: Array.from(
        { length: 180 },
        (_, index) =>
          `${String(index).padStart(4, "0")}: ${"pinned output ".repeat(8)}`,
      ).join("\n"),
      status: "complete",
    },
  })
  displayed = apply(displayed, {
    type: "turn.completed",
    threadId: thread,
    turnId: commandTurn,
    outcome: "complete",
  })
  const diagnostics = runtimeDiagnostics()
  const runtime = new TranscriptRuntime(input(displayed, "detached"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics,
  })
  const initial = runtime.getSnapshot()
  const initialFragments = initial.blocks.filter(
    (block) => block.key.kind === "item" && block.key.itemId === commandId,
  )
  expect(initialFragments.length).toBeGreaterThan(1)

  const hiddenTurn = turnId("fragment-hidden-turn"),
    hiddenItem = itemId("fragment-hidden-item")
  let latest = apply(displayed, {
    type: "turn.started",
    threadId: thread,
    turnId: hiddenTurn,
  })
  latest = apply(latest, {
    type: "item.started",
    threadId: thread,
    item: {
      id: hiddenItem,
      turnId: hiddenTurn,
      kind: "assistant",
      markdown: "must remain hidden",
      status: "complete",
    },
  })
  expect(
    runtime.update(
      input(latest, "detached", { kind: "blocks", itemIds: [hiddenItem] }),
    ),
  ).toBe(initial)

  const foldedDisplayed = {
    ...displayed,
    transcript: {
      ...displayed.transcript,
      folded: setTranscriptFoldValue(
        displayed.transcript.folded,
        commandId,
        true,
      ),
    },
  }
  const foldedLatest = {
    ...latest,
    transcript: {
      ...latest.transcript,
      folded: setTranscriptFoldValue(latest.transcript.folded, commandId, true),
    },
  }
  const folded = runtime.update({
    ...input(foldedLatest, "detached"),
    presentationDamage: { kind: "folds", itemIds: [commandId] },
  })
  expect(folded.displayedCanonicalRevision).toBe(displayed.revision)
  expect(
    folded.blocks.some(
      (block) => block.key.kind === "item" && block.key.itemId === hiddenItem,
    ),
  ).toBe(false)
  const foldedReference = new TranscriptRuntime(
    input(foldedDisplayed, "detached", { kind: "full" }),
    {
      windowPolicy: { viewportRows: 12, overscanRows: 12 },
    },
  )
  expect(semanticFrame(folded)).toEqual(
    semanticFrame(foldedReference.getSnapshot()),
  )
  foldedReference.dispose()

  const restored = runtime.update({
    ...input(latest, "detached"),
    presentationDamage: { kind: "folds", itemIds: [commandId] },
  })
  expect(restored.displayedCanonicalRevision).toBe(displayed.revision)
  expect(
    restored.blocks.some(
      (block) => block.key.kind === "item" && block.key.itemId === hiddenItem,
    ),
  ).toBe(false)
  const restoredFragments = restored.blocks.filter(
    (block) => block.key.kind === "item" && block.key.itemId === commandId,
  )
  expect(
    restoredFragments.every(
      (block, index) => block === initialFragments[index],
    ),
  ).toBe(true)

  const snapshotsBeforeAttach = diagnostics.hiddenDamageSnapshots!
  const attached = runtime.update(input(latest, "follow"))
  expect(attached.displayedCanonicalRevision).toBe(latest.revision)
  expect(
    attached.blocks.some(
      (block) => block.key.kind === "item" && block.key.itemId === hiddenItem,
    ),
  ).toBe(true)
  const attachedReference = new TranscriptRuntime(input(latest, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
  })
  expect(semanticFrame(attached)).toEqual(
    semanticFrame(attachedReference.getSnapshot()),
  )
  attachedReference.dispose()
  expect(diagnostics.hiddenDamageSnapshots! - snapshotsBeforeAttach).toBe(1)
  runtime.dispose()
})

test("damage to a known fragmented item takes the exact complete-plan fallback", () => {
  let source = fixture()
  source = apply(source, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "complete",
  })
  const commandTurn = turnId("fragment-rewrite-turn"),
    commandId = itemId("fragment-rewrite-command")
  source = apply(source, {
    type: "turn.started",
    threadId: thread,
    turnId: commandTurn,
  })
  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: commandId,
      turnId: commandTurn,
      kind: "command",
      title: "Rewrite command",
      executionCommand: "bun test",
      detail: Array.from(
        { length: 180 },
        (_, index) =>
          `${String(index).padStart(4, "0")}: ${"before ".repeat(12)}`,
      ).join("\n"),
      status: "complete",
    },
  })
  const diagnostics = runtimeDiagnostics()
  const runtime = new TranscriptRuntime(input(source, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics,
  })
  expect(
    runtime
      .getSnapshot()
      .blocks.filter(
        (block) => block.key.kind === "item" && block.key.itemId === commandId,
      ).length,
  ).toBeGreaterThan(1)
  const prior = source.conversation.items[commandId]!
  if (prior.kind !== "command") throw new Error("expected command fixture")
  const rewritten = Object.freeze({
    ...prior,
    detail: Array.from(
      { length: 180 },
      (_, index) => `${String(index).padStart(4, "0")}: ${"after ".repeat(12)}`,
    ).join("\n"),
  })
  const changed: Source = {
    revision: source.revision + 1,
    conversation: Object.freeze({
      ...source.conversation,
      items: Object.freeze({
        ...source.conversation.items,
        [commandId]: rewritten,
      }),
    }),
    transcript: syncTranscriptItem(source.transcript, rewritten),
  }
  const baseline = { ...diagnostics }
  const frame = runtime.update(
    input(changed, "follow", { kind: "blocks", itemIds: [commandId] }),
  )
  const reference = createTranscriptFrame(
    input(changed, "follow", { kind: "full" }),
  )
  expect(semanticFrame(frame).blocks).toEqual(semanticFrame(reference).blocks)
  expect(frame.transcript.projectionById[commandId]?.source).toContain(
    "after after",
  )
  expect(diagnostics.completePlanBuilds - baseline.completePlanBuilds).toBe(1)
  runtime.dispose()
})

test("a consumed reveal cannot replay through a later fragmented fold rebuild", () => {
  let source = fixture()
  source = apply(source, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "complete",
  })
  for (let index = 0; index < 24; index++) {
    const historyTurn = turnId(`reveal-history-turn-${index}`),
      historyItem = itemId(`reveal-history-item-${index}`)
    source = apply(source, {
      type: "turn.started",
      threadId: thread,
      turnId: historyTurn,
    })
    source = apply(source, {
      type: "item.started",
      threadId: thread,
      item: {
        id: historyItem,
        turnId: historyTurn,
        kind: "assistant",
        markdown: `history ${index}`,
        status: "complete",
      },
    })
  }
  const commandTurn = turnId("reveal-fragment-turn"),
    commandId = itemId("reveal-fragment-command")
  source = apply(source, {
    type: "turn.started",
    threadId: thread,
    turnId: commandTurn,
  })
  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: commandId,
      turnId: commandTurn,
      kind: "command",
      title: "Reveal command",
      executionCommand: "bun test",
      detail: Array.from(
        { length: 180 },
        (_, index) =>
          `${String(index).padStart(4, "0")}: ${"output ".repeat(12)}`,
      ).join("\n"),
      status: "complete",
    },
  })
  const runtime = new TranscriptRuntime(input(source, "detached"), {
    windowPolicy: { viewportRows: 2, overscanRows: 2 },
  })
  const commandPoint = { itemId: commandId, graphemeOffset: 1 }
  const revealed = runtime.update({
    ...input(source, "detached", { kind: "none" }, commandPoint),
    presentationDamage: { kind: "view" },
  })
  expect(pointIsMaterialized(revealed.window.blocks, commandPoint)).toBe(true)

  const answerPoint = { itemId: answer, graphemeOffset: 0 }
  const anchoredTranscript = Object.freeze({
    ...source.transcript,
    cursor: answerPoint,
    viewport: Object.freeze({
      kind: "point" as const,
      point: answerPoint,
      preferredScreenRow: 0,
    }),
  })
  const anchoredSource = { ...source, transcript: anchoredTranscript }
  const anchored = runtime.update({
    ...input(anchoredSource, "detached"),
    presentationDamage: { kind: "view" },
  })
  expect(pointIsMaterialized(anchored.window.blocks, answerPoint)).toBe(true)
  expect(pointIsMaterialized(anchored.window.blocks, commandPoint)).toBe(false)

  const foldedSource = {
    ...anchoredSource,
    transcript: {
      ...anchoredTranscript,
      folded: setTranscriptFoldValue(
        anchoredTranscript.folded,
        commandId,
        true,
      ),
    },
  }
  const folded = runtime.update({
    ...input(foldedSource, "detached"),
    presentationDamage: { kind: "folds", itemIds: [commandId] },
  })
  expect(pointIsMaterialized(folded.window.blocks, answerPoint)).toBe(true)
  expect(pointIsMaterialized(folded.window.blocks, commandPoint)).toBe(false)
  runtime.dispose()
})

test("one batched tail turn and item admission publishes once; unproven order lineage rebuilds", () => {
  const initial = fixture()
  const nextTurn = turnId("batched-tail-turn"),
    nextItem = itemId("batched-tail-item")
  let latest = apply(initial, {
    type: "turn.started",
    threadId: thread,
    turnId: nextTurn,
  })
  latest = apply(latest, {
    type: "item.started",
    threadId: thread,
    item: {
      id: nextItem,
      turnId: nextTurn,
      kind: "assistant",
      markdown: "batched structural tail",
      status: "running",
    },
  })
  const diagnostics = runtimeDiagnostics()
  const runtime = new TranscriptRuntime(input(initial, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics,
  })
  const before = runtime.getSnapshot()
  const baseline = { ...diagnostics }
  let publications = 0
  runtime.subscribe(() => {
    publications++
  })
  const appended = runtime.update(
    input(latest, "follow", { kind: "blocks", itemIds: [nextItem] }),
  )
  expect(publications).toBe(1)
  expect(
    appended.blocks
      .slice(0, before.blocks.length)
      .every((block, index) => block === before.blocks[index]),
  ).toBe(true)
  expect(appended.blocks.map(blockKey)).toEqual(
    createTranscriptFrame(input(latest, "follow", { kind: "full" })).blocks.map(
      blockKey,
    ),
  )
  expect(diagnostics.completePlanBuilds - baseline.completePlanBuilds).toBe(0)
  expect(diagnostics.heightIndexBuilds - baseline.heightIndexBuilds).toBe(0)

  const fallbackDiagnostics = runtimeDiagnostics()
  const fallbackRuntime = new TranscriptRuntime(input(initial, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics: fallbackDiagnostics,
  })
  const fallbackBaseline = { ...fallbackDiagnostics }
  const unproven = {
    ...latest,
    transcript: {
      ...latest.transcript,
      order: Object.freeze([...latest.transcript.order]),
    },
  }
  const rebuilt = fallbackRuntime.update(
    input(unproven, "follow", { kind: "blocks", itemIds: [nextItem] }),
  )
  expect(rebuilt.blocks.map(blockKey)).toEqual(
    createTranscriptFrame(
      input(unproven, "follow", { kind: "full" }),
    ).blocks.map(blockKey),
  )
  expect(
    fallbackDiagnostics.completePlanBuilds -
      fallbackBaseline.completePlanBuilds,
  ).toBe(1)
  expect(
    fallbackDiagnostics.completePlanBlockVisits -
      fallbackBaseline.completePlanBlockVisits,
  ).toBe(rebuilt.blocks.length)
})

test("structural admission rejects historical semantic rewrites and duplicate prior order membership", () => {
  const initial = fixture()
  const nextTurn = turnId("guarded-tail-turn"),
    nextItem = itemId("guarded-tail-item")
  let latest = apply(initial, {
    type: "turn.started",
    threadId: thread,
    turnId: nextTurn,
  })
  latest = apply(latest, {
    type: "item.started",
    threadId: thread,
    item: {
      id: nextItem,
      turnId: nextTurn,
      kind: "assistant",
      markdown: "guarded tail",
      status: "running",
    },
  })

  const originalProjection = latest.transcript.projectionById[answer]!
  const tamperedProjection = Object.freeze({
    ...originalProjection,
    plain: "TAMPERED",
    source: "TAMPERED",
  })
  const tampered = {
    ...latest,
    transcript: {
      ...latest.transcript,
      projectionById: setTranscriptProjection(
        latest.transcript.projectionById,
        answer,
        tamperedProjection,
      ),
    },
  }
  const projectionDiagnostics = runtimeDiagnostics()
  const projectionRuntime = new TranscriptRuntime(input(initial, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics: projectionDiagnostics,
  })
  const projectionBaseline = { ...projectionDiagnostics }
  const projectionFrame = projectionRuntime.update(
    input(tampered, "follow", { kind: "blocks", itemIds: [nextItem] }),
  )
  const projectionReference = createTranscriptFrame(
    input(tampered, "follow", { kind: "full" }),
  )
  expect(projectionFrame.blocks.map(blockKey)).toEqual(
    projectionReference.blocks.map(blockKey),
  )
  expect(
    projectionFrame.blocks.map((block) =>
      "projection" in block ? block.projection.source : undefined,
    ),
  ).toEqual(
    projectionReference.blocks.map((block) =>
      "projection" in block ? block.projection.source : undefined,
    ),
  )
  expect(
    projectionFrame.blocks.find(
      (block) =>
        "projection" in block &&
        block.key.itemId === answer &&
        block.projection.source === "TAMPERED",
    ),
  ).toBeTruthy()
  expect(
    projectionDiagnostics.completePlanBuilds -
      projectionBaseline.completePlanBuilds,
  ).toBe(1)

  const refolded = {
    ...latest,
    transcript: {
      ...latest.transcript,
      folded: setTranscriptFoldValue(latest.transcript.folded, answer, true),
    },
  }
  const foldDiagnostics = runtimeDiagnostics()
  const foldRuntime = new TranscriptRuntime(input(initial, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics: foldDiagnostics,
  })
  const foldBaseline = { ...foldDiagnostics }
  const foldFrame = foldRuntime.update(
    input(refolded, "follow", { kind: "blocks", itemIds: [nextItem] }),
  )
  expect(foldFrame.blocks.map(blockKey)).toEqual(
    createTranscriptFrame(
      input(refolded, "follow", { kind: "full" }),
    ).blocks.map(blockKey),
  )
  expect(
    foldDiagnostics.completePlanBuilds - foldBaseline.completePlanBuilds,
  ).toBe(1)

  const duplicateInitial = {
    ...initial,
    transcript: {
      ...initial.transcript,
      order: appendTranscriptOrder(initial.transcript.order, nextItem),
    },
  }
  let duplicateLatest = apply(duplicateInitial, {
    type: "turn.started",
    threadId: thread,
    turnId: nextTurn,
  })
  duplicateLatest = apply(duplicateLatest, {
    type: "item.started",
    threadId: thread,
    item: {
      id: nextItem,
      turnId: nextTurn,
      kind: "assistant",
      markdown: "duplicate tail",
      status: "running",
    },
  })
  const duplicateDiagnostics = runtimeDiagnostics()
  const duplicateRuntime = new TranscriptRuntime(
    input(duplicateInitial, "follow"),
    {
      windowPolicy: { viewportRows: 12, overscanRows: 12 },
      diagnostics: duplicateDiagnostics,
    },
  )
  const duplicateBaseline = { ...duplicateDiagnostics }
  duplicateRuntime.update(
    input(duplicateLatest, "follow", { kind: "blocks", itemIds: [nextItem] }),
  )
  expect(
    duplicateDiagnostics.completePlanBuilds -
      duplicateBaseline.completePlanBuilds,
  ).toBe(1)
})

test("structural admission retains exclusions, supports exact default folds, and rejects presentation transitions", () => {
  const initialBase = fixture()
  const initial = {
    ...initialBase,
    transcript: {
      ...initialBase.transcript,
      foldDefaults: Object.freeze({ reasoning: false, tools: true }),
    },
  }
  const nextTurn = turnId("presentation-guard-turn"),
    nextItem = itemId("presentation-guard-item")
  const withTurn = apply(initial, {
    type: "turn.started",
    threadId: thread,
    turnId: nextTurn,
  })
  const latest = apply(withTurn, {
    type: "item.started",
    threadId: thread,
    item: {
      id: nextItem,
      turnId: nextTurn,
      kind: "tool",
      title: "",
      detail: "folded tail",
      status: "running",
    },
  })

  const excludedDiagnostics = runtimeDiagnostics()
  const excludedInput = { ...input(initial, "follow"), excludedTurnIds: [turn] }
  const excludedRuntime = new TranscriptRuntime(excludedInput, {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics: excludedDiagnostics,
  })
  const excludedBaseline = { ...excludedDiagnostics }
  const excludedFrame = excludedRuntime.update({
    ...input(latest, "follow", { kind: "blocks", itemIds: [nextItem] }),
    excludedTurnIds: [turn],
  })
  expect(
    excludedDiagnostics.completePlanBuilds -
      excludedBaseline.completePlanBuilds,
  ).toBe(0)
  expect(excludedFrame.transcript.order).toEqual([nextItem])
  expect(Object.keys(excludedFrame.transcript.projectionById)).toEqual([
    nextItem,
  ])
  expect(excludedFrame.transcript.folded[nextItem]).toBe(true)
  const excludedReference = createTranscriptFrame({
    ...input(latest, "follow", { kind: "full" }),
    excludedTurnIds: [turn],
  })
  expect(excludedFrame.blocks.map(blockKey)).toEqual(
    excludedReference.blocks.map(blockKey),
  )
  expect(excludedFrame.transcript.order).toEqual(
    excludedReference.transcript.order,
  )

  const modeDiagnostics = runtimeDiagnostics()
  const modeRuntime = new TranscriptRuntime(input(initial, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics: modeDiagnostics,
  })
  const modeBaseline = { ...modeDiagnostics }
  const detached = modeRuntime.update(
    input(withTurn, "detached", { kind: "blocks", itemIds: [] }),
  )
  expect(detached.mode).toBe("detached")
  expect(
    modeDiagnostics.completePlanBuilds - modeBaseline.completePlanBuilds,
  ).toBe(1)

  const revealDiagnostics = runtimeDiagnostics()
  const revealRuntime = new TranscriptRuntime(input(initial, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics: revealDiagnostics,
  })
  const revealBaseline = { ...revealDiagnostics }
  revealRuntime.update(
    input(
      withTurn,
      "follow",
      { kind: "blocks", itemIds: [] },
      { itemId: answer, graphemeOffset: 0 },
    ),
  )
  expect(
    revealDiagnostics.completePlanBuilds - revealBaseline.completePlanBuilds,
  ).toBe(1)
})

test("detached tail streaming retains exact frame identity while canonical input advances", () => {
  let source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  runtime.update(input(source, "detached"))
  const detached = runtime.getSnapshot()
  let notifications = 0
  runtime.subscribe(() => {
    notifications++
  })
  for (let index = 0; index < 100; index++) {
    source = apply(source, {
      type: "item.delta",
      threadId: thread,
      itemId: answer,
      delta: String(index % 10),
    })
    expect(
      runtime.update(
        input(source, "detached", { kind: "blocks", itemIds: [answer] }),
      ),
    ).toBe(detached)
  }
  expect(runtime.getSnapshot()).toBe(detached)
  expect(runtime.getSnapshot().displayedCanonicalRevision).toBe(2)
  expect(notifications).toBe(0)
})

test("detached hidden damage accumulates distinct items without copying its prior backlog", () => {
  let source = fixture()
  let unseenItemIds = persistentTranscriptUnseenItemIds()
  for (let index = 0; index < 4_096; index++) {
    unseenItemIds = appendTranscriptUnseenItemId(
      unseenItemIds,
      itemId(`hidden-${index}`),
    )
  }
  source = {
    ...source,
    transcript: {
      ...source.transcript,
      viewport: {
        kind: "point",
        point: { itemId: answer, graphemeOffset: 0 },
        preferredScreenRow: 3,
      },
      unseenEntries: unseenItemIds.length,
      unseenItemIds,
    },
  }
  const diagnostics = runtimeDiagnostics()
  const runtime = new TranscriptRuntime(input(source, "detached"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics,
  })
  const presented = runtime.update({
    ...input(source, "detached"),
    presentationDamage: { kind: "view" },
  })
  expect(presented.transcript.unseenItemIds).toBe(unseenItemIds)
  const pinned = runtime.getSnapshot()
  let notifications = 0
  runtime.subscribe(() => {
    notifications++
  })

  for (let index = 0; index < unseenItemIds.length; index++) {
    source = { ...source, revision: source.revision + 1 }
    expect(
      runtime.update(
        input(source, "detached", {
          kind: "blocks",
          itemIds: [itemId(`hidden-${index}`)],
        }),
      ),
    ).toBe(pinned)
  }
  source = { ...source, revision: source.revision + 1 }
  expect(
    runtime.update(
      input(source, "detached", {
        kind: "blocks",
        itemIds: [itemId("hidden-4095")],
      }),
    ),
  ).toBe(pinned)
  expect(notifications).toBe(0)
  expect(diagnostics.hiddenDamageMerges).toBe(4_097)
  expect(diagnostics.hiddenDamageInputItemVisits).toBe(4_097)
  expect(diagnostics.hiddenDamageItemAdditions).toBe(4_096)
  expect(diagnostics.hiddenDamageSnapshots).toBe(0)
  expect(diagnostics.hiddenDamageSnapshotItemVisits).toBe(0)

  source = { ...source, transcript: attachTail(source.transcript) }
  const reattached = runtime.update(input(source, "follow"))
  expect(reattached).not.toBe(pinned)
  expect(notifications).toBe(1)
  expect(diagnostics.hiddenDamageSnapshots).toBe(1)
  expect(diagnostics.hiddenDamageSnapshotItemVisits).toBe(4_096)
  expect(reattached.transcript.unseenEntries).toBe(0)
  expect(reattached.transcript.unseenItemIds).toBe(
    persistentTranscriptUnseenItemIds(),
  )
})

test("detached hidden damage preserves public damage precedence and ordered uniqueness", () => {
  const first = itemId("damage-first"),
    second = itemId("damage-second")
  const cases: readonly Readonly<{
    damages: readonly TranscriptDamage[]
    expected: TranscriptDamage
  }>[] = [
    {
      damages: [
        { kind: "blocks", itemIds: [first] },
        { kind: "blocks", itemIds: [first, second] },
      ],
      expected: { kind: "blocks", itemIds: [first, second] },
    },
    {
      damages: [{ kind: "folds", itemIds: [first] }, { kind: "view" }],
      expected: { kind: "folds", itemIds: [first] },
    },
    {
      damages: [{ kind: "view" }, { kind: "folds", itemIds: [second] }],
      expected: { kind: "folds", itemIds: [second] },
    },
    {
      damages: [
        { kind: "blocks", itemIds: [first] },
        { kind: "folds", itemIds: [second] },
      ],
      expected: { kind: "layout" },
    },
    {
      damages: [{ kind: "view" }, { kind: "blocks", itemIds: [first] }],
      expected: { kind: "view" },
    },
    {
      damages: [{ kind: "layout" }, { kind: "blocks", itemIds: [first] }],
      expected: { kind: "layout" },
    },
    {
      damages: [{ kind: "full" }, { kind: "folds", itemIds: [first] }],
      expected: { kind: "full" },
    },
  ]

  for (const { damages, expected } of cases) {
    let source = fixture()
    const runtime = new TranscriptRuntime(input(source, "detached"), {
      windowPolicy: { viewportRows: 12, overscanRows: 12 },
    })
    const pinned = runtime.getSnapshot()
    for (const damage of damages) {
      source = { ...source, revision: source.revision + 1 }
      expect(runtime.update(input(source, "detached", damage))).toBe(pinned)
    }
    expect(runtime.update(input(source, "follow")).damage).toEqual(expected)
    runtime.dispose()
  }
})

test("detachment atomically includes canonical events ordered before its boundary", () => {
  let source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  source = apply(source, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " before detach",
  })
  const detached = runtime.update(
    input(source, "detached", { kind: "blocks", itemIds: [answer] }),
  )
  const block = detached.blocks.find(
    (block) => block.key.kind === "item" && block.key.itemId === answer,
  )
  expect(
    block && "projection" in block ? block.projection.source : undefined,
  ).toBe("hello before detach")
  expect(detached.displayedCanonicalRevision).toBe(source.revision)
})

test("detached presentation damage stays on pinned blocks and explicit missing targets reveal latest content", () => {
  let source = fixture()
  const runtime = new TranscriptRuntime(input(source, "detached"))
  const pinned = runtime.getSnapshot()
  source = apply(source, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " hidden",
  })
  runtime.update(
    input(source, "detached", { kind: "blocks", itemIds: [answer] }),
  )
  const layout = runtime.update({
    ...input(source, "detached"),
    presentationDamage: { kind: "layout" },
  })
  expect(layout.blocks).toBe(pinned.blocks)
  expect(layout.displayedCanonicalRevision).toBe(
    pinned.displayedCanonicalRevision,
  )
  expect(layout.damage.kind).toBe("layout")
  const revealed = runtime.update({
    ...input(
      source,
      "detached",
      { kind: "none" },
      {
        itemId: answer,
        graphemeOffset:
          source.transcript.projectionById[answer]!.sourceSpans.length,
      },
    ),
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
    const runtime = new TranscriptRuntime(input(before, "detached"), {
      windowPolicy: { viewportRows: 2, overscanRows: 2 },
    })
    const pinned = runtime.getSnapshot()
    const after = apply(before, {
      type: "item.delta",
      threadId: thread,
      itemId: answer,
      delta: " hidden",
    })
    expect(
      runtime.update(
        input(after, "detached", { kind: "blocks", itemIds: [answer] }),
      ),
    ).toBe(pinned)
    const revealed = runtime.update(
      input(
        after,
        "detached",
        { kind: "none" },
        { itemId: answer, graphemeOffset: offset(before, after) },
      ),
    )
    runtime.dispose()
    return { before, after, pinned, revealed }
  }

  const retained = appendCase(() => 0)
  expect(retained.revealed.blocks).toBe(retained.pinned.blocks)
  expect(retained.revealed.displayedCanonicalRevision).toBe(
    retained.before.revision,
  )

  const firstAppended = appendCase(
    (before) => before.transcript.projectionById[answer]!.sourceSpans.length,
  )
  expect(firstAppended.revealed.displayedCanonicalRevision).toBe(
    firstAppended.after.revision,
  )
  expect(firstAppended.revealed.blocks).not.toBe(firstAppended.pinned.blocks)

  const newEnd = appendCase(
    (_before, after) =>
      after.transcript.projectionById[answer]!.sourceSpans.length,
  )
  expect(newEnd.revealed.displayedCanonicalRevision).toBe(newEnd.after.revision)
  expect(newEnd.revealed.blocks).not.toBe(newEnd.pinned.blocks)

  const before = fixture()
  const rewrittenRuntime = new TranscriptRuntime(input(before, "detached"), {
    windowPolicy: { viewportRows: 2, overscanRows: 2 },
  })
  const rewrittenPinned = rewrittenRuntime.getSnapshot()
  const rewritten = apply(before, {
    type: "item.completed",
    threadId: thread,
    item: {
      id: answer,
      turnId: turn,
      kind: "assistant",
      markdown: "jello",
      status: "complete",
    },
  })
  expect(
    rewrittenRuntime.update(
      input(rewritten, "detached", { kind: "blocks", itemIds: [answer] }),
    ),
  ).toBe(rewrittenPinned)
  const revealedRewrite = rewrittenRuntime.update(
    input(
      rewritten,
      "detached",
      { kind: "none" },
      { itemId: answer, graphemeOffset: 0 },
    ),
  )
  expect(revealedRewrite.displayedCanonicalRevision).toBe(rewritten.revision)
  expect(revealedRewrite.blocks).not.toBe(rewrittenPinned.blocks)
  rewrittenRuntime.dispose()
})

test("explicit targets in new items materialize and activity remains source-less", () => {
  let source = fixture()
  const runtime = new TranscriptRuntime(input(source, "detached"))
  const next = itemId("next")
  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: next,
      turnId: turn,
      kind: "assistant",
      markdown: "new",
      status: "complete",
    },
  })
  runtime.update(input(source, "detached", { kind: "blocks", itemIds: [next] }))
  const revealed = runtime.update(
    input(
      source,
      "detached",
      { kind: "none" },
      { itemId: next, graphemeOffset: 0 },
    ),
  )
  expect(
    revealed.blocks.some(
      (block) => block.key.kind === "item" && block.key.itemId === next,
    ),
  ).toBe(true)
  source = apply(source, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "complete",
    durationMs: 500,
  })
  const followed = runtime.update(input(source, "follow", { kind: "view" }))
  const activity = followed.blocks.find(
    (block) => block.key.kind === "turn-activity",
  )
  expect(activity?.sourceSpan).toBeUndefined()
})

test("invalid reveals stay frozen and visible semantic changes map onto retained projections", () => {
  const source = fixture()
  const runtime = new TranscriptRuntime(input(source, "detached"))
  const pinned = runtime.getSnapshot()
  const invalid = runtime.update({
    ...input(source, "detached"),
    reveal: {
      id: ++revealId,
      point: { itemId: itemId("missing"), graphemeOffset: 0 },
      reason: "search",
    },
  })
  expect(invalid).toBe(pinned)
  const transcript = {
    ...source.transcript,
    cursor: { itemId: answer, graphemeOffset: 2 },
    viewport: {
      kind: "point" as const,
      point: { itemId: answer, graphemeOffset: 2 },
      preferredScreenRow: 4,
    },
  }
  const moved = runtime.update({
    ...input(
      { ...source, transcript },
      "detached",
      { kind: "none" },
      { itemId: answer, graphemeOffset: 2 },
    ),
    presentationDamage: { kind: "layout" },
  })
  expect(moved.transcript.cursor).toEqual({ itemId: answer, graphemeOffset: 2 })
  expect(moved.blocks).toBe(pinned.blocks)
  expect(moved.damage.kind).toBe("layout")
})

test("same-source completion replaces renderer metadata despite an unchanged projection revision", () => {
  let source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const before = runtime
    .getSnapshot()
    .blocks.find(
      (block) => block.key.kind === "item" && block.key.itemId === answer,
    )
  source = apply(source, {
    type: "item.completed",
    threadId: thread,
    item: {
      id: answer,
      turnId: turn,
      kind: "assistant",
      markdown: "hello",
      status: "complete",
      durationMs: 20,
    },
  })
  const after = runtime.update(
    input(source, "follow", { kind: "blocks", itemIds: [answer] }),
  )
  const completed = after.blocks.find(
    (block) => block.key.kind === "item" && block.key.itemId === answer,
  )
  expect(completed).not.toBe(before)
  expect(
    completed && "item" in completed ? completed.item : undefined,
  ).toMatchObject({ status: "complete", durationMs: 20 })
})

test("reattachment adopts the newest canonical revision once and equals a fresh build", () => {
  let source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  runtime.update(input(source, "detached"))
  for (const delta of [" one", " two", " three"]) {
    source = apply(source, {
      type: "item.delta",
      threadId: thread,
      itemId: answer,
      delta,
    })
    runtime.update(
      input(source, "detached", { kind: "blocks", itemIds: [answer] }),
    )
  }
  let notifications = 0
  runtime.subscribe(() => {
    notifications++
  })
  const attached = runtime.update(input(source, "follow"))
  expect(notifications).toBe(1)
  expect(attached.displayedCanonicalRevision).toBe(source.revision)
  expect(semanticFrame(attached)).toEqual(
    semanticFrame(new TranscriptRuntime(input(source, "follow")).getSnapshot()),
  )
  expect(runtime.update(input(source, "follow"))).toBe(attached)
  expect(notifications).toBe(1)
})

test("multi-item detached tail admission reattaches through the exact full-build reference", () => {
  let source = fixture()
  source = {
    ...source,
    transcript: {
      ...source.transcript,
      viewport: {
        kind: "point",
        point: { itemId: answer, graphemeOffset: 0 },
        preferredScreenRow: 3,
      },
    },
  }
  const diagnostics = runtimeDiagnostics()
  const runtime = new TranscriptRuntime(input(source, "detached"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
    diagnostics,
  })
  const pinned = runtime.getSnapshot()
  const hiddenTurn = turnId("multi-hidden-turn")
  const first = itemId("multi-hidden-first"),
    second = itemId("multi-hidden-second")
  source = apply(source, {
    type: "turn.started",
    threadId: thread,
    turnId: hiddenTurn,
  })
  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: first,
      turnId: hiddenTurn,
      kind: "assistant",
      markdown: "first hidden item",
      status: "complete",
    },
  })
  expect(
    runtime.update(
      input(source, "detached", { kind: "blocks", itemIds: [first] }),
    ),
  ).toBe(pinned)
  source = apply(source, {
    type: "item.started",
    threadId: thread,
    item: {
      id: second,
      turnId: hiddenTurn,
      kind: "assistant",
      markdown: "second hidden item",
      status: "complete",
    },
  })
  expect(
    runtime.update(
      input(source, "detached", { kind: "blocks", itemIds: [second] }),
    ),
  ).toBe(pinned)
  expect(source.transcript.unseenItemIds).toEqual([first, second])

  source = { ...source, transcript: attachTail(source.transcript) }
  const baseline = { ...diagnostics }
  let notifications = 0
  runtime.subscribe(() => {
    notifications++
  })
  const attached = runtime.update(input(source, "follow"))
  const referenceRuntime = new TranscriptRuntime(input(source, "follow"), {
    windowPolicy: { viewportRows: 12, overscanRows: 12 },
  })
  expect(notifications).toBe(1)
  expect(semanticFrame(attached)).toEqual(
    semanticFrame(referenceRuntime.getSnapshot()),
  )
  expect(diagnostics.completePlanBuilds - baseline.completePlanBuilds).toBe(1)
  expect(
    diagnostics.hiddenDamageSnapshots! - baseline.hiddenDamageSnapshots!,
  ).toBe(1)
  expect(attached.transcript.unseenEntries).toBe(0)
  expect(attached.transcript.unseenItemIds).toBe(
    persistentTranscriptUnseenItemIds(),
  )
  referenceRuntime.dispose()
  runtime.dispose()
})

test("two presentations over one source retain independent attachment and revisions", () => {
  let source = fixture()
  const following = new TranscriptRuntime(input(source, "follow"))
  const detached = new TranscriptRuntime(input(source, "detached"))
  const pinned = detached.getSnapshot()
  source = apply(source, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " change",
  })
  following.update(
    input(source, "follow", { kind: "blocks", itemIds: [answer] }),
  )
  detached.update(
    input(source, "detached", { kind: "blocks", itemIds: [answer] }),
  )
  expect(following.getSnapshot().displayedCanonicalRevision).toBe(
    source.revision,
  )
  expect(detached.getSnapshot()).toBe(pinned)
})

test("listener faults are isolated and reentrant updates settle after publication", () => {
  let source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const first = apply(source, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " one",
  })
  const second = apply(first, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " two",
  })
  let healthyCalls = 0
  runtime.subscribe(() => {
    throw new Error("renderer failed")
  })
  runtime.subscribe(() => {
    healthyCalls++
    if (healthyCalls === 1)
      runtime.update(
        input(second, "follow", { kind: "blocks", itemIds: [answer] }),
      )
  })
  const settled = runtime.update(
    input(first, "follow", { kind: "blocks", itemIds: [answer] }),
  )
  expect(healthyCalls).toBe(2)
  expect(settled.displayedCanonicalRevision).toBe(second.revision)
  expect(runtime.getSnapshot()).toBe(settled)
})

test("reentrant listeners drain every queued input and cannot overwrite a newer revision", () => {
  const source = fixture()
  const first = apply(source, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " one",
  })
  const older = apply(first, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " older",
  })
  const newer = apply(older, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " newest",
  })
  const runtime = new TranscriptRuntime(input(source, "follow"))
  let queued = false
  runtime.subscribe(() => {
    if (queued) return
    queued = true
    runtime.update(
      input(newer, "follow", { kind: "blocks", itemIds: [answer] }),
    )
  })
  runtime.subscribe(() => {
    if (runtime.getSnapshot().displayedCanonicalRevision === first.revision) {
      runtime.update(
        input(older, "follow", { kind: "blocks", itemIds: [answer] }),
      )
    }
  })
  const settled = runtime.update(
    input(first, "follow", { kind: "blocks", itemIds: [answer] }),
  )
  expect(settled.displayedCanonicalRevision).toBe(newer.revision)
  expect(settled.transcript.projectionById[answer]?.source).toBe(
    "hello one older newest",
  )
})

test("same-revision divergent canonical input takes the guarded full-rebuild fallback", () => {
  const source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const corrected = apply(source, {
    type: "item.delta",
    threadId: thread,
    itemId: answer,
    delta: " corrected",
  })
  const rebuilt = runtime.update({
    ...input(corrected, "follow", { kind: "blocks", itemIds: [answer] }),
    canonicalRevision: source.revision,
  })
  expect(rebuilt.damage.kind).toBe("full")
  expect(rebuilt.displayedCanonicalRevision).toBe(source.revision)
  expect(rebuilt.transcript.projectionById[answer]?.source).toBe(
    "hello corrected",
  )
})

test("forward revision gaps accept summarized damage while stale input is ignored and new lineage rebuilds", () => {
  const source = fixture()
  const runtime = new TranscriptRuntime(input(source, "follow"))
  const jumped = { ...source, revision: source.revision + 10 }
  const frame = runtime.update(
    input(jumped, "follow", { kind: "blocks", itemIds: [answer] }),
  )
  expect(frame.damage.kind).toBe("blocks")
  expect(frame.displayedCanonicalRevision).toBe(jumped.revision)
  expect(runtime.update(input(source, "follow"))).toBe(frame)
  const reset = runtime.update({
    ...input(source, "follow"),
    canonicalGeneration: 1,
  })
  expect(reset.damage.kind).toBe("full")
  expect(reset.displayedCanonicalRevision).toBe(source.revision)
  expect(reset.blocks[0]).not.toBe(frame.blocks[0])
  const otherThread = threadId("other-thread")
  const switched = runtime.update({
    ...input(source, "follow"),
    threadId: otherThread,
    canonicalGeneration: 1,
  })
  expect(switched.damage.kind).toBe("full")
  expect(runtime.getThreadId()).toBe(otherThread)
  expect(switched.blocks[0]).not.toBe(reset.blocks[0])
})
