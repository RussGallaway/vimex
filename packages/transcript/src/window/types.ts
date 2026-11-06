import type {
  ConversationItem,
  ConversationState,
  ItemId,
  ThreadId,
  Turn,
  TurnId,
} from "@vimex/conversation"
import type {
  LogicalPoint,
  SourceSpan,
  TextProjection,
  TranscriptState,
} from "../domain/transcript-document"
import type { TranscriptHeightIndex } from "../height-index"

/** Published render plans never expose mutable canonical objects. */
export type Immutable<T> = T extends
  string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends readonly (infer Element)[]
    ? readonly Immutable<Element>[]
    : T extends object
      ? { readonly [Key in keyof T]: Immutable<T[Key]> }
      : T

export type TranscriptBlockItem = Immutable<ConversationItem>
export type TranscriptBlockProjection = Immutable<TextProjection>

export interface TranscriptItemFragment {
  readonly kind:
    | "command-header"
    | "command-output"
    | "markdown"
    | "edit-header"
    | "edit-file"
  readonly index: number
  readonly count: number
}

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
  /** Disposable render-fragment role; semantic positions never contain it. */
  readonly fragment?: TranscriptItemFragment
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

export type TranscriptActivityFamily = "web-research" | "read" | "provider"

export interface TranscriptActivityBatch {
  readonly key: string
  readonly turnId: TurnId
  readonly family: TranscriptActivityFamily
  readonly label: string
  readonly countLabel: string
  readonly leadItemId: ItemId
  readonly itemIds: readonly ItemId[]
  readonly blockKeys: readonly string[]
  readonly blockItemIds: readonly ItemId[]
  readonly leadGraphemeFrom: number
  readonly leadGraphemeTo: number
  readonly leadIncludesEnd: boolean
  readonly durationMs?: number
  readonly followedByActivity?: boolean
}

export type TranscriptBlockPresentation =
  "item" | "activity-lead" | "activity-hidden"

export interface TranscriptActivityPresentation {
  readonly kind: Exclude<TranscriptBlockPresentation, "item">
  readonly batch: TranscriptActivityBatch
  readonly itemId: ItemId
}

export interface TranscriptBlockPlanDiagnostics {
  blockPlanUpdates: number
  /** Validation plus persistent-tree work for updates; ordinary reads are outside this counter. */
  blockPlanNodeVisits: number
  blockPlanNodesCopied: number
}

export interface TranscriptWindow {
  readonly blocks: readonly TranscriptBlock[]
  readonly activityBatches: readonly TranscriptActivityBatch[]
  readonly activityBatchByItem: Readonly<
    Record<string, TranscriptActivityBatch>
  >
  readonly activityPresentation: Readonly<
    Record<string, TranscriptActivityPresentation>
  >
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
  readonly state?: TranscriptState
  readonly prior?: TranscriptWindow
  /** Complete activity relationships prepared by the runtime before height planning. */
  readonly activityPlan?: TranscriptWindow
  readonly heights: TranscriptHeightIndex
  readonly viewportRows: number
  readonly overscanRows: number
  /** Shared block budget kept mounted near either transcript edge. */
  readonly recentTailBlocks?: number
  /** Shared indexed-row budget for either edge; an individual block stays whole. */
  readonly recentTailRows?: number
  /** Indexed rows prepared beyond either edge area's inward boundary. */
  readonly olderLookAheadRows?: number
  /** Use the edge-sized budget everywhere, retaining covered native ranges. */
  readonly retainWindow?: boolean
  readonly retainedWindow?: TranscriptWindow
  readonly attachment: TranscriptWindowAttachment
  /** A one-shot target takes planning focus when it is outside the ordinary window. */
  readonly reveal?: LogicalPoint
  readonly diagnostics?: TranscriptWindowDiagnostics
}

export interface BuildTranscriptBlocksInput {
  readonly conversation: ConversationState
  readonly transcript: TranscriptState
  readonly excludedTurnIds?: readonly TurnId[] | ReadonlySet<TurnId>
  /** Presentation lineage; cached render-block identity never crosses a reset. */
  readonly canonicalGeneration?: number
  readonly threadId?: ThreadId
}
