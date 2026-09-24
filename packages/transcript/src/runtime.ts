import {
  isConversationItemAddition,
  isConversationTurnAdditionThenItemAppend,
  isConversationTurnIdAppend,
  isConversationTurnUpdate,
  isTurnItemIdAppend,
  type ConversationState,
  type ItemId,
  type ThreadId,
  type TurnId,
} from "@vimex/conversation"
import {
  appendTranscriptOrder,
  inheritTranscriptTextLengthIndex,
  inheritTranscriptTextLengthIndexChanges,
  isTranscriptFoldAddition,
  isTranscriptProjectionAddition,
  persistentTranscriptFolds,
  persistentTranscriptOrder,
  persistentTranscriptProjections,
  persistentTranscriptUnseenItemIds,
  setTranscriptProjection,
  singleTranscriptFoldChange,
  transcriptOrderAppend,
  transcriptOrderIndex,
  transcriptTextLengthRange,
  type LogicalPoint,
  type TranscriptOrderIndexDiagnostics,
  type TranscriptProjectionRecordDiagnostics,
  type TranscriptState,
  type TranscriptTextLengthIndexDiagnostics,
} from "./domain/transcript-document"
import {
  composeTranscriptGeometry,
  composeTranscriptWindowGeometry,
  emptyTranscriptGeometry,
  freezeBlockGeometry,
  geometryMatchesBlock,
  type BlockGeometry,
  type BlockMeasurementBase,
  type BlockMeasurementBatch,
  type LayoutResetReason,
  type TranscriptGeometry,
} from "./geometry"
import { createHeightIndex, type TranscriptHeightIndex } from "./height-index"
import {
  inheritTranscriptUrlIndex,
  inheritTranscriptUrlIndexChanges,
  primeTranscriptUrlIndex,
  type TranscriptUrlIndexDiagnostics,
} from "./application/transcript-url-index"
import {
  appendTranscriptBlock,
  blockKey,
  blockGraphemeRange,
  buildTranscriptBlocks,
  buildTranscriptItemBlock,
  buildTranscriptItemBlocks,
  buildTranscriptTurnActivityBlock,
  passThroughWindow,
  passThroughWindowWithActivityPlan,
  persistentTranscriptBlockPlan,
  planTranscriptWindow,
  pointIsMaterialized,
  replaceTranscriptBlock,
  spliceTranscriptItemBlocks,
  transcriptPointBlockIndex,
  type TranscriptActivityPresentation,
  type TranscriptBlock,
  type TranscriptBlockPlanDiagnostics,
  type TranscriptItemBlock,
  type TranscriptWindow,
} from "./window"

export type TranscriptDamage =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "blocks"; itemIds: readonly ItemId[] }>
  | Readonly<{ kind: "folds"; itemIds: readonly ItemId[] }>
  | Readonly<{ kind: "view" }>
  | Readonly<{ kind: "layout" }>
  | Readonly<{ kind: "full" }>

export interface TranscriptRevealRequest {
  readonly id: number
  readonly point: LogicalPoint
  readonly reason:
    "cursor" | "search" | "mark" | "jump" | "url" | "history" | "thread"
}

export interface TranscriptRuntimeInput {
  readonly threadId: ThreadId
  /** Distinguishes authoritative rebuilds that reuse the same thread id. */
  readonly canonicalGeneration: number
  readonly canonicalRevision: number
  readonly conversation: ConversationState
  readonly transcript: TranscriptState
  /** Presentation attachment, supplied explicitly by the Workbench owner. */
  readonly mode: "follow" | "detached"
  readonly canonicalDamage?: TranscriptDamage
  readonly presentationDamage?: TranscriptDamage
  /** One-shot explicit navigation intent; never inferred from canonical reprojection. */
  readonly reveal?: TranscriptRevealRequest
  readonly excludedTurnIds?: readonly TurnId[]
}

export interface TranscriptFrame {
  readonly threadId: ThreadId
  readonly canonicalGeneration: number
  /** Canonical revision represented by blocks, not the latest hidden revision. */
  readonly displayedCanonicalRevision: number
  readonly presentationRevision: number
  readonly mode: "follow" | "detached"
  /** Display-safe semantic projection over the selected block revision. */
  readonly transcript: TranscriptState
  readonly blocks: readonly TranscriptBlock[]
  readonly window: TranscriptWindow
  /** Renderer-neutral, immutable block-local geometry for this presentation. */
  readonly geometry: TranscriptGeometry
  readonly damage: TranscriptDamage
}

export interface TranscriptWindowPolicy {
  readonly viewportRows: number
  readonly overscanRows: number
  /** Upper bound for the recent mounted area while reading near the tail. */
  readonly recentTailBlocks?: number
  /** Indexed row budget; native measurements may refine earlier estimates. */
  readonly recentTailRows?: number
}

export interface TranscriptRuntimeOptions {
  /** Omit only for inert/test consumers that intentionally retain pass-through materialization. */
  readonly windowPolicy?: TranscriptWindowPolicy
  /** Mutable deterministic counters for tests and diagnostic benchmarks. */
  readonly diagnostics?: TranscriptRuntimeDiagnostics
}

export interface TranscriptRuntimeDiagnostics
  extends
    TranscriptOrderIndexDiagnostics,
    TranscriptTextLengthIndexDiagnostics,
    TranscriptUrlIndexDiagnostics,
    TranscriptProjectionRecordDiagnostics,
    TranscriptBlockPlanDiagnostics {
  completePlanBuilds: number
  completePlanBlockVisits: number
  heightIndexBuilds: number
  heightIndexBlockVisits: number
  heightIndexUpdates: number
  heightIndexNodeVisits: number
  heightIndexNodesCopied: number
  completeGeometryBlockVisits: number
  windowGeometryBlockVisits: number
  blockPlanWindowSliceItems: number
  changedItemBuilds: number
  hiddenDamageMerges?: number
  hiddenDamageInputItemVisits?: number
  hiddenDamageItemAdditions?: number
  hiddenDamageSnapshots?: number
  hiddenDamageSnapshotItemVisits?: number
}

export const defaultTranscriptWindowPolicy: TranscriptWindowPolicy =
  Object.freeze({
    viewportRows: 24,
    overscanRows: 24,
    recentTailBlocks: 100,
    recentTailRows: 240,
  })

const noneDamage = Object.freeze({ kind: "none" } as const)
const fullDamage = Object.freeze({ kind: "full" } as const)

function frozenDamage(damage: TranscriptDamage | undefined): TranscriptDamage {
  if (!damage || damage.kind === "none") return noneDamage
  if (damage.kind !== "blocks" && damage.kind !== "folds")
    return Object.freeze({ kind: damage.kind })
  return Object.freeze({
    kind: damage.kind,
    itemIds: Object.freeze([...new Set(damage.itemIds)]),
  })
}

function mergeDamage(
  left: TranscriptDamage,
  right: TranscriptDamage,
): TranscriptDamage {
  if (left.kind === "full" || right.kind === "full") return fullDamage
  if (left.kind === "layout" || right.kind === "layout")
    return Object.freeze({ kind: "layout" })
  if (left.kind === "folds" && right.kind === "folds")
    return frozenDamage({
      kind: "folds",
      itemIds: [...left.itemIds, ...right.itemIds],
    })
  if (left.kind === "folds" || right.kind === "folds") {
    const foldDamage = left.kind === "folds" ? left : right
    const other = left.kind === "folds" ? right : left
    return other.kind === "none" || other.kind === "view"
      ? foldDamage
      : Object.freeze({ kind: "layout" })
  }
  if (left.kind === "view" || right.kind === "view")
    return Object.freeze({ kind: "view" })
  if (left.kind === "blocks" || right.kind === "blocks") {
    const ids = [
      ...(left.kind === "blocks" ? left.itemIds : []),
      ...(right.kind === "blocks" ? right.itemIds : []),
    ]
    return frozenDamage({ kind: "blocks", itemIds: ids })
  }
  return noneDamage
}

class HiddenDamageAccumulator {
  private kind: TranscriptDamage["kind"] = "none"
  private readonly itemIds = new Set<ItemId>()

  add(
    damage: TranscriptDamage,
    diagnostics?: TranscriptRuntimeDiagnostics,
  ): void {
    if (diagnostics)
      diagnostics.hiddenDamageMerges = (diagnostics.hiddenDamageMerges ?? 0) + 1
    if (damage.kind === "none") return
    if (this.kind === "none") {
      this.kind = damage.kind
      this.itemIds.clear()
      this.addItemIds(damage, diagnostics)
      return
    }
    if (this.kind === "full" || damage.kind === "full")
      return this.setScalar("full")
    if (this.kind === "layout" || damage.kind === "layout")
      return this.setScalar("layout")
    if (this.kind === "folds" || damage.kind === "folds") {
      if (this.kind === "folds" && damage.kind === "folds") {
        this.addItemIds(damage, diagnostics)
        return
      }
      const otherKind = this.kind === "folds" ? damage.kind : this.kind
      if (otherKind === "view") {
        if (damage.kind === "folds") {
          this.itemIds.clear()
          this.addItemIds(damage, diagnostics)
        }
        this.kind = "folds"
        return
      }
      return this.setScalar("layout")
    }
    if (this.kind === "view" || damage.kind === "view")
      return this.setScalar("view")
    this.kind = "blocks"
    this.addItemIds(damage, diagnostics)
  }

  snapshot(diagnostics?: TranscriptRuntimeDiagnostics): TranscriptDamage {
    if (diagnostics)
      diagnostics.hiddenDamageSnapshots =
        (diagnostics.hiddenDamageSnapshots ?? 0) + 1
    if (this.kind !== "blocks" && this.kind !== "folds")
      return this.kind === "none"
        ? noneDamage
        : (Object.freeze({ kind: this.kind }) as TranscriptDamage)
    const itemIds = Object.freeze([...this.itemIds])
    if (diagnostics)
      diagnostics.hiddenDamageSnapshotItemVisits =
        (diagnostics.hiddenDamageSnapshotItemVisits ?? 0) + itemIds.length
    return Object.freeze({ kind: this.kind, itemIds })
  }

  reset(): void {
    this.kind = "none"
    this.itemIds.clear()
  }

  private setScalar(kind: "view" | "layout" | "full"): void {
    this.kind = kind
    this.itemIds.clear()
  }

  private addItemIds(
    damage: TranscriptDamage,
    diagnostics?: TranscriptRuntimeDiagnostics,
  ): void {
    if (damage.kind !== "blocks" && damage.kind !== "folds") return
    for (const itemId of damage.itemIds) {
      if (diagnostics)
        diagnostics.hiddenDamageInputItemVisits =
          (diagnostics.hiddenDamageInputItemVisits ?? 0) + 1
      const size = this.itemIds.size
      this.itemIds.add(itemId)
      if (diagnostics && this.itemIds.size !== size)
        diagnostics.hiddenDamageItemAdditions =
          (diagnostics.hiddenDamageItemAdditions ?? 0) + 1
    }
  }
}

function blockDamageIds(
  ...damage: readonly TranscriptDamage[]
): readonly ItemId[] | undefined {
  const ids = new Set<ItemId>()
  let explicit = false
  for (const entry of damage) {
    if (entry.kind === "none") continue
    if (entry.kind !== "blocks") return undefined
    explicit = true
    for (const id of entry.itemIds) ids.add(id)
  }
  return explicit ? [...ids] : undefined
}

function sameList<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): boolean {
  if (left === right) return true
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false
  return (left ?? []).every((value, index) => value === right?.[index])
}

function shallowRecordEqual(left: object, right: object): boolean {
  if (left === right) return true
  const leftEntries = Object.entries(left),
    rightEntries = Object.entries(right)
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) =>
      Object.is(value, (right as Record<string, unknown>)[key]),
    )
  )
}

function sameActivityProtection(
  left: TranscriptState,
  right: TranscriptState,
  window: TranscriptWindow,
): boolean {
  const protectedMember = (point: LogicalPoint | undefined) => {
    const batch = point ? window.activityBatchByItem[point.itemId] : undefined
    if (!point || !batch) return undefined
    const outsideLead =
      point.itemId === batch.leadItemId &&
      (point.graphemeOffset < batch.leadGraphemeFrom ||
        point.graphemeOffset > batch.leadGraphemeTo ||
        (point.graphemeOffset === batch.leadGraphemeTo &&
          !batch.leadIncludesEnd))
    return point.itemId !== batch.leadItemId || outsideLead
      ? batch.key
      : undefined
  }
  return (
    left.folded === right.folded &&
    protectedMember(left.cursor) === protectedMember(right.cursor) &&
    protectedMember(
      left.viewport.kind === "tail" ? undefined : left.viewport.point,
    ) ===
      protectedMember(
        right.viewport.kind === "tail" ? undefined : right.viewport.point,
      ) &&
    protectedMember(left.selection?.anchor) ===
      protectedMember(right.selection?.anchor) &&
    protectedMember(left.selection?.head) ===
      protectedMember(right.selection?.head)
  )
}

function changedActivityPresentationIds(
  left: Readonly<Record<string, TranscriptActivityPresentation>>,
  right: Readonly<Record<string, TranscriptActivityPresentation>>,
): readonly ItemId[] {
  if (left === right) return []
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  const ids = new Set<ItemId>()
  for (const key of keys) {
    if (left[key]?.kind === right[key]?.kind) continue
    const itemId = right[key]?.itemId ?? left[key]?.itemId
    if (itemId) ids.add(itemId)
  }
  return [...ids]
}

function damageWithActivityChanges(
  damage: TranscriptDamage,
  itemIds: readonly ItemId[],
): TranscriptDamage {
  if (!itemIds.length || damage.kind === "full" || damage.kind === "layout")
    return frozenDamage(damage)
  const prior = damage.kind === "blocks" ? damage.itemIds : []
  return frozenDamage({ kind: "blocks", itemIds: [...prior, ...itemIds] })
}

function activityTopologyChanged(
  left: TranscriptBlock | undefined,
  right: TranscriptItemBlock | undefined,
): boolean {
  if (!left || !("item" in left) || !right) return true
  const a = left.item,
    b = right.item
  const relevant =
    ((a.kind === "command" || a.kind === "tool") && a.activity) ||
    ((b.kind === "command" || b.kind === "tool") && b.activity)
  if (!relevant) return false
  if (
    (a.kind !== "command" && a.kind !== "tool") ||
    (b.kind !== "command" && b.kind !== "tool")
  )
    return true
  return (
    a.status !== b.status ||
    a.durationMs !== b.durationMs ||
    a.activity?.family !== b.activity?.family ||
    a.activity?.label !== b.activity?.label
  )
}

function sameBlock(left: TranscriptBlock, right: TranscriptBlock): boolean {
  if (
    left.key.kind !== right.key.kind ||
    blockKey(left) !== blockKey(right) ||
    left.contentRevision !== right.contentRevision
  )
    return false
  if (left.estimatedRows !== right.estimatedRows) return false
  if ("projection" in left && "projection" in right)
    return (
      left.turnId === right.turnId &&
      left.projection === right.projection &&
      left.sourceSpan.from === right.sourceSpan.from &&
      left.sourceSpan.to === right.sourceSpan.to &&
      left.fragment?.kind === right.fragment?.kind &&
      left.fragment?.index === right.fragment?.index &&
      left.fragment?.count === right.fragment?.count &&
      left.followedByActivity === right.followedByActivity &&
      shallowRecordEqual(left.item, right.item) &&
      shallowRecordEqual(left.renderItem, right.renderItem)
    )
  if (!("turn" in left) || !("turn" in right)) return false
  return (
    left.turn.status === right.turn.status &&
    left.turn.startedAt === right.turn.startedAt &&
    left.turn.completedAt === right.turn.completedAt &&
    left.turn.durationMs === right.turn.durationMs
  )
}

function sameWindow(left: TranscriptWindow, right: TranscriptWindow): boolean {
  return (
    left === right ||
    (left.topSpacerRows === right.topSpacerRows &&
      left.bottomSpacerRows === right.bottomSpacerRows &&
      left.overscanRows === right.overscanRows &&
      left.activityPresentation === right.activityPresentation &&
      left.blocks.length === right.blocks.length &&
      left.blocks.every((block, index) => block === right.blocks[index]))
  )
}

function reconcileBlocks(
  previous: readonly TranscriptBlock[],
  next: readonly TranscriptBlock[],
): readonly TranscriptBlock[] {
  const byKey = new Map(previous.map((block) => [blockKey(block), block]))
  let changed = previous.length !== next.length
  const reconciled = next.map((block, index) => {
    const prior = byKey.get(blockKey(block))
    if (prior && sameBlock(prior, block)) {
      if (previous[index] !== prior) changed = true
      return prior
    }
    changed = true
    return block
  })
  return changed ? Object.freeze(reconciled) : previous
}

function itemBlocks(
  blocks: readonly TranscriptBlock[],
): readonly TranscriptItemBlock[] {
  return blocks.filter(
    (block): block is TranscriptItemBlock => "projection" in block,
  )
}

function sourceOffset(
  projection: TranscriptItemBlock["projection"],
  offset: number,
): number {
  return projection.sourceSpans[offset]?.from ?? projection.source.length
}

function mapPoint(
  state: TranscriptState,
  projections: Readonly<Record<string, TranscriptItemBlock["projection"]>>,
  point: LogicalPoint,
): LogicalPoint | undefined {
  const latest = state.projectionById[point.itemId],
    displayed = projections[point.itemId]
  if (!latest || !displayed) return undefined
  const offset = sourceOffset(latest, point.graphemeOffset)
  let low = 0,
    high = displayed.sourceSpans.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (displayed.sourceSpans[middle]!.to > offset) high = middle
    else low = middle + 1
  }
  return { itemId: point.itemId, graphemeOffset: low }
}

function presentationTranscriptWithProjections(
  state: TranscriptState,
  order: readonly ItemId[],
  projectionById: Readonly<Record<string, TranscriptItemBlock["projection"]>>,
): TranscriptState {
  const point = (value: LogicalPoint | undefined) =>
    value ? mapPoint(state, projectionById, value) : undefined
  const location = (value: {
    point: LogicalPoint
    preferredScreenRow: number
  }) => {
    const mapped = point(value.point)
    return mapped ? Object.freeze({ ...value, point: mapped }) : undefined
  }
  const cursor = point(state.cursor)
  const selectionAnchor = point(state.selection?.anchor),
    selectionHead = point(state.selection?.head)
  const viewportPoint =
    state.viewport.kind === "point" ? point(state.viewport.point) : undefined
  const jumps = Object.freeze({
    back: Object.freeze(
      state.jumps.back.flatMap((value) => location(value) ?? []),
    ),
    forward: Object.freeze(
      state.jumps.forward.flatMap((value) => location(value) ?? []),
    ),
  })
  const marks = Object.freeze(
    Object.fromEntries(
      Object.entries(state.marks).flatMap(([name, value]) => {
        const mapped = location(value)
        return mapped ? [[name, mapped]] : []
      }),
    ),
  )
  const presented = Object.freeze({
    ...state,
    search: state.search && Object.freeze({ ...state.search }),
    order,
    projectionById: persistentTranscriptProjections(projectionById),
    cursor,
    selection:
      state.selection && selectionAnchor && selectionHead
        ? Object.freeze({
            ...state.selection,
            anchor: selectionAnchor,
            head: selectionHead,
          })
        : undefined,
    folded: persistentTranscriptFolds(state.folded),
    viewport:
      state.viewport.kind === "tail" || !viewportPoint
        ? Object.freeze({ kind: "tail" as const })
        : Object.freeze({ ...state.viewport, point: viewportPoint }),
    unseenItemIds: persistentTranscriptUnseenItemIds(state.unseenItemIds),
    jumps,
    marks,
  })
  transcriptOrderIndex(presented.order)
  return presented
}

function presentationTranscript(
  state: TranscriptState,
  blocks: readonly TranscriptBlock[],
): TranscriptState {
  const projections = new Map<ItemId, TranscriptItemBlock["projection"]>()
  for (const block of itemBlocks(blocks))
    if (!projections.has(block.key.itemId))
      projections.set(block.key.itemId, block.projection)
  return presentationTranscriptWithProjections(
    state,
    persistentTranscriptOrder(Object.freeze([...projections.keys()])),
    Object.freeze(Object.fromEntries(projections)),
  )
}

function validReveal(
  input: TranscriptRuntimeInput,
  diagnostics?: TranscriptOrderIndexDiagnostics,
): LogicalPoint | undefined {
  const point = input.reveal?.point
  if (
    !point ||
    !Number.isInteger(point.graphemeOffset) ||
    point.graphemeOffset < 0
  )
    return undefined
  const projection = input.transcript.projectionById[point.itemId]
  if (
    !projection ||
    !transcriptOrderIndex(input.transcript.order, diagnostics).has(
      point.itemId,
    ) ||
    point.graphemeOffset > projection.sourceSpans.length
  )
    return undefined
  return point
}

function displayedReveal(
  input: TranscriptRuntimeInput,
  frame: TranscriptFrame,
  diagnostics?: TranscriptOrderIndexDiagnostics,
): LogicalPoint | undefined {
  const point = validReveal(input, diagnostics)
  return point
    ? mapPoint(input.transcript, frame.transcript.projectionById, point)
    : undefined
}

function reconciledGeometry(
  previous: TranscriptGeometry | undefined,
  input: TranscriptRuntimeInput,
  blocks: readonly TranscriptBlock[],
  window: TranscriptWindow,
  diagnostics?: TranscriptRuntimeDiagnostics,
): TranscriptGeometry {
  if (diagnostics) diagnostics.completeGeometryBlockVisits += blocks.length
  if (!previous)
    return composeTranscriptGeometry(
      blocks,
      input.transcript.folded,
      {},
      0,
      0,
      undefined,
      undefined,
      window.activityPresentation,
    )
  return composeTranscriptGeometry(
    blocks,
    input.transcript.folded,
    previous.byBlockKey,
    previous.generation,
    previous.revision,
    previous.width,
    previous.styleRevision,
    window.activityPresentation,
  )
}

function pointBlockLocalRow(
  blocks: readonly TranscriptBlock[],
  byBlockKey: Readonly<Record<string, BlockGeometry>>,
  point: LogicalPoint,
): number | undefined {
  for (const block of blocks) {
    if (block.key.kind !== "item" || block.key.itemId !== point.itemId) continue
    const geometry = byBlockKey[blockKey(block)]
    const measured =
      geometry?.points[point.graphemeOffset] ??
      (geometry?.key.folded ? Object.values(geometry.points)[0] : undefined)
    if (
      measured &&
      Number.isSafeInteger(measured.row) &&
      measured.row >= 0 &&
      measured.row < geometry!.rows
    )
      return measured.row
  }
  return undefined
}

function frameFor(
  input: TranscriptRuntimeInput,
  blocks: readonly TranscriptBlock[],
  displayedCanonicalRevision: number,
  revision: number,
  damage: TranscriptDamage,
  previousGeometry?: TranscriptGeometry,
  diagnostics?: TranscriptRuntimeDiagnostics,
  persistentPlan = false,
  previousWindow?: TranscriptWindow,
): TranscriptFrame {
  const plan = persistentPlan ? persistentTranscriptBlockPlan(blocks) : blocks
  const transcript = presentationTranscript(input.transcript, plan)
  const window = passThroughWindow(plan, transcript, previousWindow)
  const activityDamage = previousWindow
    ? changedActivityPresentationIds(
        previousWindow.activityPresentation,
        window.activityPresentation,
      )
    : []
  return Object.freeze({
    threadId: input.threadId,
    canonicalGeneration: input.canonicalGeneration,
    displayedCanonicalRevision,
    presentationRevision: revision,
    mode: input.mode,
    transcript,
    blocks: plan,
    window,
    geometry: reconciledGeometry(
      previousGeometry,
      input,
      plan,
      window,
      diagnostics,
    ),
    damage: damageWithActivityChanges(damage, activityDamage),
  })
}

function buildFrame(
  input: TranscriptRuntimeInput,
  previous: TranscriptFrame | undefined,
  revision: number,
  damage: TranscriptDamage,
  diagnostics?: TranscriptRuntimeDiagnostics,
  persistentPlan = false,
): TranscriptFrame {
  const planned = buildTranscriptBlocks({
    conversation: input.conversation,
    transcript: input.transcript,
    excludedTurnIds: input.excludedTurnIds,
    canonicalGeneration: input.canonicalGeneration,
    threadId: input.threadId,
  })
  const blocks = previous ? reconcileBlocks(previous.blocks, planned) : planned
  return frameFor(
    input,
    blocks,
    input.canonicalRevision,
    revision,
    damage,
    previous?.geometry,
    diagnostics,
    persistentPlan,
    previous?.window,
  )
}

function isEmptyTailTurnAdmission(
  previous: TranscriptRuntimeInput,
  next: TranscriptRuntimeInput,
): boolean {
  if (
    previous.transcript !== next.transcript ||
    previous.conversation.items !== next.conversation.items ||
    next.conversation.turnIds.length !==
      previous.conversation.turnIds.length + 1
  )
    return false
  const turnId = next.conversation.turnIds.at(-1)
  const turn = turnId && next.conversation.turns[turnId]
  return Boolean(
    turnId &&
    turn &&
    turn.status === "running" &&
    turn.itemIds.length === 0 &&
    next.conversation.activeTurnId === turnId &&
    isConversationTurnIdAppend(
      previous.conversation.turnIds,
      next.conversation.turnIds,
      turnId,
    ) &&
    isConversationTurnUpdate(
      previous.conversation.turns,
      next.conversation.turns,
      turnId,
      undefined,
      turn,
    ),
  )
}

function tailTurnCompletion(
  previous: TranscriptRuntimeInput,
  next: TranscriptRuntimeInput,
): Readonly<{ turnId: TurnId; itemId?: ItemId }> | undefined {
  if (
    previous.transcript !== next.transcript ||
    previous.conversation.items !== next.conversation.items ||
    previous.conversation.turnIds !== next.conversation.turnIds
  )
    return undefined
  const turnId = previous.conversation.activeTurnId
  if (
    !turnId ||
    previous.conversation.turnIds.at(-1) !== turnId ||
    next.conversation.activeTurnId !== undefined
  )
    return undefined
  const priorTurn = previous.conversation.turns[turnId]
  const nextTurn = next.conversation.turns[turnId]
  if (
    !priorTurn ||
    priorTurn.status !== "running" ||
    !nextTurn ||
    nextTurn.status === "running" ||
    priorTurn.itemIds !== nextTurn.itemIds ||
    priorTurn.itemIds.length > 1 ||
    !isConversationTurnUpdate(
      previous.conversation.turns,
      next.conversation.turns,
      turnId,
      priorTurn,
      nextTurn,
    )
  )
    return undefined
  const itemId = priorTurn.itemIds[0]
  return Object.freeze({ turnId, ...(itemId ? { itemId } : {}) })
}

function presentationNeutralTurnUpdate(
  previous: TranscriptRuntimeInput,
  next: TranscriptRuntimeInput,
  itemIds: readonly ItemId[],
): boolean {
  if (previous.conversation.turns === next.conversation.turns) return true
  const turnIds = new Set<TurnId>()
  for (const itemId of itemIds) {
    const priorItem = previous.conversation.items[itemId]
    const nextItem = next.conversation.items[itemId]
    const turnId = nextItem?.turnId ?? priorItem?.turnId
    if (
      !turnId ||
      (priorItem && nextItem && priorItem.turnId !== nextItem.turnId)
    )
      return false
    turnIds.add(turnId)
  }
  if (turnIds.size !== 1) return false
  const turnId = [...turnIds][0]!
  const priorTurn = previous.conversation.turns[turnId]
  const nextTurn = next.conversation.turns[turnId]
  return Boolean(
    priorTurn &&
    nextTurn &&
    priorTurn.status === nextTurn.status &&
    priorTurn.itemIds === nextTurn.itemIds &&
    priorTurn.startedAt === nextTurn.startedAt &&
    priorTurn.completedAt === nextTurn.completedAt &&
    priorTurn.durationMs === nextTurn.durationMs &&
    isConversationTurnUpdate(
      previous.conversation.turns,
      next.conversation.turns,
      turnId,
      priorTurn,
      nextTurn,
    ),
  )
}

function activeTurnPresentationChanged(
  previous: TranscriptRuntimeInput,
  next: TranscriptRuntimeInput,
): boolean {
  const turnId = previous.conversation.activeTurnId
  if (!turnId) return false
  const priorTurn = previous.conversation.turns[turnId]
  const nextTurn = next.conversation.turns[turnId]
  return Boolean(
    priorTurn &&
    nextTurn &&
    (priorTurn.status !== nextTurn.status ||
      priorTurn.startedAt !== nextTurn.startedAt ||
      priorTurn.completedAt !== nextTurn.completedAt ||
      priorTurn.durationMs !== nextTurn.durationMs),
  )
}

function unprovenTurnStructureChanged(
  previous: TranscriptRuntimeInput,
  next: TranscriptRuntimeInput,
  itemIds: readonly ItemId[],
): boolean {
  if (previous.conversation.turnIds === next.conversation.turnIds) return false
  if (isEmptyTailTurnAdmission(previous, next)) return false
  return (
    itemIds.length !== 1 || !isTailItemAdmission(previous, next, itemIds[0]!)
  )
}

function isTailItemAdmission(
  previous: TranscriptRuntimeInput,
  next: TranscriptRuntimeInput,
  itemId: ItemId,
): boolean {
  const item = next.conversation.items[itemId]
  const turn = item && next.conversation.turns[item.turnId]
  const orderAppend = transcriptOrderAppend(
    previous.transcript.order,
    next.transcript.order,
  )
  const projection = next.transcript.projectionById[itemId]
  const foldLineage =
    previous.transcript.folded === next.transcript.folded ||
    (next.transcript.folded[itemId] === true &&
      isTranscriptFoldAddition(
        previous.transcript.folded,
        next.transcript.folded,
        itemId,
        true,
      ))
  if (
    !item ||
    !turn ||
    turn.status !== "running" ||
    next.conversation.activeTurnId !== item.turnId ||
    next.conversation.turnIds.at(-1) !== item.turnId ||
    previous.conversation.items[itemId] ||
    previous.transcript.projectionById[itemId] ||
    !projection ||
    transcriptOrderIndex(previous.transcript.order).has(itemId) ||
    orderAppend?.itemId !== itemId ||
    orderAppend.position !== previous.transcript.order.length ||
    !isTranscriptProjectionAddition(
      previous.transcript.projectionById,
      next.transcript.projectionById,
      itemId,
      projection,
    ) ||
    !foldLineage ||
    !isConversationItemAddition(
      previous.conversation.items,
      next.conversation.items,
      item,
    )
  )
    return false

  const previousTurn = previous.conversation.turns[item.turnId]
  if (previousTurn) {
    return (
      next.conversation.turnIds === previous.conversation.turnIds &&
      isTurnItemIdAppend(previousTurn.itemIds, turn.itemIds, itemId) &&
      isConversationTurnUpdate(
        previous.conversation.turns,
        next.conversation.turns,
        item.turnId,
        previousTurn,
        turn,
      )
    )
  }
  return (
    isConversationTurnIdAppend(
      previous.conversation.turnIds,
      next.conversation.turnIds,
      item.turnId,
    ) &&
    isConversationTurnAdditionThenItemAppend(
      previous.conversation.turns,
      next.conversation.turns,
      item.turnId,
      itemId,
      turn,
    )
  )
}

/** Stateless full-rebuild fallback for inert renderers; it owns no runtime lifetime. */
export function createTranscriptFrame(
  input: TranscriptRuntimeInput,
): TranscriptFrame {
  return buildFrame(input, undefined, 1, fullDamage)
}

/**
 * Renderer-neutral presentation cache. It retains one coherent displayed
 * revision while detached; canonical and semantic authority remain upstream.
 */
export class TranscriptRuntime {
  private frame: TranscriptFrame
  private latestInput: TranscriptRuntimeInput
  private displayedInput: TranscriptRuntimeInput
  private activityProtectionState: TranscriptState
  private windowPolicy: TranscriptWindowPolicy | undefined
  private heightIndex: TranscriptHeightIndex | undefined
  // Reuse recent immutable layouts without retaining native roots or history-sized maps.
  private readonly recentGeometry = new Map<string, BlockGeometry>()
  private recentGeometryPoints = 0
  private readonly diagnostics: TranscriptRuntimeDiagnostics | undefined
  private readonly itemBlockIndexes = new Map<ItemId, number>()
  private readonly hiddenDamage = new HiddenDamageAccumulator()
  private readonly listeners = new Set<() => void>()
  private disposed = false
  private notifying = false
  private readonly queuedInputs: TranscriptRuntimeInput[] = []
  private lastRevealId = -1
  private viewportIntentRevision = 0
  private excludedTurnIds: ReadonlySet<TurnId>

  constructor(
    input: TranscriptRuntimeInput,
    options: TranscriptRuntimeOptions = {},
  ) {
    this.latestInput = input
    this.displayedInput = input
    this.activityProtectionState = input.transcript
    this.excludedTurnIds = new Set(input.excludedTurnIds ?? [])
    this.windowPolicy =
      options.windowPolicy && Object.freeze({ ...options.windowPolicy })
    this.diagnostics = options.diagnostics
    // Canonical-order indexing is setup work, never a surprise inside the
    // first user-visible reveal against this authoritative snapshot.
    transcriptOrderIndex(input.transcript.order, this.diagnostics)
    const initial = this.windowPolicy
      ? buildFrame(input, undefined, 1, fullDamage, this.diagnostics, true)
      : createTranscriptFrame(input)
    primeTranscriptUrlIndex(initial.transcript, this.diagnostics)
    transcriptTextLengthRange(initial.transcript, 0, 0, this.diagnostics)
    if (this.diagnostics) {
      this.diagnostics.completePlanBuilds += 1
      this.diagnostics.completePlanBlockVisits += initial.blocks.length
    }
    const index = this.heightIndexForFrame(initial, true)
    this.frame = this.withPlannedWindow(
      initial,
      index,
      displayedReveal(input, initial, this.diagnostics),
    )
    this.activityProtectionState = this.frame.transcript
    this.heightIndex = index
    this.reindex(this.frame.blocks)
    this.lastRevealId = input.reveal?.id ?? -1
  }

  getSnapshot = (): TranscriptFrame => this.frame

  /** Explicit navigation can supersede queued input; streaming and geometry cannot. */
  getViewportIntentRevision = (): number => this.viewportIntentRevision

  private rememberGeometry(geometry: BlockGeometry): void {
    if (!this.windowPolicy) return
    const key = geometry.key.blockKey
    const prior = this.recentGeometry.get(key)
    if (prior) {
      this.recentGeometryPoints -= (prior.pointCount ?? 0) + prior.lines.length
      this.recentGeometry.delete(key)
    }
    const points =
      (geometry.pointCount ?? Object.keys(geometry.points).length) +
      geometry.lines.length
    if (points > 32_768) return
    this.recentGeometry.set(key, geometry)
    this.recentGeometryPoints += points
    while (
      this.recentGeometry.size > 64 ||
      this.recentGeometryPoints > 32_768
    ) {
      const oldest = this.recentGeometry.entries().next().value!
      this.recentGeometry.delete(oldest[0])
      this.recentGeometryPoints -=
        (oldest[1].pointCount ?? 0) + oldest[1].lines.length
    }
  }

  private clearRecentGeometry(): void {
    this.recentGeometry.clear()
    this.recentGeometryPoints = 0
  }

  private cachedGeometry(
    frame: TranscriptFrame,
    block: TranscriptBlock,
    index = this.heightIndex,
  ): BlockGeometry | undefined {
    const key = blockKey(block)
    const cached = this.recentGeometry.get(key)
    const presentation = frame.window.activityPresentation[key]?.kind ?? "item"
    const ordinal = index?.blockIndex(key)
    if (
      !cached ||
      ordinal === undefined ||
      index?.rowRange(ordinal, ordinal + 1)?.rows !== cached.rows ||
      frame.geometry.width !== cached.key.width ||
      frame.geometry.styleRevision !== cached.key.styleRevision ||
      !geometryMatchesBlock(
        cached,
        block,
        block.key.kind === "item" &&
          (presentation !== "item" ||
            Boolean(frame.transcript.folded[block.key.itemId])),
        presentation,
      )
    )
      return undefined
    this.recentGeometry.delete(key)
    this.recentGeometry.set(key, cached)
    return cached
  }

  /** Keep visible block destinations in place; scroll only at a viewport edge. */
  navigationScreenRow(
    point: LogicalPoint,
    direction: "forward" | "backward",
    viewportRows = this.windowPolicy?.viewportRows,
  ): number | undefined {
    if (!viewportRows) return undefined
    const lastRow = Math.max(0, viewportRows - 1)
    const index = this.heightIndex
    const rowFor = (target: LogicalPoint): number | undefined => {
      if (!index) {
        // Fully mounted consumers have exact composed rows, without a height index.
        for (const block of this.frame.geometry.blockRows) {
          if (block.itemId !== target.itemId) continue
          const geometry = this.frame.geometry.byBlockKey[block.blockKey]
          const local =
            geometry?.points[target.graphemeOffset] ??
            (geometry?.key.folded
              ? Object.values(geometry.points)[0]
              : undefined)
          if (local) return block.start + local.row
        }
        return undefined
      }
      const ordinal = transcriptPointBlockIndex(
        this.frame.blocks,
        index,
        target,
        undefined,
      )
      const block =
        ordinal === undefined ? undefined : this.frame.blocks[ordinal]
      if (!block || ordinal === undefined) return undefined
      const geometry =
        this.frame.geometry.byBlockKey[blockKey(block)] ??
        this.cachedGeometry(this.frame, block)
      const local =
        geometry?.points[target.graphemeOffset] ??
        (geometry?.key.folded ? Object.values(geometry.points)[0] : undefined)
      return local ? index.prefixRows(ordinal) + local.row : undefined
    }
    const viewport = this.frame.transcript.viewport
    const anchorRow =
      viewport.kind === "point" ? rowFor(viewport.point) : undefined
    const top =
      viewport.kind === "tail"
        ? Math.max(
            0,
            (index?.totalRows ?? this.frame.geometry.totalRows) - viewportRows,
          )
        : anchorRow === undefined
          ? undefined
          : Math.max(0, anchorRow - viewport.preferredScreenRow)
    const destination = rowFor(point)
    return top === undefined || destination === undefined
      ? direction === "forward"
        ? lastRow
        : 0
      : Math.max(0, Math.min(lastRow, destination - top))
  }

  /** Resolve scroll destinations even when their native rows are not mounted. */
  scrollAnchorAtRow(
    row: number,
  ): { point: LogicalPoint; preferredScreenRow: number } | undefined {
    const index = this.heightIndex
    if (!index || !Number.isFinite(row) || index.totalRows <= 0)
      return undefined
    const targetRow = Math.max(
      0,
      Math.min(Math.floor(row), index.totalRows - 1),
    )
    let ordinal = index.blockAtRow(targetRow)
    if (ordinal === undefined) return undefined
    // Skip nonsemantic turn footers and zero-height members of collapsed groups.
    let backward = false
    while (ordinal >= 0 && ordinal < this.frame.blocks.length) {
      const block = this.frame.blocks[ordinal]!
      const start = index.prefixRows(ordinal)
      const end = index.prefixRows(ordinal + 1)
      if ("projection" in block && end > start) {
        const geometry =
          this.frame.geometry.byBlockKey[blockKey(block)] ??
          this.cachedGeometry(this.frame, block)
        const points = Object.values(geometry?.points ?? {}).filter(
          (point) => !point.hidden,
        )
        const localRow = Math.max(0, targetRow - start)
        const point = points
          .filter((point) => point.row >= localRow)
          .sort((a, b) => a.row - b.row || a.column - b.column)[0]
        return {
          point: {
            itemId: block.key.itemId,
            graphemeOffset:
              point?.graphemeOffset ?? blockGraphemeRange(block).from,
          },
          preferredScreenRow: Math.max(
            0,
            start + (point?.row ?? 0) - targetRow,
          ),
        }
      }
      const next = !backward ? index.blockAtRow(end) : undefined
      if (next !== undefined && next > ordinal) ordinal = next
      else {
        backward = true
        const previous = index.blockAtRow(start - 1)
        if (start <= 0 || previous === undefined || previous >= ordinal)
          return undefined
        ordinal = previous
      }
    }
    return undefined
  }
  getThreadId = (): ThreadId => this.latestInput.threadId
  measurementBase = (
    frame: TranscriptFrame = this.frame,
  ): Readonly<BlockMeasurementBase> =>
    Object.freeze({
      threadId: frame.threadId,
      canonicalGeneration: frame.canonicalGeneration,
      displayedCanonicalRevision: frame.displayedCanonicalRevision,
      basePresentationRevision: frame.presentationRevision,
      geometryGeneration: frame.geometry.generation,
    })

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private heightIndexForFrame(
    frame: TranscriptFrame,
    estimatesOnly = false,
  ): TranscriptHeightIndex | undefined {
    if (!this.windowPolicy) return undefined
    const blockByKey = new Map(
      frame.blocks.map((block) => [blockKey(block), block]),
    )
    const activityOverrides = Object.entries(
      frame.window.activityPresentation,
    ).flatMap(([key, value]) => {
      const block = blockByKey.get(key)
      return block
        ? [
            {
              blockKey: key,
              contentRevision: block.contentRevision,
              rows: value.kind === "activity-hidden" ? 0 : 2,
            },
          ]
        : []
    })
    const overrides = estimatesOnly
      ? activityOverrides
      : [
          ...activityOverrides,
          ...Object.values(frame.geometry.byBlockKey).flatMap((geometry) => {
            const block = blockByKey.get(geometry.key.blockKey)
            const presentation = block
              ? (frame.window.activityPresentation[blockKey(block)]?.kind ??
                "item")
              : "item"
            if (
              !block ||
              !geometryMatchesBlock(
                geometry,
                block,
                block.key.kind === "item" &&
                  (presentation !== "item" ||
                    Boolean(frame.transcript.folded[block.key.itemId])),
                presentation,
              )
            )
              return []
            return [
              {
                blockKey: geometry.key.blockKey,
                contentRevision: geometry.key.contentRevision,
                rows: geometry.rows,
              },
            ]
          }),
        ]
    if (this.diagnostics) {
      this.diagnostics.heightIndexBuilds += 1
      this.diagnostics.heightIndexBlockVisits += frame.blocks.length
    }
    return createHeightIndex(frame.blocks, overrides)
  }

  private heightIndexForActivityChanges(
    frame: TranscriptFrame,
    index: TranscriptHeightIndex | undefined,
  ): TranscriptHeightIndex | undefined {
    if (
      !index ||
      this.frame.window.activityPresentation ===
        frame.window.activityPresentation
    )
      return index
    const previous = this.frame.window.activityPresentation,
      next = frame.window.activityPresentation
    for (const key of new Set([
      ...Object.keys(previous),
      ...Object.keys(next),
    ])) {
      if (previous[key]?.kind === next[key]?.kind) continue
      const ordinal = index.blockIndex(key)
      const block = ordinal === undefined ? undefined : frame.blocks[ordinal]
      if (!block) continue
      const rows =
        next[key]?.kind === "activity-hidden"
          ? 0
          : next[key]?.kind === "activity-lead"
            ? 2
            : block.key.kind === "item" &&
                frame.transcript.folded[block.key.itemId]
              ? 1
              : Math.max(1, block.estimatedRows)
      index = index.replaceHeight({
        blockKey: key,
        contentRevision: block.contentRevision,
        rows,
      })
    }
    return index
  }

  private heightIndexForFoldChanges(
    frame: TranscriptFrame,
    itemIds: readonly ItemId[],
  ): TranscriptHeightIndex | undefined {
    let index = this.heightIndex?.supports(frame.blocks)
      ? this.heightIndex
      : undefined
    if (!index) return undefined
    for (const itemId of new Set(itemIds)) {
      if (
        this.frame.transcript.folded[itemId] === frame.transcript.folded[itemId]
      )
        continue
      const blockIndexes = index.itemBlockIndexes(itemId)
      if (!blockIndexes || blockIndexes.length !== 1) return undefined
      const block = frame.blocks[blockIndexes[0]!]
      if (!block || block.key.kind !== "item" || block.key.blockId !== "root")
        return undefined
      const counters = { nodeVisits: 0, nodesCopied: 0 }
      index = index.replaceHeight(
        {
          blockKey: blockKey(block),
          contentRevision: block.contentRevision,
          rows: frame.transcript.folded[itemId]
            ? 1
            : Math.max(1, block.estimatedRows),
        },
        counters,
      )
      if (this.diagnostics) {
        this.diagnostics.heightIndexUpdates += 1
        this.diagnostics.heightIndexNodeVisits += counters.nodeVisits
        this.diagnostics.heightIndexNodesCopied += counters.nodesCopied
      }
    }
    return index
  }

  private revealExistsInDisplayedFrame(
    input: TranscriptRuntimeInput,
    frame: TranscriptFrame,
    point: LogicalPoint,
  ): boolean {
    const latest = input.transcript.projectionById[point.itemId]
    const displayed = frame.transcript.projectionById[point.itemId]
    if (!latest || !displayed || !latest.source.startsWith(displayed.source))
      return false
    const targetSpan = latest.sourceSpans[point.graphemeOffset]
    // A concrete grapheme beginning at the old source end belongs to hidden
    // appended output. The document-end sentinel belongs to the displayed
    // revision only when both revisions have the same source extent.
    if (
      targetSpan
        ? targetSpan.from >= displayed.source.length ||
          targetSpan.to > displayed.source.length
        : latest.source.length !== displayed.source.length
    )
      return false
    const mapped = mapPoint(
      input.transcript,
      frame.transcript.projectionById,
      point,
    )
    if (!mapped) return false
    const index = this.heightIndex
    if (index?.supports(frame.blocks))
      return (
        transcriptPointBlockIndex(frame.blocks, index, mapped, undefined) !==
        undefined
      )
    // Inert consumers intentionally omit windowing and retain the complete
    // reference plan; only that pass-through path may use the linear oracle.
    return !this.windowPolicy && pointIsMaterialized(frame.blocks, mapped)
  }

  private withPlannedWindow(
    frame: TranscriptFrame,
    index: TranscriptHeightIndex | undefined,
    reveal?: LogicalPoint,
    geometryByKey: Readonly<Record<string, BlockGeometry>> = frame.geometry
      .byBlockKey,
  ): TranscriptFrame {
    if (!this.windowPolicy) return frame
    const viewport = frame.transcript.viewport
    const focusOrdinal =
      viewport.kind === "point" && index
        ? transcriptPointBlockIndex(
            frame.blocks,
            index,
            viewport.point,
            undefined,
          )
        : undefined
    const focusBlock =
      focusOrdinal === undefined ? undefined : frame.blocks[focusOrdinal]
    const focusGeometry = focusBlock
      ? this.cachedGeometry(frame, focusBlock, index)
      : undefined
    const localRow =
      viewport.kind === "point"
        ? (pointBlockLocalRow(
            frame.window.blocks,
            geometryByKey,
            viewport.point,
          ) ?? focusGeometry?.points[viewport.point.graphemeOffset]?.row)
        : undefined
    const attachment =
      frame.mode === "follow" || viewport.kind === "tail"
        ? Object.freeze({ kind: "tail" as const })
        : Object.freeze({
            kind: "point" as const,
            point: viewport.point,
            preferredScreenRow: viewport.preferredScreenRow,
            ...(localRow === undefined ? {} : { blockLocalRow: localRow }),
          })
    const planned = index
      ? planTranscriptWindow({
          blocks: frame.blocks,
          state: frame.transcript,
          prior: frame.window,
          activityPlan: frame.window,
          heights: index,
          viewportRows: this.windowPolicy.viewportRows,
          overscanRows: this.windowPolicy.overscanRows,
          recentTailBlocks: this.windowPolicy.recentTailBlocks,
          recentTailRows: this.windowPolicy.recentTailRows,
          attachment,
          ...(reveal ? { reveal } : {}),
        })
      : passThroughWindow(frame.blocks, frame.transcript, frame.window)
    if (this.diagnostics)
      this.diagnostics.blockPlanWindowSliceItems += planned.blocks.length
    const window = sameWindow(frame.window, planned) ? frame.window : planned
    let restoredGeometry: Record<string, BlockGeometry> | undefined
    const plannedFrame = window === frame.window ? frame : { ...frame, window }
    for (const block of window.blocks) {
      const key = blockKey(block)
      if (geometryByKey[key]) continue
      const cached = this.cachedGeometry(plannedFrame, block, index)
      if (!cached) continue
      restoredGeometry ??= { ...geometryByKey }
      restoredGeometry[key] = cached
    }
    const alreadyWindowLocal =
      !restoredGeometry &&
      window === frame.window &&
      frame.geometry.totalRows === index?.totalRows &&
      frame.geometry.blockRows.length === window.blocks.length &&
      frame.geometry.blockRows.every(
        (rows, position) =>
          rows.blockKey === blockKey(window.blocks[position]!),
      )
    const geometry = alreadyWindowLocal
      ? frame.geometry
      : composeTranscriptWindowGeometry(
          window.blocks,
          frame.transcript.folded,
          restoredGeometry ?? geometryByKey,
          frame.geometry.generation,
          frame.geometry.revision,
          window.topSpacerRows,
          index?.totalRows ?? frame.geometry.totalRows,
          frame.geometry.width,
          frame.geometry.styleRevision,
          window.activityPresentation,
          (key) => {
            const ordinal = index?.blockIndex(key)
            return ordinal === undefined
              ? undefined
              : index?.rowRange(ordinal, ordinal + 1)?.rows
          },
        )
    if (!alreadyWindowLocal && this.diagnostics)
      this.diagnostics.windowGeometryBlockVisits += window.blocks.length
    return window === frame.window && geometry === frame.geometry
      ? frame
      : Object.freeze({ ...frame, window, geometry })
  }

  /** Renderer dimensions refine this presentation's bounded policy; semantic authority stays upstream. */
  setWindowViewport(
    viewportRows: number,
    overscanRows = viewportRows,
    recentTailBlocks = this.windowPolicy?.recentTailBlocks ?? 0,
  ): TranscriptFrame {
    if (
      this.disposed ||
      this.notifying ||
      !Number.isSafeInteger(viewportRows) ||
      viewportRows < 1 ||
      !Number.isSafeInteger(overscanRows) ||
      overscanRows < 0 ||
      !Number.isSafeInteger(recentTailBlocks) ||
      recentTailBlocks < 0
    )
      return this.frame
    if (
      this.windowPolicy?.viewportRows === viewportRows &&
      this.windowPolicy.overscanRows === overscanRows &&
      (this.windowPolicy.recentTailBlocks ?? 0) === recentTailBlocks
    )
      return this.frame
    this.windowPolicy = Object.freeze({
      viewportRows,
      overscanRows,
      recentTailBlocks,
      recentTailRows: this.windowPolicy?.recentTailRows,
    })
    const index = this.heightIndex?.supports(this.frame.blocks)
      ? this.heightIndex
      : this.heightIndexForFrame(this.frame)
    const next = this.withPlannedWindow(
      Object.freeze({
        ...this.frame,
        presentationRevision: this.frame.presentationRevision + 1,
        damage: Object.freeze({ kind: "view" as const }),
      }),
      index,
    )
    return sameWindow(this.frame.window, next.window)
      ? this.frame
      : this.publish(next, index)
  }

  private publish(
    frame: TranscriptFrame,
    index: TranscriptHeightIndex | undefined = this.heightIndex,
  ): TranscriptFrame {
    this.frame = frame
    this.heightIndex = index
    this.notifying = true
    try {
      for (const listener of [...this.listeners]) {
        try {
          listener()
        } catch {
          /* one renderer cannot starve other observers */
        }
      }
    } finally {
      this.notifying = false
    }
    while (this.queuedInputs.length && !this.disposed) {
      const queued = this.queuedInputs.shift()
      if (queued) this.update(queued)
    }
    return this.frame
  }

  private reindex(blocks: readonly TranscriptBlock[]): void {
    this.itemBlockIndexes.clear()
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]
      if (block?.key.kind !== "item") continue
      if (
        block.key.blockId !== "root" ||
        this.itemBlockIndexes.has(block.key.itemId)
      )
        this.itemBlockIndexes.set(block.key.itemId, -1)
      else this.itemBlockIndexes.set(block.key.itemId, index)
    }
  }

  private incrementalFrame(
    input: TranscriptRuntimeInput,
    itemIds: readonly ItemId[],
    damage: TranscriptDamage,
  ):
    | Readonly<{
        frame: TranscriptFrame
        index: TranscriptHeightIndex | undefined
      }>
    | undefined {
    let blocks = this.frame.blocks
    let index = this.heightIndex?.supports(blocks)
      ? this.heightIndex
      : undefined
    let projections = persistentTranscriptProjections(
      this.frame.transcript.projectionById,
    )
    let materialized = false
    let activityChanged = false
    for (const itemId of itemIds) {
      const itemIndexes = index?.itemBlockIndexes(itemId)
      const position = index
        ? itemIndexes?.length === 1
          ? itemIndexes[0]
          : undefined
        : this.itemBlockIndexes.get(itemId)
      if (position === -1) return undefined
      if (itemIndexes && itemIndexes.length !== 1) return undefined
      const prior =
        position === undefined || position < 0 ? undefined : blocks[position]
      const next = buildTranscriptItemBlock(input, itemId)
      if (this.diagnostics) this.diagnostics.changedItemBuilds += 1
      if (!prior && !next) continue
      materialized = true
      if (
        !prior ||
        !("projection" in prior) ||
        !next ||
        prior.turnId !== next.turnId
      )
        return undefined
      activityChanged ||= activityTopologyChanged(prior, next)
      projections = setTranscriptProjection(
        projections,
        itemId,
        next.projection,
        this.diagnostics,
      )
      if (sameBlock(prior, next)) continue
      if (!this.windowPolicy) {
        const copied = [...blocks]
        copied[position!] = next
        blocks = Object.freeze(copied)
        continue
      }
      const replaced = replaceTranscriptBlock(
        blocks,
        position!,
        prior,
        next,
        this.diagnostics,
      )
      if (!replaced) return undefined
      const counters = { nodeVisits: 0, nodesCopied: 0 }
      const presentation =
        this.frame.window.activityPresentation[blockKey(prior)]?.kind
      const replacedIndex = index?.replaceBlock(
        replaced,
        prior,
        next,
        presentation === "activity-hidden"
          ? 0
          : presentation === "activity-lead"
            ? 2
            : this.frame.transcript.folded[itemId]
              ? 1
              : Math.max(1, next.estimatedRows),
        counters,
      )
      if (!replacedIndex) return undefined
      blocks = replaced
      index = replacedIndex
      if (this.diagnostics) {
        this.diagnostics.heightIndexUpdates += 1
        this.diagnostics.heightIndexNodeVisits += counters.nodeVisits
        this.diagnostics.heightIndexNodesCopied += counters.nodesCopied
      }
    }
    // Canonical-only items, such as reasoning, never enter the semantic
    // transcript and must not wake a following or detached presentation.
    if (!materialized)
      return Object.freeze({ frame: this.frame, index: this.heightIndex })
    blocks = this.windowPolicy ? persistentTranscriptBlockPlan(blocks) : blocks
    const transcript = presentationTranscriptWithProjections(
      input.transcript,
      this.frame.transcript.order,
      projections,
    )
    inheritTranscriptTextLengthIndexChanges(
      this.frame.transcript,
      transcript,
      itemIds,
      this.diagnostics,
    )
    inheritTranscriptUrlIndexChanges(
      this.frame.transcript,
      transcript,
      itemIds,
      this.diagnostics,
    )
    const window = activityChanged
      ? passThroughWindow(blocks, transcript, this.frame.window)
      : this.retainedActivityWindow(blocks, transcript)
    const activityDamage = changedActivityPresentationIds(
      this.frame.window.activityPresentation,
      window.activityPresentation,
    )
    const frame = Object.freeze({
      threadId: input.threadId,
      canonicalGeneration: input.canonicalGeneration,
      displayedCanonicalRevision: input.canonicalRevision,
      presentationRevision: this.frame.presentationRevision + 1,
      mode: input.mode,
      transcript,
      blocks,
      window,
      geometry: this.windowPolicy
        ? this.frame.geometry
        : reconciledGeometry(
            this.frame.geometry,
            input,
            blocks,
            window,
            this.diagnostics,
          ),
      damage: damageWithActivityChanges(damage, activityDamage),
    })
    return Object.freeze({ frame, index })
  }

  private structuralTailFrame(
    previousInput: TranscriptRuntimeInput,
    input: TranscriptRuntimeInput,
    itemIds: readonly ItemId[],
    damage: TranscriptDamage,
  ):
    | Readonly<{
        frame: TranscriptFrame
        index: TranscriptHeightIndex | undefined
        appendedItemId?: ItemId
        windowStable?: true
      }>
    | undefined {
    if (
      !this.windowPolicy ||
      this.frame.displayedCanonicalRevision !==
        previousInput.canonicalRevision ||
      previousInput.mode !== "follow" ||
      input.mode !== "follow" ||
      input.reveal ||
      (input.presentationDamage && input.presentationDamage.kind !== "none")
    )
      return undefined
    const completion =
      itemIds.length === 0
        ? tailTurnCompletion(previousInput, input)
        : undefined
    if (completion) {
      if (this.excludedTurnIds.has(completion.turnId)) return undefined
      const nextTurn = input.conversation.turns[completion.turnId]!
      let blocks = this.frame.blocks
      let index = this.heightIndex?.supports(blocks)
        ? this.heightIndex
        : undefined
      if (!index) return undefined
      let changed = false

      if (completion.itemId) {
        const itemIndexes = index.itemBlockIndexes(completion.itemId)
        const position = itemIndexes?.length === 1 ? itemIndexes[0] : undefined
        if (itemIndexes && itemIndexes.length !== 1) return undefined
        const prior =
          position === undefined || position < 0 ? undefined : blocks[position]
        const next = buildTranscriptItemBlock(input, completion.itemId)
        if (this.diagnostics) this.diagnostics.changedItemBuilds += 1
        if (!prior && next) return undefined
        if (
          prior &&
          (!next ||
            !("projection" in prior) ||
            prior.key.blockId !== "root" ||
            prior.turnId !== completion.turnId ||
            position !== blocks.length - 1)
        )
          return undefined
        if (prior && next && !sameBlock(prior, next)) {
          const replaced = replaceTranscriptBlock(
            blocks,
            position!,
            prior,
            next,
            this.diagnostics,
          )
          if (!replaced) return undefined
          const counters = { nodeVisits: 0, nodesCopied: 0 }
          const replacedIndex = index.replaceBlock(
            replaced,
            prior,
            next,
            this.frame.transcript.folded[completion.itemId]
              ? 1
              : Math.max(1, next.estimatedRows),
            counters,
          )
          if (!replacedIndex) return undefined
          blocks = replaced
          index = replacedIndex
          changed = true
          if (this.diagnostics) {
            this.diagnostics.heightIndexUpdates += 1
            this.diagnostics.heightIndexNodeVisits += counters.nodeVisits
            this.diagnostics.heightIndexNodesCopied += counters.nodesCopied
          }
        }
      }

      const activity = buildTranscriptTurnActivityBlock(nextTurn)
      if (activity) {
        const appended = appendTranscriptBlock(
          blocks,
          activity,
          this.diagnostics,
        )
        const counters = { nodeVisits: 0, nodesCopied: 0 }
        const appendedIndex = index.appendBlock?.(
          appended,
          activity,
          Math.max(1, activity.estimatedRows),
          counters,
        )
        if (!appendedIndex) return undefined
        blocks = appended
        index = appendedIndex
        changed = true
        if (this.diagnostics) {
          this.diagnostics.heightIndexUpdates += 1
          this.diagnostics.heightIndexNodeVisits += counters.nodeVisits
          this.diagnostics.heightIndexNodesCopied += counters.nodesCopied
        }
      }

      return Object.freeze({
        frame: Object.freeze({
          ...this.frame,
          displayedCanonicalRevision: input.canonicalRevision,
          presentationRevision: this.frame.presentationRevision + 1,
          blocks,
          window: changed
            ? this.retainedActivityWindow(blocks, this.frame.transcript)
            : this.frame.window,
          damage: frozenDamage(damage),
        }),
        index,
        ...(changed ? {} : { windowStable: true as const }),
      })
    }
    if (itemIds.length === 0) {
      if (!isEmptyTailTurnAdmission(previousInput, input)) return undefined
      const turnId = input.conversation.turnIds.at(-1)
      if (!turnId || this.excludedTurnIds.has(turnId)) return undefined
      return Object.freeze({
        frame: Object.freeze({
          ...this.frame,
          displayedCanonicalRevision: input.canonicalRevision,
          presentationRevision: this.frame.presentationRevision + 1,
          damage: frozenDamage(damage),
        }),
        index: this.heightIndex,
        windowStable: true,
      })
    }
    if (itemIds.length !== 1) return undefined
    const itemId = itemIds[0]!
    if (!isTailItemAdmission(previousInput, input, itemId)) return undefined
    const item = input.conversation.items[itemId]
    if (!item || this.excludedTurnIds.has(item.turnId)) return undefined
    const appended = buildTranscriptItemBlock(input, itemId)
    if (
      !appended ||
      appended.key.blockId !== "root" ||
      appended.followedByActivity
    )
      return undefined
    if (this.diagnostics) this.diagnostics.changedItemBuilds += 1
    const blocks = appendTranscriptBlock(
      this.frame.blocks,
      appended,
      this.diagnostics,
    )
    const counters = { nodeVisits: 0, nodesCopied: 0 }
    const index = this.heightIndex?.supports(this.frame.blocks)
      ? this.heightIndex.appendBlock?.(
          blocks,
          appended,
          input.transcript.folded[itemId]
            ? 1
            : Math.max(1, appended.estimatedRows),
          counters,
        )
      : undefined
    if (!index) return undefined
    if (this.diagnostics) {
      this.diagnostics.heightIndexUpdates += 1
      this.diagnostics.heightIndexNodeVisits += counters.nodeVisits
      this.diagnostics.heightIndexNodesCopied += counters.nodesCopied
    }
    const presentedOrder = this.excludedTurnIds.size
      ? appendTranscriptOrder(this.frame.transcript.order, itemId)
      : input.transcript.order
    const presentedProjections = this.excludedTurnIds.size
      ? setTranscriptProjection(
          this.frame.transcript.projectionById,
          itemId,
          input.transcript.projectionById[itemId]!,
          this.diagnostics,
        )
      : input.transcript.projectionById
    const transcript = presentationTranscriptWithProjections(
      input.transcript,
      presentedOrder,
      presentedProjections,
    )
    inheritTranscriptTextLengthIndex(
      this.frame.transcript,
      transcript,
      itemId,
      true,
      this.diagnostics,
    )
    inheritTranscriptUrlIndex(
      this.frame.transcript,
      transcript,
      itemId,
      true,
      this.diagnostics,
    )
    const frame = Object.freeze({
      threadId: input.threadId,
      canonicalGeneration: input.canonicalGeneration,
      displayedCanonicalRevision: input.canonicalRevision,
      presentationRevision: this.frame.presentationRevision + 1,
      mode: input.mode,
      transcript,
      blocks,
      window:
        (appended.item.kind === "command" || appended.item.kind === "tool") &&
        appended.item.activity
          ? passThroughWindow(blocks, transcript, this.frame.window)
          : this.retainedActivityWindow(blocks, transcript),
      geometry: this.frame.geometry,
      damage: frozenDamage(damage),
    })
    return Object.freeze({ frame, index, appendedItemId: itemId })
  }

  private retainedActivityWindow(
    blocks: readonly TranscriptBlock[],
    transcript: TranscriptState,
  ): TranscriptWindow {
    return sameActivityProtection(
      transcript,
      this.activityProtectionState,
      this.frame.window,
    )
      ? Object.freeze({
          ...this.frame.window,
          blocks,
          topSpacerRows: 0,
          bottomSpacerRows: 0,
          overscanRows: 0,
        })
      : passThroughWindowWithActivityPlan(blocks, this.frame.window, transcript)
  }

  private presentationFrame(
    input: TranscriptRuntimeInput,
    damage: TranscriptDamage,
  ): TranscriptFrame {
    const transcript = presentationTranscriptWithProjections(
      input.transcript,
      this.frame.transcript.order,
      this.frame.transcript.projectionById,
    )
    const currentWindow = this.frame.window
    const window = sameActivityProtection(
      transcript,
      this.activityProtectionState,
      currentWindow,
    )
      ? currentWindow
      : Object.freeze({
          ...passThroughWindowWithActivityPlan(
            currentWindow.blocks,
            currentWindow,
            transcript,
          ),
          topSpacerRows: currentWindow.topSpacerRows,
          bottomSpacerRows: currentWindow.bottomSpacerRows,
          overscanRows: currentWindow.overscanRows,
        })
    const activityDamage = changedActivityPresentationIds(
      this.frame.window.activityPresentation,
      window.activityPresentation,
    )
    const frame = Object.freeze({
      ...this.frame,
      presentationRevision: this.frame.presentationRevision + 1,
      mode: input.mode,
      transcript,
      window,
      geometry:
        this.windowPolicy ||
        (transcript.folded === this.activityProtectionState.folded &&
          activityDamage.length === 0)
          ? this.frame.geometry
          : reconciledGeometry(
              this.frame.geometry,
              input,
              this.frame.blocks,
              window,
              this.diagnostics,
            ),
      damage: damageWithActivityChanges(damage, activityDamage),
    })
    return frame
  }

  private publishPresentation(
    input: TranscriptRuntimeInput,
    damage: TranscriptDamage,
  ): TranscriptFrame {
    const raw = this.presentationFrame(input, damage)
    const presentationInput: TranscriptRuntimeInput = Object.freeze({
      ...this.displayedInput,
      mode: input.mode,
      transcript: raw.transcript,
      canonicalDamage: noneDamage,
      presentationDamage: frozenDamage(damage),
      reveal: input.reveal,
    })
    const singleFold =
      damage.kind === "layout"
        ? singleTranscriptFoldChange(
            this.frame.transcript.folded,
            raw.transcript.folded,
          )
        : undefined
    const foldDamage: TranscriptDamage = singleFold
      ? { kind: "folds", itemIds: [singleFold] }
      : damage
    // A single persistent fold update can use the targeted path. Bulk folds
    // can change many fragment spans, so their previous block plan is stale.
    if (
      damage.kind === "layout" &&
      raw.transcript.folded !== this.frame.transcript.folded &&
      !singleFold
    )
      return this.rebuild(
        presentationInput,
        damage,
        true,
        undefined,
        this.displayedInput,
        true,
      )
    if (foldDamage.kind === "folds") {
      const changed = foldDamage.itemIds.filter(
        (itemId) =>
          raw.transcript.folded[itemId] !==
          this.frame.transcript.folded[itemId],
      )
      if (changed.length === 1) {
        const itemId = changed[0]!
        const currentIndex = this.heightIndex?.supports(this.frame.blocks)
          ? this.heightIndex
          : undefined
        const positions = currentIndex?.itemBlockIndexes(itemId)
        const nextBlocks = buildTranscriptItemBlocks(presentationInput, itemId)
        if (
          currentIndex &&
          positions?.length &&
          nextBlocks.length &&
          (positions.length !== 1 || nextBlocks.length !== 1) &&
          !this.frame.window.activityBatchByItem[itemId]
        ) {
          const start = positions[0]!
          const previous = Object.freeze(
            positions.map((position) => this.frame.blocks[position]!),
          )
          const blocks = spliceTranscriptItemBlocks(
            this.frame.blocks,
            start,
            previous,
            nextBlocks,
            this.diagnostics,
          )
          const rows = nextBlocks.map((block) => {
            const geometry = this.frame.geometry.byBlockKey[blockKey(block)]
            return geometry &&
              geometryMatchesBlock(
                geometry,
                block,
                Boolean(raw.transcript.folded[itemId]),
                "item",
              )
              ? geometry.rows
              : raw.transcript.folded[itemId]
                ? 1
                : Math.max(1, block.estimatedRows)
          })
          const index = blocks
            ? currentIndex.spliceItemBlocks?.(
                blocks,
                start,
                previous,
                nextBlocks,
                rows,
              )
            : undefined
          if (blocks && index) {
            const removed = new Set(previous.map(blockKey))
            const geometryByKey = Object.freeze(
              Object.fromEntries(
                Object.entries(raw.geometry.byBlockKey).filter(
                  ([key]) => !removed.has(key),
                ),
              ),
            )
            const prepared = Object.freeze({ ...raw, blocks })
            const activityIndex = this.heightIndexForActivityChanges(
              prepared,
              index,
            )
            const planned = this.withPlannedWindow(
              prepared,
              activityIndex,
              displayedReveal(input, prepared, this.diagnostics),
              geometryByKey,
            )
            this.itemBlockIndexes.set(
              itemId,
              nextBlocks.length === 1 ? start : -1,
            )
            this.displayedInput = presentationInput
            this.activityProtectionState = planned.transcript
            return this.publish(planned, activityIndex)
          }
        }
      }
      if (
        changed.some(
          (itemId) =>
            this.itemBlockIndexes.get(itemId) === -1 ||
            buildTranscriptItemBlocks(presentationInput, itemId).length > 1,
        )
      )
        return this.rebuild(
          presentationInput,
          damage,
          true,
          undefined,
          this.displayedInput,
          true,
        )
    }
    const foldsChanged = raw.transcript.folded !== this.frame.transcript.folded
    const targeted =
      foldsChanged && foldDamage.kind === "folds"
        ? this.heightIndexForFoldChanges(raw, foldDamage.itemIds)
        : undefined
    const index = this.heightIndexForActivityChanges(
      raw,
      foldsChanged
        ? (targeted ?? this.heightIndexForFrame(raw))
        : this.heightIndex?.supports(raw.blocks)
          ? this.heightIndex
          : this.heightIndexForFrame(raw),
    )
    const geometry = !foldsChanged
      ? raw.geometry
      : this.windowPolicy
        ? composeTranscriptWindowGeometry(
            raw.window.blocks,
            raw.transcript.folded,
            raw.geometry.byBlockKey,
            raw.geometry.generation,
            raw.geometry.revision,
            raw.window.topSpacerRows,
            index?.totalRows ?? raw.geometry.totalRows,
            raw.geometry.width,
            raw.geometry.styleRevision,
            raw.window.activityPresentation,
            (key) => {
              const ordinal = index?.blockIndex(key)
              return ordinal === undefined
                ? undefined
                : index?.rowRange(ordinal, ordinal + 1)?.rows
            },
          )
        : reconciledGeometry(
            raw.geometry,
            input,
            raw.blocks,
            raw.window,
            this.diagnostics,
          )
    if (foldsChanged && this.diagnostics) {
      if (this.windowPolicy)
        this.diagnostics.windowGeometryBlockVisits += raw.window.blocks.length
    }
    const prepared =
      geometry === raw.geometry ? raw : Object.freeze({ ...raw, geometry })
    this.displayedInput = presentationInput
    this.activityProtectionState = prepared.transcript
    return this.publish(
      this.withPlannedWindow(
        prepared,
        index,
        displayedReveal(input, prepared, this.diagnostics),
      ),
      index,
    )
  }

  /**
   * Atomically accepts one renderer measurement batch when every captured base
   * revision still describes this exact presentation. Stale native work is a
   * strict no-op and can never partially replace newer geometry.
   */
  reportMeasurements(batch: BlockMeasurementBatch): TranscriptFrame {
    if (this.disposed || this.notifying || !batch.measurements.length)
      return this.frame
    if (
      batch.threadId !== this.latestInput.threadId ||
      batch.canonicalGeneration !== this.latestInput.canonicalGeneration ||
      batch.displayedCanonicalRevision !==
        this.frame.displayedCanonicalRevision ||
      batch.basePresentationRevision !== this.frame.presentationRevision ||
      batch.geometryGeneration !== this.frame.geometry.generation
    )
      return this.frame

    const blocks = new Map(
      this.frame.window.blocks.map((block) => [blockKey(block), block]),
    )
    const measuredKeys = new Set<string>()
    const presentation = this.frame.window.activityPresentation
    for (const measurement of batch.measurements) {
      if (measuredKeys.has(measurement.key.blockKey)) return this.frame
      measuredKeys.add(measurement.key.blockKey)
      const block = blocks.get(measurement.key.blockKey)
      const blockPresentation = block
        ? (presentation[blockKey(block)]?.kind ?? "item")
        : "item"
      if (
        !block ||
        !geometryMatchesBlock(
          measurement,
          block,
          block.key.kind === "item" &&
            (blockPresentation !== "item" ||
              Boolean(this.frame.transcript.folded[block.key.itemId])),
          blockPresentation,
        )
      )
        return this.frame
      if (
        !Number.isSafeInteger(measurement.nativeRevision) ||
        measurement.nativeRevision < 0 ||
        !Number.isSafeInteger(measurement.rows) ||
        measurement.rows < 0 ||
        (measurement.rows === 0 && blockPresentation !== "activity-hidden") ||
        !Number.isSafeInteger(measurement.key.width) ||
        measurement.key.width < 1
      )
        return this.frame
      const prior = this.frame.geometry.byBlockKey[measurement.key.blockKey]
      if (prior && measurement.nativeRevision <= prior.nativeRevision)
        return this.frame
    }
    const first = batch.measurements[0]!
    if (
      batch.measurements.some(
        (measurement) =>
          measurement.key.width !== first.key.width ||
          measurement.key.styleRevision !== first.key.styleRevision,
      )
    )
      return this.frame
    if (
      this.frame.geometry.width !== undefined &&
      (this.frame.geometry.width !== first.key.width ||
        this.frame.geometry.styleRevision !== first.key.styleRevision)
    )
      return this.frame

    // Geometry retention is deliberately budgeted to one complete variant per
    // materialized block. Replacing the keyed value releases the prior large
    // variant atomically; partial point eviction would corrupt navigation.
    const nextByKey: Record<string, BlockGeometry> = {
      ...this.frame.geometry.byBlockKey,
    }
    let nextIndex = this.heightIndex?.supports(this.frame.blocks)
      ? this.heightIndex
      : this.heightIndexForFrame(this.frame)
    for (const measurement of batch.measurements) {
      const frozen = freezeBlockGeometry(measurement)
      nextByKey[measurement.key.blockKey] = frozen
      if (nextIndex) {
        const blockIndex = nextIndex.blockIndex(measurement.key.blockKey)
        const priorRows =
          blockIndex === undefined
            ? undefined
            : nextIndex.rowRange(blockIndex, blockIndex + 1)?.rows
        const replaced = nextIndex.replaceHeight({
          blockKey: measurement.key.blockKey,
          contentRevision: measurement.key.contentRevision,
          rows: measurement.rows,
        })
        if (replaced === nextIndex && priorRows !== measurement.rows)
          return this.frame
        nextIndex = replaced
      }
    }
    for (const measurement of batch.measurements)
      this.rememberGeometry(nextByKey[measurement.key.blockKey]!)
    if (!this.windowPolicy) {
      const geometry = composeTranscriptGeometry(
        this.frame.blocks,
        this.frame.transcript.folded,
        nextByKey,
        this.frame.geometry.generation,
        this.frame.geometry.revision + 1,
        first.key.width,
        first.key.styleRevision,
        presentation,
      )
      return this.publish(
        Object.freeze({
          ...this.frame,
          presentationRevision: this.frame.presentationRevision + 1,
          geometry,
          damage: noneDamage,
        }),
        nextIndex,
      )
    }
    const geometry = composeTranscriptWindowGeometry(
      this.frame.window.blocks,
      this.frame.transcript.folded,
      nextByKey,
      this.frame.geometry.generation,
      this.frame.geometry.revision + 1,
      this.frame.window.topSpacerRows,
      nextIndex?.totalRows ?? this.frame.geometry.totalRows,
      first.key.width,
      first.key.styleRevision,
      presentation,
      (key) => {
        const ordinal = nextIndex?.blockIndex(key)
        return ordinal === undefined
          ? undefined
          : nextIndex?.rowRange(ordinal, ordinal + 1)?.rows
      },
    )
    const corrected = this.withPlannedWindow(
      Object.freeze({
        ...this.frame,
        presentationRevision: this.frame.presentationRevision + 1,
        geometry,
        damage: noneDamage,
      }),
      nextIndex,
      undefined,
      nextByKey,
    )
    return this.publish(corrected, nextIndex)
  }

  /** Invalidate the active layout generation so late native results are rejected. */
  resetLayout(_reason: LayoutResetReason): TranscriptFrame {
    if (this.disposed || this.notifying) return this.frame
    this.clearRecentGeometry()
    const geometry = emptyTranscriptGeometry(
      this.frame.geometry.generation + 1,
      this.frame.geometry.revision + 1,
    )
    const index = this.heightIndexForFrame(
      Object.freeze({ ...this.frame, geometry }),
      true,
    )
    const reset = this.withPlannedWindow(
      Object.freeze({
        ...this.frame,
        presentationRevision: this.frame.presentationRevision + 1,
        geometry,
        damage: Object.freeze({ kind: "layout" as const }),
      }),
      index,
    )
    return this.publish(reset, index)
  }

  private rebuild(
    input: TranscriptRuntimeInput,
    damage: TranscriptDamage,
    reuse = true,
    incrementalItemIds?: readonly ItemId[],
    previousInput: TranscriptRuntimeInput = this.latestInput,
    preserveHiddenDamage = false,
  ): TranscriptFrame {
    if (!preserveHiddenDamage) this.hiddenDamage.reset()
    const canonicalOnly = Boolean(
      incrementalItemIds?.length &&
      incrementalItemIds.every(
        (id) =>
          !this.frame.transcript.projectionById[id] &&
          !input.transcript.projectionById[id],
      ) &&
      !activeTurnPresentationChanged(previousInput, input),
    )
    const structuralCandidate =
      !canonicalOnly &&
      Boolean(
        incrementalItemIds &&
        (incrementalItemIds.length === 0 ||
          incrementalItemIds.some(
            (itemId) => !this.itemBlockIndexes.has(itemId),
          ) ||
          !presentationNeutralTurnUpdate(
            previousInput,
            input,
            incrementalItemIds,
          )),
      )
    const incremental =
      reuse && incrementalItemIds
        ? structuralCandidate
          ? this.structuralTailFrame(
              previousInput,
              input,
              incrementalItemIds,
              damage,
            )
          : this.incrementalFrame(input, incrementalItemIds, damage)
        : undefined
    if (incremental?.frame === this.frame) {
      if (input.mode === this.frame.mode) return this.frame
      const next = this.presentationFrame(input, damage)
      this.displayedInput = Object.freeze({
        ...input,
        transcript: next.transcript,
      })
      this.activityProtectionState = next.transcript
      return this.publish(next, incremental.index)
    }
    const rebuilt = incremental
      ? undefined
      : buildFrame(
          input,
          reuse ? this.frame : undefined,
          this.frame.presentationRevision + 1,
          damage,
          this.diagnostics,
          Boolean(this.windowPolicy),
        )
    if (rebuilt && this.diagnostics) {
      this.diagnostics.completePlanBuilds += 1
      this.diagnostics.completePlanBlockVisits += rebuilt.blocks.length
    }
    const raw = incremental?.frame ?? rebuilt!
    if (rebuilt)
      transcriptTextLengthRange(raw.transcript, 0, 0, this.diagnostics)
    const index = this.heightIndexForActivityChanges(
      raw,
      raw.transcript.folded !== this.frame.transcript.folded
        ? this.heightIndexForFrame(raw)
        : (incremental?.index ??
            (this.heightIndex?.supports(raw.blocks)
              ? this.heightIndex
              : this.heightIndexForFrame(raw))),
    )
    const windowStable = Boolean(
      incremental &&
      (incremental as { readonly windowStable?: true }).windowStable,
    )
    const next = windowStable
      ? raw
      : this.withPlannedWindow(
          raw,
          index,
          displayedReveal(input, raw, this.diagnostics),
        )
    if (!incremental) this.reindex(next.blocks)
    else {
      const appendedItemId = (
        incremental as { readonly appendedItemId?: ItemId }
      ).appendedItemId
      if (appendedItemId)
        this.itemBlockIndexes.set(appendedItemId, next.blocks.length - 1)
    }
    this.displayedInput = Object.freeze({
      ...input,
      transcript: next.transcript,
    })
    this.activityProtectionState = next.transcript
    return this.publish(next, index)
  }

  update(input: TranscriptRuntimeInput): TranscriptFrame {
    if (this.disposed) return this.frame
    if (this.notifying) {
      this.queuedInputs.push(input)
      return this.frame
    }
    const priorInput = this.latestInput
    const priorFrame = this.frame
    const lineageChanged =
      input.threadId !== priorInput.threadId ||
      input.canonicalGeneration !== priorInput.canonicalGeneration
    if (lineageChanged) this.clearRecentGeometry()
    if (
      !lineageChanged &&
      input.canonicalRevision < priorInput.canonicalRevision
    )
      return priorFrame
    if (
      lineageChanged ||
      (input.reveal && input.reveal.id > this.lastRevealId) ||
      (input.canonicalRevision === priorInput.canonicalRevision &&
        input.transcript.viewport !== priorInput.transcript.viewport &&
        input.presentationDamage !== undefined &&
        input.presentationDamage.kind !== "none")
    )
      this.viewportIntentRevision += 1
    const exclusionsChanged = !sameList(
      input.excludedTurnIds,
      priorInput.excludedTurnIds,
    )
    if (
      !lineageChanged &&
      input.canonicalRevision === priorInput.canonicalRevision &&
      input.conversation !== priorInput.conversation
    ) {
      this.latestInput = input
      if (exclusionsChanged)
        this.excludedTurnIds = new Set(input.excludedTurnIds ?? [])
      transcriptOrderIndex(input.transcript.order, this.diagnostics)
      return this.rebuild(input, fullDamage, false)
    }

    const revisionChanged =
      lineageChanged || input.canonicalRevision !== priorInput.canonicalRevision
    const suppliedCanonicalDamage = frozenDamage(input.canonicalDamage)
    const canonicalDamage =
      lineageChanged ||
      exclusionsChanged ||
      (revisionChanged && suppliedCanonicalDamage.kind === "none")
        ? fullDamage
        : suppliedCanonicalDamage
    const presentationDamage = frozenDamage(input.presentationDamage)
    const revealIsNew = Boolean(
      input.reveal && input.reveal.id > this.lastRevealId,
    )
    if (input.reveal)
      this.lastRevealId = Math.max(this.lastRevealId, input.reveal.id)
    this.latestInput = input
    if (lineageChanged || exclusionsChanged)
      this.excludedTurnIds = new Set(input.excludedTurnIds ?? [])
    transcriptOrderIndex(input.transcript.order, this.diagnostics)

    if (lineageChanged)
      return this.rebuild(input, fullDamage, false, undefined, priorInput)
    if (exclusionsChanged)
      return this.rebuild(input, fullDamage, true, undefined, priorInput)

    if (input.mode === "detached") {
      const detaching = priorFrame.mode !== "detached"
      if (detaching && revisionChanged)
        return this.rebuild(
          input,
          mergeDamage(canonicalDamage, presentationDamage),
          true,
          blockDamageIds(canonicalDamage),
          priorInput,
        )
      if (revisionChanged) {
        const hiddenDamage =
          canonicalDamage.kind === "blocks" &&
          (activeTurnPresentationChanged(priorInput, input) ||
            unprovenTurnStructureChanged(
              priorInput,
              input,
              canonicalDamage.itemIds,
            ))
            ? fullDamage
            : canonicalDamage
        this.hiddenDamage.add(hiddenDamage, this.diagnostics)
      }

      if (revealIsNew) {
        const reveal = validReveal(input, this.diagnostics)
        if (!reveal) return priorFrame
        if (!this.revealExistsInDisplayedFrame(input, priorFrame, reveal)) {
          const hiddenDamage = this.hiddenDamage.snapshot(this.diagnostics)
          return this.rebuild(
            input,
            mergeDamage(
              presentationDamage,
              mergeDamage({ kind: "view" }, hiddenDamage),
            ),
            true,
            blockDamageIds(hiddenDamage),
            priorInput,
          )
        }
        return this.publishPresentation(
          input,
          mergeDamage(
            presentationDamage,
            Object.freeze({ kind: "view" as const }),
          ),
        )
      }

      if (detaching || presentationDamage.kind !== "none") {
        return this.publishPresentation(
          input,
          presentationDamage.kind === "none" ? noneDamage : presentationDamage,
        )
      }
      return priorFrame
    }

    const reattaching = priorFrame.mode === "detached"
    if (!reattaching && !revisionChanged && presentationDamage.kind === "none")
      return priorFrame
    const hiddenDamage = reattaching
      ? this.hiddenDamage.snapshot(this.diagnostics)
      : noneDamage
    // A detached viewport can return to follow without any canonical change.
    // Keep the existing block plan and height index in that case: rebuilding
    // the entire history only to change attachment makes `G` scale with it.
    if (
      reattaching &&
      !revisionChanged &&
      priorFrame.displayedCanonicalRevision === input.canonicalRevision &&
      hiddenDamage.kind === "none" &&
      canonicalDamage.kind === "none" &&
      (presentationDamage.kind === "none" ||
        presentationDamage.kind === "view" ||
        presentationDamage.kind === "folds")
    ) {
      this.hiddenDamage.reset()
      return this.publishPresentation(input, presentationDamage)
    }
    const damage = reattaching
      ? mergeDamage(
          hiddenDamage,
          mergeDamage(canonicalDamage, presentationDamage),
        )
      : mergeDamage(canonicalDamage, presentationDamage)
    if (!revisionChanged && !reattaching)
      return this.publishPresentation(input, damage)
    const incrementalItemIds = reattaching
      ? blockDamageIds(hiddenDamage, canonicalDamage)
      : blockDamageIds(canonicalDamage)
    return this.rebuild(input, damage, true, incrementalItemIds, priorInput)
  }

  dispose(): void {
    this.clearRecentGeometry()
    if (this.disposed) return
    this.disposed = true
    this.queuedInputs.length = 0
    this.listeners.clear()
  }
}
