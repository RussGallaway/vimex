import { effectiveItemStatus, type ConversationItem, type ConversationState, type ItemId, type ItemStatus, type Turn, type TurnId } from "@vimex/conversation"
import type { LogicalPoint, SourceSpan, TextProjection, TranscriptState } from "./domain/transcript-document"
import type { TranscriptHeightIndex } from "./height-index"

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
  /** Complete-plan adjacency; native height must not depend on a window boundary. */
  readonly followedByActivity: boolean
}

export interface TranscriptTurnActivityBlock {
  readonly key: Readonly<{ kind: "turn-activity"; turnId: TurnId }>
  readonly turn: Turn
  readonly sourceSpan?: undefined
  readonly contentRevision: number
  readonly estimatedRows: number
}

export type TranscriptBlock = TranscriptItemBlock | TranscriptTurnActivityBlock

export interface TranscriptWindow {
  readonly blocks: readonly TranscriptBlock[]
  readonly topSpacerRows: number
  readonly bottomSpacerRows: number
  readonly overscanRows: number
}

export type TranscriptWindowAttachment =
  | Readonly<{ kind: "tail" }>
  | Readonly<{
      kind: "point"
      point: LogicalPoint
      preferredScreenRow: number
      /** Disposable measured row within the owning render block. */
      blockLocalRow?: number
    }>

/** Optional deterministic counters for target-resolution tests and diagnostics. */
export interface TranscriptWindowDiagnostics {
  targetLookupVisits: number
}

export interface PlanTranscriptWindowInput {
  readonly blocks: readonly TranscriptBlock[]
  readonly heights: TranscriptHeightIndex
  readonly viewportRows: number
  readonly overscanRows: number
  readonly attachment: TranscriptWindowAttachment
  /** A one-shot target takes planning focus when it is outside the ordinary window. */
  readonly reveal?: LogicalPoint
  readonly diagnostics?: TranscriptWindowDiagnostics
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
const itemRevisions = new WeakMap<ConversationItem, Map<string, WeakMap<TextProjection, number>>>()
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

function itemContentRevision(sourceItem: ConversationItem, status: ItemStatus, sourceProjection: TextProjection, followedByActivity: boolean): number {
  let byStatus = itemRevisions.get(sourceItem)
  if (!byStatus) {
    byStatus = new Map()
    itemRevisions.set(sourceItem, byStatus)
  }
  const presentation = `${status}:${followedByActivity ? 1 : 0}`
  let byProjection = byStatus.get(presentation)
  if (!byProjection) {
    byProjection = new WeakMap()
    byStatus.set(presentation, byProjection)
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

function buildItemBlock(
  input: Pick<BuildTranscriptBlocksInput, "conversation" | "transcript">,
  itemId: ItemId,
  followedByActivity: boolean,
): TranscriptItemBlock | undefined {
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
    contentRevision: itemContentRevision(item, status, projection, followedByActivity),
    estimatedRows: 1,
    followedByActivity,
  })
}

/** Builds the Stage 2 root block for one known semantic item. */
export function buildTranscriptItemBlock(input: Pick<BuildTranscriptBlocksInput, "conversation" | "transcript">, itemId: ItemId): TranscriptItemBlock | undefined {
  const item = input.conversation.items[itemId]
  const turn = item && input.conversation.turns[item.turnId]
  const lastSemanticItemId = turn?.itemIds.findLast(candidate => Boolean(
    input.conversation.items[candidate] && input.transcript.projectionById[candidate],
  ))
  return buildItemBlock(input, itemId, Boolean(turn && lastSemanticItemId === itemId && hasTurnActivity(turn)))
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
    const followedItemId = hasTurnActivity(turn)
      ? turn.itemIds.findLast(itemId => semanticItems.has(itemId)
        && Boolean(conversation.items[itemId] && transcript.projectionById[itemId]))
      : undefined

    for (const itemId of turn.itemIds) {
      if (!semanticItems.has(itemId)) continue
      const block = buildItemBlock(input, itemId, itemId === followedItemId)
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
export function passThroughWindow(blocks: readonly TranscriptBlock[]): TranscriptWindow {
  return Object.freeze({ blocks, topSpacerRows: 0, bottomSpacerRows: 0, overscanRows: 0 })
}

function validPlannerCount(value: number, positive = false): boolean {
  return Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum))
}

function targetLookupVisit(diagnostics: TranscriptWindowDiagnostics | undefined): void {
  if (diagnostics) diagnostics.targetLookupVisits += 1
}

/** Resolve one logical point without consulting native nodes or terminal coordinates. */
export function transcriptPointBlockIndex(
  blocks: readonly TranscriptBlock[],
  heights: TranscriptHeightIndex,
  point: LogicalPoint,
  diagnostics: TranscriptWindowDiagnostics | undefined,
): number | undefined {
  if (!Number.isInteger(point.graphemeOffset) || point.graphemeOffset < 0) return undefined

  targetLookupVisit(diagnostics)
  const itemIndexes = heights.itemBlockIndexes(point.itemId)
  if (!itemIndexes?.length) return undefined
  const first = blocks[itemIndexes[0]!]
  targetLookupVisit(diagnostics)
  if (!first || !("projection" in first) || first.key.itemId !== point.itemId
    || point.graphemeOffset > first.projection.sourceSpans.length) return undefined
  const sourceOffset = first.projection.sourceSpans[point.graphemeOffset]?.from ?? first.projection.source.length

  // Item block ordinals are ordered by non-overlapping source-span starts. The
  // last start at or before the target owns a boundary, subject to the final
  // materialization check for gaps and the item-end point.
  let low = 0
  let high = itemIndexes.length
  while (low < high) {
    const middle = low + ((high - low) >>> 1)
    const block = blocks[itemIndexes[middle]!]
    targetLookupVisit(diagnostics)
    if (!block || !("projection" in block) || block.key.itemId !== point.itemId) return undefined
    if (block.sourceSpan.from <= sourceOffset) low = middle + 1
    else high = middle
  }
  if (low === 0) return undefined
  const blockIndex = itemIndexes[low - 1]!
  const block = blocks[blockIndex]
  targetLookupVisit(diagnostics)
  return block && pointIsMaterialized([block], point) ? blockIndex : undefined
}

/**
 * Pure renderer-neutral window planner. Unknown or internally inconsistent
 * relationships take the exact pass-through path rather than guessing.
 */
export function planTranscriptWindow(input: PlanTranscriptWindowInput): TranscriptWindow {
  const { blocks, heights } = input
  if (blocks.length === 0) return Object.freeze({ blocks: Object.freeze([]), topSpacerRows: 0, bottomSpacerRows: 0, overscanRows: 0 })
  if (!validPlannerCount(input.viewportRows, true) || !validPlannerCount(input.overscanRows)
    || !heights.supports(blocks) || heights.blockCount !== blocks.length
    || !validPlannerCount(heights.totalRows, true)) return passThroughWindow(blocks)

  let focusIndex: number | undefined
  let preferredScreenRow = 0
  if (input.attachment.kind === "point") {
    if (!Number.isSafeInteger(input.attachment.preferredScreenRow)
      || (input.attachment.blockLocalRow !== undefined
        && (!Number.isSafeInteger(input.attachment.blockLocalRow) || input.attachment.blockLocalRow < 0))) return passThroughWindow(blocks)
    focusIndex = transcriptPointBlockIndex(blocks, heights, input.attachment.point, input.diagnostics)
    if (focusIndex === undefined) return passThroughWindow(blocks)
    preferredScreenRow = clamp(input.attachment.preferredScreenRow, 0, input.viewportRows - 1)
  }

  const maximumVisibleStart = Math.max(0, heights.totalRows - input.viewportRows)
  const focusRange = input.attachment.kind === "point" ? heights.rowRange(focusIndex!, focusIndex! + 1) : undefined
  if (input.attachment.kind === "point" && !focusRange) return passThroughWindow(blocks)
  const blockLocalRow = input.attachment.kind === "point"
    ? clamp(input.attachment.blockLocalRow ?? 0, 0, Math.max(0, focusRange!.rows - 1)) : 0
  let visibleStart = input.attachment.kind === "tail"
    ? maximumVisibleStart
    : clamp(focusRange!.start + blockLocalRow - Math.min(preferredScreenRow, input.viewportRows - 1), 0, maximumVisibleStart)
  let visibleEnd = Math.min(heights.totalRows, visibleStart + input.viewportRows)
  let plannedFrom = Math.max(0, visibleStart - input.overscanRows)
  let plannedTo = input.attachment.kind === "tail"
    ? heights.totalRows
    : Math.min(heights.totalRows, visibleEnd + input.overscanRows)

  if (input.reveal) {
    const revealIndex = transcriptPointBlockIndex(blocks, heights, input.reveal, input.diagnostics)
    if (revealIndex === undefined) return passThroughWindow(blocks)
    const revealRange = heights.rowRange(revealIndex, revealIndex + 1)
    if (!revealRange) return passThroughWindow(blocks)
    const alreadyPlanned = revealRange.end > plannedFrom && revealRange.start < plannedTo
    if (!alreadyPlanned) {
      preferredScreenRow = Math.floor((input.viewportRows - 1) / 2)
      visibleStart = clamp(revealRange.start - preferredScreenRow, 0, maximumVisibleStart)
      visibleEnd = Math.min(heights.totalRows, visibleStart + input.viewportRows)
      plannedFrom = Math.max(0, visibleStart - input.overscanRows)
      plannedTo = Math.min(heights.totalRows, visibleEnd + input.overscanRows)
    }
  }

  const first = heights.blockAtRow(plannedFrom)
  if (first === undefined || first < 0 || first >= blocks.length) return passThroughWindow(blocks)
  let lastExclusive: number
  if (plannedTo >= heights.totalRows) lastExclusive = blocks.length
  else {
    const atEnd = heights.blockAtRow(plannedTo)
    if (atEnd === undefined || atEnd < first || atEnd >= blocks.length) return passThroughWindow(blocks)
    lastExclusive = heights.prefixRows(atEnd) === plannedTo ? atEnd : atEnd + 1
  }
  if (lastExclusive <= first) return passThroughWindow(blocks)

  const topSpacerRows = heights.prefixRows(first)
  const bottomSpacerRows = heights.totalRows - heights.prefixRows(lastExclusive)
  if (!validPlannerCount(topSpacerRows) || !validPlannerCount(bottomSpacerRows)
    || topSpacerRows + (heights.prefixRows(lastExclusive) - topSpacerRows) + bottomSpacerRows !== heights.totalRows) {
    return passThroughWindow(blocks)
  }
  const windowBlocks = Object.freeze(blocks.slice(first, lastExclusive))
  if (input.reveal && !pointIsMaterialized(windowBlocks, input.reveal)) return passThroughWindow(blocks)
  if (!input.reveal && input.attachment.kind === "point" && !pointIsMaterialized(windowBlocks, input.attachment.point)) return passThroughWindow(blocks)
  return Object.freeze({ blocks: windowBlocks, topSpacerRows, bottomSpacerRows, overscanRows: input.overscanRows })
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
