import {
  itemId,
  threadId,
  turnId,
  type ConversationItem,
  type ConversationState,
  type ItemId,
  type ThreadId,
  type TurnId,
} from "@vimex/conversation"
import { initialTranscript, projectItem, type SourceSpan, type TranscriptState } from "@vimex/transcript"

/** Deterministic transcript fixtures shared by domain and renderer tests. */
export function assistantMessage(id: string, markdown: string, status: "running" | "complete" = "complete"): ConversationItem {
  return { id: itemId(id), turnId: turnId("turn"), kind: "assistant", markdown, status }
}

export const transcriptScalingBlockCounts = Object.freeze([100, 1_000, 10_000, 100_000] as const)

export interface TranscriptFixtureSnapshot {
  readonly canonicalRevision: number
  readonly conversation: ConversationState
  readonly transcript: TranscriptState
}

export interface TranscriptScalingFixture {
  readonly fixtureVersion: "transcript-scaling-v1"
  readonly blockCount: number
  readonly threadId: ThreadId
  readonly historyTurnId: TurnId
  readonly turnId: TurnId
  readonly tailItemId: ItemId
  readonly targets: Readonly<{
    first: ItemId
    quarter: ItemId
    selectionEnd: ItemId
    middle: ItemId
    threeQuarter: ItemId
    tail: ItemId
  }>
  readonly before: TranscriptFixtureSnapshot
  readonly afterTailDelta: TranscriptFixtureSnapshot
  readonly tailDelta: string
  readonly contentHash: string
}

const scaleContent = Object.freeze([
  "Settled transcript block.",
  "Search sentinel with [fixture link](https://vimex.test/windowing).",
  "Semantic selection boundary.",
  "Stable history for transcript windowing.",
])
const scaleTailSeed = "Running transcript tail."
const scaleTailDelta = " Fixed streaming delta."

function scaleItemId(index: number, width: number): ItemId {
  return itemId(`scale-item-${String(index).padStart(width, "0")}`)
}

function scaleItemSource(item: ConversationItem): string {
  switch (item.kind) {
    case "user": case "assistant": case "reasoning": return item.markdown
    case "edit": return item.patch
    case "command": case "tool": return [item.title, item.executionCommand, item.detail].filter(Boolean).join("\n")
    case "agent": return item.detail
    case "unknown": return [item.title, item.detail].filter(Boolean).join("\n")
  }
}

function hashText(hash: number, value: string): number {
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619)
  return hash >>> 0
}

function freezeTranscript(state: TranscriptState): TranscriptState {
  return Object.freeze({
    ...state,
    order: Object.isFrozen(state.order) ? state.order : Object.freeze([...state.order]),
    projectionById: Object.isFrozen(state.projectionById) ? state.projectionById : Object.freeze({ ...state.projectionById }),
    folded: Object.isFrozen(state.folded) ? state.folded : Object.freeze({ ...state.folded }),
    viewport: Object.isFrozen(state.viewport) ? state.viewport : Object.freeze({ ...state.viewport }),
    unseenItemIds: Object.isFrozen(state.unseenItemIds) ? state.unseenItemIds : Object.freeze([...state.unseenItemIds]),
    jumps: Object.isFrozen(state.jumps) ? state.jumps : Object.freeze({ back: Object.freeze([...state.jumps.back]), forward: Object.freeze([...state.jumps.forward]) }),
    marks: Object.isFrozen(state.marks) ? state.marks : Object.freeze({ ...state.marks }),
  })
}

/**
 * Builds an exact render-block-count history in O(n). A completed history turn
 * is followed by a running tail turn, so terminal activity is suppressed and
 * one item is one root render block until stable sub-block planning is introduced.
 */
export function buildTranscriptScalingFixture(blockCount: number): TranscriptScalingFixture {
  if (!Number.isInteger(blockCount) || blockCount < 1) throw new RangeError("blockCount must be a positive integer")
  const fixtureThread = threadId(`scale-thread-${blockCount}`)
  const historyTurn = turnId(`scale-history-turn-${blockCount}`)
  const fixtureTurn = turnId(`scale-tail-turn-${blockCount}`)
  const width = String(blockCount - 1).length
  const ids = Array.from({ length: blockCount }, (_, index) => scaleItemId(index, width))
  const tailItemId = ids.at(-1)!
  const targetIndex = (ratio: number) => Math.min(blockCount - 1, Math.floor((blockCount - 1) * ratio))
  const quarterIndex = targetIndex(0.25)
  const middleIndex = targetIndex(0.5)
  const threeQuarterIndex = targetIndex(0.75)
  const selectionEndIndex = Math.min(blockCount - 1, quarterIndex + 1)
  const targets = Object.freeze({
    first: ids[0]!,
    quarter: ids[quarterIndex]!,
    selectionEnd: ids[selectionEndIndex]!,
    middle: ids[middleIndex]!,
    threeQuarter: ids[threeQuarterIndex]!,
    tail: tailItemId,
  })
  const items: Record<string, ConversationItem> = {}
  const projectionById: Record<string, ReturnType<typeof projectItem>> = {}
  const sharedProjections = new Map<string, ReturnType<typeof projectItem>>()
  let contentHash = hashText(2_166_136_261, "transcript-scaling-v1")
  for (let index = 0; index < blockCount; index++) {
    const id = ids[index]!
    const itemTurn = index === blockCount - 1 ? fixtureTurn : historyTurn
    let item: ConversationItem
    if (index === blockCount - 1) {
      item = Object.freeze({ id, turnId: itemTurn, kind: "assistant" as const, markdown: scaleTailSeed, status: "running" as const })
    } else if (index === 0) {
      item = Object.freeze({ id, turnId: itemTurn, kind: "user" as const, markdown: "Forkable completed user request.", status: "complete" as const })
    } else if (index === quarterIndex) {
      item = Object.freeze({ id, turnId: itemTurn, kind: "assistant" as const,
        markdown: "Selection begins at a [fixture link](https://vimex.test/selection).", status: "complete" as const })
    } else if (index === selectionEndIndex) {
      item = Object.freeze({ id, turnId: itemTurn, kind: "command" as const,
        title: "Selection command boundary", detail: "deterministic command output", status: "complete" as const })
    } else if (index === middleIndex) {
      const patch = "@@ -1 +1 @@\n-before semantic value\n+after Search sentinel value"
      item = Object.freeze({ id, turnId: itemTurn, kind: "edit" as const, title: "Semantic fixture edit", patch,
        changes: Object.freeze([Object.freeze({ path: "semantic-fixture.ts", action: "update" as const, patch })]), status: "complete" as const })
    } else if (index === threeQuarterIndex) {
      item = Object.freeze({ id, turnId: itemTurn, kind: "reasoning" as const,
        markdown: "Foldable reasoning with Search sentinel evidence.", status: "complete" as const })
    } else {
      item = Object.freeze({ id, turnId: itemTurn, kind: "assistant" as const,
        markdown: scaleContent[index % scaleContent.length]!, status: "complete" as const })
    }
    const source = scaleItemSource(item)
    contentHash = hashText(hashText(hashText(hashText(contentHash, id), item.kind), source), item.status)
    items[id] = item
    const projectionKey = `${item.kind}\u0000${source}`
    let projection = sharedProjections.get(projectionKey)
    if (!projection) {
      projection = projectItem(item)
      sharedProjections.set(projectionKey, projection)
    }
    projectionById[id] = projection
  }
  const completedTurn = Object.freeze({ id: historyTurn, status: "complete" as const, itemIds: Object.freeze(ids.slice(0, -1)) })
  const turn = Object.freeze({ id: fixtureTurn, status: "running" as const, itemIds: Object.freeze([tailItemId]) })
  const conversation: ConversationState = Object.freeze({
    threadId: fixtureThread,
    turnIds: Object.freeze([historyTurn, fixtureTurn]),
    turns: Object.freeze({ [historyTurn]: completedTurn, [fixtureTurn]: turn }),
    items: Object.freeze(items),
    activeTurnId: fixtureTurn,
  })
  const transcript = freezeTranscript({
    ...initialTranscript(),
    order: ids,
    projectionById,
    cursor: { itemId: targets.middle, graphemeOffset: 0 },
    selection: { anchor: { itemId: targets.quarter, graphemeOffset: 0 }, head: { itemId: targets.selectionEnd, graphemeOffset: 25 }, shape: "character" },
    search: { query: "Search sentinel", direction: "forward" },
    folded: { [targets.threeQuarter]: true },
    jumps: {
      back: [{ point: { itemId: targets.first, graphemeOffset: 0 }, preferredScreenRow: 2 }],
      forward: [{ point: { itemId: targets.threeQuarter, graphemeOffset: 0 }, preferredScreenRow: 9 }],
    },
    marks: { a: { point: { itemId: targets.middle, graphemeOffset: 0 }, preferredScreenRow: 5 } },
  })
  const before = Object.freeze({ canonicalRevision: 1, conversation, transcript })
  const afterTailDelta = appendTranscriptScalingTail(before, tailItemId, scaleTailDelta)
  contentHash = hashText(hashText(contentHash, scaleTailDelta), String(blockCount))
  return Object.freeze({
    fixtureVersion: "transcript-scaling-v1" as const,
    blockCount,
    threadId: fixtureThread,
    historyTurnId: historyTurn,
    turnId: fixtureTurn,
    tailItemId,
    targets,
    before,
    afterTailDelta,
    tailDelta: scaleTailDelta,
    contentHash: contentHash.toString(16).padStart(8, "0"),
  })
}

export function appendTranscriptScalingTail(snapshot: TranscriptFixtureSnapshot, tailItemId: ItemId, delta: string): TranscriptFixtureSnapshot {
  const prior = snapshot.conversation.items[tailItemId]
  if (!prior || !("markdown" in prior)) throw new Error(`Missing Markdown tail item ${tailItemId}`)
  const item = Object.freeze({ ...prior, markdown: prior.markdown + delta })
  const conversation = Object.freeze({
    ...snapshot.conversation,
    items: Object.freeze({ ...snapshot.conversation.items, [tailItemId]: item }),
  })
  const transcript = freezeTranscript({
    ...snapshot.transcript,
    projectionById: Object.freeze({
      ...snapshot.transcript.projectionById,
      [tailItemId]: projectItem(item, snapshot.transcript.projectionById[tailItemId]),
    }),
  })
  return Object.freeze({ canonicalRevision: snapshot.canonicalRevision + 1, conversation, transcript })
}

export interface FixtureSourceSegment {
  readonly stableId: string
  readonly sourceSpan: Readonly<SourceSpan>
}

export interface OversizedTranscriptFixture {
  readonly shape: "markdown" | "command-output" | "split-diff"
  readonly item: ConversationItem
  readonly source: string
  /** Deterministic fixture segmentation; production render-block policy remains independent. */
  readonly segments: readonly FixtureSourceSegment[]
}

function segmentedSource(parts: readonly Readonly<{ stableId: string; value: string }>[], separator: string): Readonly<{ source: string; segments: readonly FixtureSourceSegment[] }> {
  let source = ""
  const segments: FixtureSourceSegment[] = []
  parts.forEach((part, index) => {
    const from = source.length
    source += part.value
    if (index < parts.length - 1) source += separator
    segments.push(Object.freeze({ stableId: part.stableId, sourceSpan: Object.freeze({ from, to: source.length }) }))
  })
  return Object.freeze({ source, segments: Object.freeze(segments) })
}

/** Reusable one-item cold-path shapes with deterministic fixture-only segments. */
export function buildOversizedTranscriptFixtures(): readonly OversizedTranscriptFixture[] {
  const oversizedTurn = turnId("oversized-turn")
  const markdownParts = Array.from({ length: 1_024 }, (_, index) => ({
    stableId: `paragraph:${index}`,
    value: index % 64 === 0
      ? `## Section ${index}\n\n| column | value |\n| --- | ---: |\n| row | ${index} |\n\n\`wide-${index}-👨‍👩‍👧‍👦\``
      : `Paragraph ${index}: ${"deterministic markdown content ".repeat(3)}[link](https://vimex.test/${index}).`,
  }))
  const markdown = segmentedSource(markdownParts, "\n\n")
  const markdownItem = Object.freeze({ id: itemId("oversized-markdown"), turnId: oversizedTurn, kind: "assistant" as const, markdown: markdown.source, status: "complete" as const })

  const commandParts = [
    { stableId: "title", value: "Large deterministic command" },
    ...Array.from({ length: 2_500 }, (_, index) => ({ stableId: `line:${index}`, value: `${String(index).padStart(4, "0")}: ${"result ".repeat(12)}` })),
  ]
  const command = segmentedSource(commandParts, "\n")
  const commandItem = Object.freeze({
    id: itemId("oversized-command"), turnId: oversizedTurn, kind: "command" as const,
    title: commandParts[0]!.value, detail: commandParts.slice(1).map(part => part.value).join("\n"), status: "complete" as const,
  })

  const diffParts = Array.from({ length: 128 }, (_, index) => {
    const path = `packages/fixture-${String(index).padStart(3, "0")}.ts`
    return {
      stableId: `file:${index}`,
      value: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,4 +1,4 @@\n export const fixture${index} = {\n-  value: "before-${index}",\n+  value: "after-${index}",\n   stable: true,\n }`,
      path,
    }
  })
  const diff = segmentedSource(diffParts, "\n")
  const diffItem = Object.freeze({
    id: itemId("oversized-split-diff"), turnId: oversizedTurn, kind: "edit" as const,
    title: "128 deterministic file changes", patch: diff.source,
    changes: Object.freeze(diffParts.map(part => Object.freeze({ path: part.path, action: "update" as const, patch: part.value }))),
    status: "complete" as const,
  })

  return Object.freeze([
    Object.freeze({ shape: "markdown" as const, item: markdownItem, source: markdown.source, segments: markdown.segments }),
    Object.freeze({ shape: "command-output" as const, item: commandItem, source: command.source, segments: command.segments }),
    Object.freeze({ shape: "split-diff" as const, item: diffItem, source: diff.source, segments: diff.segments }),
  ])
}
