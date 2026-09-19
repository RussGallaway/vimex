import { effectiveItemStatus, type ConversationItem, type ConversationState, type ItemId, type ItemStatus, type Turn, type TurnId } from "@vimex/conversation"
import type { LogicalPoint, SourceSpan, TextProjection, TranscriptState } from "./domain/transcript-document"

/** Published render plans never expose mutable canonical objects. */
export type Immutable<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends readonly (infer Element)[]
    ? readonly Immutable<Element>[]
    : T extends object
      ? { readonly [Key in keyof T]: Immutable<T[Key]> }
      : T

export type TranscriptBlockItem = Immutable<ConversationItem>
export type TranscriptBlockProjection = Immutable<TextProjection>

export interface TranscriptItemBlock {
  readonly key: Readonly<{ kind: "item"; itemId: ItemId; blockId: string }>
  readonly turnId: TurnId
  /** Immutable canonical item metadata shared by every block of this item. */
  readonly item: TranscriptBlockItem
  /** Render-ready payload for sourceSpan. Stage 2 publishes the complete item. */
  readonly renderItem: TranscriptBlockItem
  /** Immutable semantic projection used to address sourceSpan and logical points. */
  readonly projection: TranscriptBlockProjection
  readonly sourceSpan: Readonly<SourceSpan>
  readonly contentRevision: number
  readonly estimatedRows: number
}

export interface TranscriptTurnActivityBlock {
  readonly key: Readonly<{ kind: "turn-activity"; turnId: TurnId }>
  readonly turn: Turn
  readonly sourceSpan?: undefined
  readonly contentRevision: number
  readonly estimatedRows: number
}

export type TranscriptBlock = TranscriptItemBlock | TranscriptTurnActivityBlock

export type TranscriptActivityFamily = "web-research" | "read" | "provider"

/**
 * A renderer-neutral presentation relationship over canonical item blocks.
 * Children remain ordinary semantic blocks; the batch only describes when a
 * presentation may replace adjacent collapsed headers with one compact row.
 */
export interface TranscriptActivityBatch {
  readonly key: string
  readonly turnId: TurnId
  readonly family: TranscriptActivityFamily
  readonly label: string
  readonly countLabel: string
  readonly leadItemId: ItemId
  readonly itemIds: readonly ItemId[]
  /** Render-block membership; only the first block is the visible batch lead. */
  readonly blockKeys: readonly string[]
  readonly blockItemIds: readonly ItemId[]
  readonly leadGraphemeFrom: number
  readonly leadGraphemeTo: number
  readonly leadIncludesEnd: boolean
  /** Present only when every child reports a positive, finite duration. */
  readonly durationMs?: number
}

export type TranscriptBlockPresentation = "item" | "activity-lead" | "activity-hidden"

export interface TranscriptActivityPresentation {
  readonly kind: Exclude<TranscriptBlockPresentation, "item">
  readonly batch: TranscriptActivityBatch
  readonly itemId: ItemId
}

export interface TranscriptWindow {
  readonly blocks: readonly TranscriptBlock[]
  readonly activityBatches: readonly TranscriptActivityBatch[]
  readonly activityBatchByItem: Readonly<Record<string, TranscriptActivityBatch>>
  readonly activityPresentation: Readonly<Record<string, TranscriptActivityPresentation>>
  readonly topSpacerRows: number
  readonly bottomSpacerRows: number
  readonly overscanRows: number
}

interface ActivityCandidate {
  readonly family: TranscriptActivityFamily
  readonly key: string
  readonly label: string
  readonly noun: string
  readonly plural: string
}

function activityCandidate(block: TranscriptBlock): ActivityCandidate | undefined {
  if (!("item" in block) || (block.item.kind !== "command" && block.item.kind !== "tool") || block.item.status !== "complete") return undefined
  const activity = block.item.activity
  if (activity?.family === "web-research") return { family: "web-research", key: "web-research", label: "Web research", noun: "search", plural: "searches" }
  if (activity?.family === "read") return { family: "read", key: "read", label: "Read files", noun: "read", plural: "reads" }
  if (activity?.family !== "provider" || !activity.label) return undefined
  return { family: "provider", key: `provider:${activity.label.toLowerCase()}`, label: activity.label, noun: "action", plural: "actions" }
}

function sameValues<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameActivityBatch(left: TranscriptActivityBatch, right: TranscriptActivityBatch): boolean {
  return left.key === right.key && left.turnId === right.turnId && left.family === right.family
    && left.label === right.label && left.countLabel === right.countLabel && left.leadItemId === right.leadItemId
    && left.durationMs === right.durationMs && sameValues(left.itemIds, right.itemIds)
    && sameValues(left.blockKeys, right.blockKeys) && sameValues(left.blockItemIds, right.blockItemIds)
    && left.leadGraphemeFrom === right.leadGraphemeFrom && left.leadGraphemeTo === right.leadGraphemeTo
    && left.leadIncludesEnd === right.leadIncludesEnd
}

function activityBatches(blocks: readonly TranscriptBlock[], prior: readonly TranscriptActivityBatch[] = []): readonly TranscriptActivityBatch[] {
  const batches: TranscriptActivityBatch[] = []
  const priorByKey = new Map(prior.map(batch => [batch.key, batch]))
  let run: { candidate: ActivityCandidate; items: TranscriptItemBlock[]; blocks: TranscriptItemBlock[] } | undefined
  const flush = () => {
    if (!run || run.items.length < 2) { run = undefined; return }
    const itemIds = Object.freeze(run.items.map(block => block.key.itemId))
    const blockKeys = Object.freeze(run.blocks.map(blockKey))
    const blockItemIds = Object.freeze(run.blocks.map(block => block.key.itemId))
    const leadRange = blockGraphemeRange(run.blocks[0]!)
    const count = itemIds.length
    const durations = run.items.map(block => block.item.durationMs)
    const durationMs = durations.every(value => value !== undefined && Number.isFinite(value) && value > 0)
      ? durations.reduce<number>((sum, value) => sum + value!, 0) : undefined
    const candidate = Object.freeze({
      key: `${run.candidate.key}:${itemIds[0]}`,
      turnId: run.items[0]!.turnId,
      family: run.candidate.family,
      label: run.candidate.label,
      countLabel: `${count} ${count === 1 ? run.candidate.noun : run.candidate.plural}`,
      leadItemId: itemIds[0]!,
      itemIds,
      blockKeys,
      blockItemIds,
      leadGraphemeFrom: leadRange.from,
      leadGraphemeTo: leadRange.to,
      leadIncludesEnd: leadRange.to === run.blocks[0]!.projection.sourceSpans.length,
      ...(durationMs === undefined ? {} : { durationMs }),
    })
    const previous = priorByKey.get(candidate.key)
    batches.push(previous && sameActivityBatch(previous, candidate) ? previous : candidate)
    run = undefined
  }
  for (const block of blocks) {
    const candidate = activityCandidate(block)
    if (!candidate || !("item" in block)) { flush(); continue }
    if (run?.blocks.at(-1)?.key.itemId === block.key.itemId) {
      run.blocks.push(block)
      continue
    }
    if (!run || run.candidate.key !== candidate.key || run.items[0]!.turnId !== block.turnId) {
      flush()
      run = { candidate, items: [block], blocks: [block] }
    } else {
      run.items.push(block)
      run.blocks.push(block)
    }
  }
  flush()
  return Object.freeze(batches)
}

/**
 * A batch is compact only while every child is folded. A precise cursor,
 * viewport anchor, or selection in a non-lead child temporarily expands the
 * group so semantic navigation can never point at invisible content.
 */
export function transcriptActivityPresentation(
  window: Pick<TranscriptWindow, "activityBatches">,
  state: TranscriptState,
  prior: Readonly<Record<string, TranscriptActivityPresentation>> = {},
): Readonly<Record<string, TranscriptActivityPresentation>> {
  const result: Record<string, TranscriptActivityPresentation> = {}
  const protectedPoints = [state.cursor, state.viewport.kind === "point" ? state.viewport.point : undefined,
    state.selection?.anchor, state.selection?.head].filter((point): point is LogicalPoint => Boolean(point))
  for (const batch of window.activityBatches) {
    if (!batch.itemIds.every(id => state.folded[id] === true)) continue
    if (protectedPoints.some(point => {
      if (!batch.itemIds.includes(point.itemId)) return false
      if (point.itemId !== batch.leadItemId) return true
      return point.graphemeOffset < batch.leadGraphemeFrom || point.graphemeOffset > batch.leadGraphemeTo
        || (point.graphemeOffset === batch.leadGraphemeTo && !batch.leadIncludesEnd)
    })) continue
    batch.blockKeys.forEach((key, index) => {
      const kind = index === 0 ? "activity-lead" : "activity-hidden"
      const itemId = batch.blockItemIds[index]!
      const previous = prior[key]
      result[key] = previous?.kind === kind && previous.batch === batch && previous.itemId === itemId
        ? previous : Object.freeze({ kind, batch, itemId })
    })
  }
  return Object.freeze(result)
}

function sameActivityPresentation(
  left: Readonly<Record<string, TranscriptActivityPresentation>>,
  right: Readonly<Record<string, TranscriptActivityPresentation>>,
): boolean {
  const leftEntries = Object.entries(left), rightEntries = Object.entries(right)
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([itemId, value]) => right[itemId]?.kind === value.kind && right[itemId]?.batch === value.batch)
}

function windowWithActivityPlan(
  blocks: readonly TranscriptBlock[],
  batches: readonly TranscriptActivityBatch[],
  state: TranscriptState,
  prior?: TranscriptWindow,
): TranscriptWindow {
  const activityBatchByItem = prior?.activityBatches === batches ? prior.activityBatchByItem : Object.freeze(Object.fromEntries(
    batches.flatMap(batch => batch.itemIds.map(itemId => [itemId, batch])),
  ))
  const selected = transcriptActivityPresentation({ activityBatches: batches }, state, prior?.activityPresentation)
  const presentation = prior && sameActivityPresentation(prior.activityPresentation, selected) ? prior.activityPresentation : selected
  if (prior && prior.blocks === blocks && prior.activityBatches === batches && prior.activityPresentation === presentation) return prior
  return Object.freeze({ blocks, activityBatches: batches, activityBatchByItem, activityPresentation: presentation, topSpacerRows: 0, bottomSpacerRows: 0, overscanRows: 0 })
}

export interface BuildTranscriptBlocksInput {
  readonly conversation: ConversationState
  readonly transcript: TranscriptState
  readonly excludedTurnIds?: readonly TurnId[] | ReadonlySet<TurnId>
}

/** Terminal turn metadata is presentation decoration, not transcript content. */
export function hasTurnActivity(turn: Turn): boolean {
  return turn.status === "failed" || turn.status === "interrupted"
    || (turn.status === "complete" && (turn.durationMs !== undefined || (turn.startedAt !== undefined && turn.completedAt !== undefined)))
}

function turnActivityRevision(turn: Turn): number {
  const value = `${turn.status}\u0000${turn.startedAt ?? ""}\u0000${turn.completedAt ?? ""}\u0000${turn.durationMs ?? ""}`
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619)
  return hash >>> 0
}

function immutableClone<T>(value: T): Immutable<T> {
  if (Array.isArray(value)) return Object.freeze(value.map(entry => immutableClone(entry))) as Immutable<T>
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, immutableClone(entry)]))) as Immutable<T>
  }
  return value as Immutable<T>
}

const itemSnapshots = new WeakMap<ConversationItem, Map<ItemStatus, TranscriptBlockItem>>()
const itemRevisions = new WeakMap<ConversationItem, Map<ItemStatus, WeakMap<TextProjection, number>>>()
let nextItemRevision = 1

function snapshotItem(conversation: ConversationState, item: ConversationItem): TranscriptBlockItem {
  const status = effectiveItemStatus(conversation, item)
  let byStatus = itemSnapshots.get(item)
  if (!byStatus) {
    byStatus = new Map()
    itemSnapshots.set(item, byStatus)
  }
  const existing = byStatus.get(status)
  if (existing) return existing
  const snapshot = immutableClone({ ...item, status } as ConversationItem)
  byStatus.set(status, snapshot)
  return snapshot
}

function snapshotProjection(projection: TextProjection): TranscriptBlockProjection {
  // TextProjection is deeply readonly at the domain boundary. Sharing it
  // avoids cloning every grapheme source span again on each streaming cadence.
  return projection
}

function itemContentRevision(sourceItem: ConversationItem, status: ItemStatus, sourceProjection: TextProjection): number {
  let byStatus = itemRevisions.get(sourceItem)
  if (!byStatus) {
    byStatus = new Map()
    itemRevisions.set(sourceItem, byStatus)
  }
  let byProjection = byStatus.get(status)
  if (!byProjection) {
    byProjection = new WeakMap()
    byStatus.set(status, byProjection)
  }
  const existing = byProjection.get(sourceProjection)
  if (existing !== undefined) return existing
  // Canonical reducers replace item/projection objects rather than mutating
  // them. Their identity pair therefore covers source and every visible item
  // field without serializing a growing tool or Markdown payload per cadence.
  const revision = nextItemRevision++
  byProjection.set(sourceProjection, revision)
  return revision
}

function snapshotTurn(turn: Turn): Turn {
  return Object.freeze({ ...turn, itemIds: Object.freeze([...turn.itemIds]) })
}

/** Builds the Stage 2 root block for one known semantic item. */
export function buildTranscriptItemBlock(input: Pick<BuildTranscriptBlocksInput, "conversation" | "transcript">, itemId: ItemId): TranscriptItemBlock | undefined {
  const item = input.conversation.items[itemId]
  const projection = input.transcript.projectionById[itemId]
  if (!item || !projection) return undefined
  const status = effectiveItemStatus(input.conversation, item)
  const itemSnapshot = snapshotItem(input.conversation, item)
  const projectionSnapshot = snapshotProjection(projection)
  return Object.freeze({
    key: Object.freeze({ kind: "item" as const, itemId, blockId: "root" }),
    turnId: item.turnId,
    item: itemSnapshot,
    renderItem: itemSnapshot,
    projection: projectionSnapshot,
    sourceSpan: Object.freeze({ from: 0, to: projectionSnapshot.source.length }),
    contentRevision: itemContentRevision(item, status, projection),
    estimatedRows: 1,
  })
}

/**
 * Builds the Stage 2 pass-through block plan from canonical chronology.
 * Activity blocks deliberately have no source span and therefore no logical
 * transcript target.
 */
export function buildTranscriptBlocks(input: BuildTranscriptBlocksInput): readonly TranscriptBlock[] {
  const { conversation, transcript } = input
  const excluded = input.excludedTurnIds instanceof Set
    ? input.excludedTurnIds
    : new Set(input.excludedTurnIds ?? [])
  const semanticItems = new Set(transcript.order)
  const blocks: TranscriptBlock[] = []

  for (const turnId of conversation.turnIds) {
    if (excluded.has(turnId)) continue
    const turn = conversation.turns[turnId]
    if (!turn) continue

    for (const itemId of turn.itemIds) {
      if (!semanticItems.has(itemId)) continue
      const block = buildTranscriptItemBlock(input, itemId)
      if (block) blocks.push(block)
    }

    if (hasTurnActivity(turn)) {
      blocks.push(Object.freeze({
        key: Object.freeze({ kind: "turn-activity" as const, turnId }),
        turn: snapshotTurn(turn),
        contentRevision: turnActivityRevision(turn),
        estimatedRows: 2,
      }))
    }
  }

  return Object.freeze(blocks)
}

/** Stage 2 materializes every planned block; Stage 5 replaces this policy. */
export function passThroughWindow(blocks: readonly TranscriptBlock[], state: TranscriptState, prior?: TranscriptWindow): TranscriptWindow {
  return windowWithActivityPlan(blocks, activityBatches(blocks, prior?.activityBatches), state, prior)
}

/** Preserve a settled activity plan during O(changed-item) reconciliation. */
export function passThroughWindowWithActivityPlan(blocks: readonly TranscriptBlock[], prior: TranscriptWindow, state: TranscriptState): TranscriptWindow {
  return windowWithActivityPlan(blocks, prior.activityBatches, state, prior)
}

export function blockKey(block: TranscriptBlock): string {
  return block.key.kind === "item"
    ? `item:${block.key.itemId}:${block.key.blockId}`
    : `turn-activity:${block.key.turnId}`
}

/** Inclusive/exclusive logical grapheme range addressed by an item render block. */
export function blockGraphemeRange(block: TranscriptItemBlock): Readonly<{ from: number; to: number }> {
  const spans = block.projection.sourceSpans
  let from = spans.findIndex(span => span.to > block.sourceSpan.from)
  if (from < 0) from = spans.length
  let to = spans.findLastIndex(span => span.from < block.sourceSpan.to)
  if (to < 0) to = from
  else to += 1
  return Object.freeze({ from, to })
}

/** Source-less activity decoration can never satisfy a logical item target. */
export function pointIsMaterialized(blocks: readonly TranscriptBlock[], point: LogicalPoint): boolean {
  if (!Number.isInteger(point.graphemeOffset) || point.graphemeOffset < 0) return false
  return blocks.some(block => {
    if (!("projection" in block) || block.key.itemId !== point.itemId || point.graphemeOffset > block.projection.sourceSpans.length) return false
    const sourceOffset = block.projection.sourceSpans[point.graphemeOffset]?.from ?? block.projection.source.length
    const ownsEnd = block.sourceSpan.to === block.projection.source.length
    return sourceOffset >= block.sourceSpan.from
      && (sourceOffset < block.sourceSpan.to || (ownsEnd && sourceOffset === block.sourceSpan.to))
  })
}
