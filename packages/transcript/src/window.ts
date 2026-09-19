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
  /** Render-ready payload for sourceSpan. Stage 2 publishes the complete item. */
  readonly item: TranscriptBlockItem
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

export interface TranscriptWindow {
  readonly blocks: readonly TranscriptBlock[]
  readonly topSpacerRows: number
  readonly bottomSpacerRows: number
  readonly overscanRows: number
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
        estimatedRows: 1,
      }))
    }
  }

  return Object.freeze(blocks)
}

/** Stage 2 materializes every planned block; Stage 5 replaces this policy. */
export function passThroughWindow(blocks: readonly TranscriptBlock[]): TranscriptWindow {
  return Object.freeze({ blocks, topSpacerRows: 0, bottomSpacerRows: 0, overscanRows: 0 })
}

export function blockKey(block: TranscriptBlock): string {
  return block.key.kind === "item"
    ? `item:${block.key.itemId}:${block.key.blockId}`
    : `turn-activity:${block.key.turnId}`
}

/** Source-less activity decoration can never satisfy a logical item target. */
export function pointIsMaterialized(blocks: readonly TranscriptBlock[], point: LogicalPoint): boolean {
  if (!Number.isInteger(point.graphemeOffset) || point.graphemeOffset < 0) return false
  return blocks.some(block => {
    if (!("projection" in block) || block.key.itemId !== point.itemId || point.graphemeOffset > block.projection.sourceSpans.length) return false
    const sourceOffset = block.projection.sourceSpans[point.graphemeOffset]?.from ?? block.projection.source.length
    return sourceOffset >= block.sourceSpan.from && sourceOffset <= block.sourceSpan.to
  })
}
