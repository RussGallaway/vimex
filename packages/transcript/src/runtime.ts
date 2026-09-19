import type { ConversationState, ItemId, ThreadId, TurnId } from "@vimex/conversation"
import { inheritTranscriptTextLengthIndexChanges, transcriptOrderIndex, transcriptTextLengthRange, type LogicalPoint, type TranscriptOrderIndexDiagnostics, type TranscriptState, type TranscriptTextLengthIndexDiagnostics } from "./domain/transcript-document"
import { composeTranscriptGeometry, composeTranscriptWindowGeometry, emptyTranscriptGeometry, freezeBlockGeometry, geometryMatchesBlock, type BlockGeometry, type BlockMeasurementBase, type BlockMeasurementBatch, type LayoutResetReason, type TranscriptGeometry } from "./geometry"
import { createHeightIndex, type TranscriptHeightIndex } from "./height-index"
import { blockKey, buildTranscriptBlocks, buildTranscriptItemBlock, passThroughWindow, planTranscriptWindow, pointIsMaterialized, transcriptPointBlockIndex, type TranscriptBlock, type TranscriptItemBlock, type TranscriptWindow } from "./window"

export type TranscriptDamage =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "blocks"; itemIds: readonly ItemId[] }>
  | Readonly<{ kind: "view" }>
  | Readonly<{ kind: "layout" }>
  | Readonly<{ kind: "full" }>

export interface TranscriptRevealRequest {
  readonly id: number
  readonly point: LogicalPoint
  readonly reason: "cursor" | "search" | "mark" | "jump" | "history" | "thread"
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
}

export interface TranscriptRuntimeOptions {
  /** Omit only for inert/test consumers that intentionally retain pass-through materialization. */
  readonly windowPolicy?: TranscriptWindowPolicy
  /** Mutable deterministic counters for tests and diagnostic benchmarks. */
  readonly diagnostics?: TranscriptRuntimeDiagnostics
}

export interface TranscriptRuntimeDiagnostics extends TranscriptOrderIndexDiagnostics, TranscriptTextLengthIndexDiagnostics {
  completePlanBuilds: number
  completePlanBlockVisits: number
}

export const defaultTranscriptWindowPolicy: TranscriptWindowPolicy = Object.freeze({ viewportRows: 24, overscanRows: 24 })

const noneDamage = Object.freeze({ kind: "none" } as const)
const fullDamage = Object.freeze({ kind: "full" } as const)

function frozenDamage(damage: TranscriptDamage | undefined): TranscriptDamage {
  if (!damage || damage.kind === "none") return noneDamage
  if (damage.kind !== "blocks") return Object.freeze({ kind: damage.kind })
  return Object.freeze({ kind: "blocks", itemIds: Object.freeze([...new Set(damage.itemIds)]) })
}

function mergeDamage(left: TranscriptDamage, right: TranscriptDamage): TranscriptDamage {
  if (left.kind === "full" || right.kind === "full") return fullDamage
  if (left.kind === "layout" || right.kind === "layout") return Object.freeze({ kind: "layout" })
  if (left.kind === "view" || right.kind === "view") return Object.freeze({ kind: "view" })
  if (left.kind === "blocks" || right.kind === "blocks") {
    const ids = [...(left.kind === "blocks" ? left.itemIds : []), ...(right.kind === "blocks" ? right.itemIds : [])]
    return frozenDamage({ kind: "blocks", itemIds: ids })
  }
  return noneDamage
}

function blockDamageIds(...damage: readonly TranscriptDamage[]): readonly ItemId[] | undefined {
  const ids = new Set<ItemId>()
  for (const entry of damage) {
    if (entry.kind === "none") continue
    if (entry.kind !== "blocks") return undefined
    for (const id of entry.itemIds) ids.add(id)
  }
  return ids.size ? [...ids] : undefined
}

function sameList<T>(left: readonly T[] | undefined, right: readonly T[] | undefined): boolean {
  if (left === right) return true
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false
  return (left ?? []).every((value, index) => value === right?.[index])
}

function shallowRecordEqual(left: object, right: object): boolean {
  const leftEntries = Object.entries(left), rightEntries = Object.entries(right)
  return leftEntries.length === rightEntries.length && leftEntries.every(([key, value]) => Object.is(value, (right as Record<string, unknown>)[key]))
}

function sameBlock(left: TranscriptBlock, right: TranscriptBlock): boolean {
  if (left.key.kind !== right.key.kind || blockKey(left) !== blockKey(right) || left.contentRevision !== right.contentRevision) return false
  if (left.estimatedRows !== right.estimatedRows) return false
  if ("projection" in left && "projection" in right) return left.turnId === right.turnId
    && left.projection === right.projection
    && left.sourceSpan.from === right.sourceSpan.from
    && left.sourceSpan.to === right.sourceSpan.to
    && left.followedByActivity === right.followedByActivity
    && shallowRecordEqual(left.item, right.item)
    && shallowRecordEqual(left.renderItem, right.renderItem)
  if (!("turn" in left) || !("turn" in right)) return false
  return left.turn.status === right.turn.status
    && left.turn.startedAt === right.turn.startedAt
    && left.turn.completedAt === right.turn.completedAt
    && left.turn.durationMs === right.turn.durationMs
}

function sameWindow(left: TranscriptWindow, right: TranscriptWindow): boolean {
  return left === right || (left.topSpacerRows === right.topSpacerRows
    && left.bottomSpacerRows === right.bottomSpacerRows
    && left.overscanRows === right.overscanRows
    && left.blocks.length === right.blocks.length
    && left.blocks.every((block, index) => block === right.blocks[index]))
}

function reconcileBlocks(previous: readonly TranscriptBlock[], next: readonly TranscriptBlock[]): readonly TranscriptBlock[] {
  const byKey = new Map(previous.map(block => [blockKey(block), block]))
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

function itemBlocks(blocks: readonly TranscriptBlock[]): readonly TranscriptItemBlock[] {
  return blocks.filter((block): block is TranscriptItemBlock => "projection" in block)
}

function sourceOffset(projection: TranscriptItemBlock["projection"], offset: number): number {
  return projection.sourceSpans[offset]?.from ?? projection.source.length
}

function mapPoint(state: TranscriptState, projections: Readonly<Record<string, TranscriptItemBlock["projection"]>>, point: LogicalPoint): LogicalPoint | undefined {
  const latest = state.projectionById[point.itemId], displayed = projections[point.itemId]
  if (!latest || !displayed) return undefined
  const offset = sourceOffset(latest, point.graphemeOffset)
  let low = 0, high = displayed.sourceSpans.length
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
  const point = (value: LogicalPoint | undefined) => value ? mapPoint(state, projectionById, value) : undefined
  const location = (value: { point: LogicalPoint; preferredScreenRow: number }) => {
    const mapped = point(value.point)
    return mapped ? Object.freeze({ ...value, point: mapped }) : undefined
  }
  const cursor = point(state.cursor)
  const selectionAnchor = point(state.selection?.anchor), selectionHead = point(state.selection?.head)
  const viewportPoint = state.viewport.kind === "point" ? point(state.viewport.point) : undefined
  const jumps = Object.freeze({
    back: Object.freeze(state.jumps.back.flatMap(value => location(value) ?? [])),
    forward: Object.freeze(state.jumps.forward.flatMap(value => location(value) ?? [])),
  })
  const marks = Object.freeze(Object.fromEntries(Object.entries(state.marks).flatMap(([name, value]) => {
    const mapped = location(value)
    return mapped ? [[name, mapped]] : []
  })))
  const presented = Object.freeze({
    ...state,
    search: state.search && Object.freeze({ ...state.search }),
    order,
    projectionById,
    cursor,
    selection: state.selection && selectionAnchor && selectionHead
      ? Object.freeze({ ...state.selection, anchor: selectionAnchor, head: selectionHead }) : undefined,
    folded: Object.freeze({ ...state.folded }),
    viewport: state.viewport.kind === "tail" || !viewportPoint
      ? Object.freeze({ kind: "tail" as const })
      : Object.freeze({ ...state.viewport, point: viewportPoint }),
    unseenItemIds: Object.freeze([...state.unseenItemIds]),
    jumps,
    marks,
  })
  transcriptOrderIndex(presented.order)
  return presented
}

function presentationTranscript(state: TranscriptState, blocks: readonly TranscriptBlock[]): TranscriptState {
  const projections = new Map<ItemId, TranscriptItemBlock["projection"]>()
  for (const block of itemBlocks(blocks)) if (!projections.has(block.key.itemId)) projections.set(block.key.itemId, block.projection)
  return presentationTranscriptWithProjections(state, Object.freeze([...projections.keys()]), Object.freeze(Object.fromEntries(projections)))
}

function validReveal(input: TranscriptRuntimeInput, diagnostics?: TranscriptOrderIndexDiagnostics): LogicalPoint | undefined {
  const point = input.reveal?.point
  if (!point || !Number.isInteger(point.graphemeOffset) || point.graphemeOffset < 0) return undefined
  const projection = input.transcript.projectionById[point.itemId]
  if (!projection || !transcriptOrderIndex(input.transcript.order, diagnostics).has(point.itemId) || point.graphemeOffset > projection.sourceSpans.length) return undefined
  return point
}

function displayedReveal(input: TranscriptRuntimeInput, frame: TranscriptFrame, diagnostics?: TranscriptOrderIndexDiagnostics): LogicalPoint | undefined {
  const point = validReveal(input, diagnostics)
  return point ? mapPoint(input.transcript, frame.transcript.projectionById, point) : undefined
}

function reconciledGeometry(previous: TranscriptGeometry | undefined, input: TranscriptRuntimeInput, blocks: readonly TranscriptBlock[]): TranscriptGeometry {
  if (!previous) return composeTranscriptGeometry(blocks, input.transcript.folded, {}, 0, 0)
  return composeTranscriptGeometry(blocks, input.transcript.folded, previous.byBlockKey, previous.generation, previous.revision, previous.width, previous.styleRevision)
}

function pointBlockLocalRow(
  blocks: readonly TranscriptBlock[],
  byBlockKey: Readonly<Record<string, BlockGeometry>>,
  point: LogicalPoint,
): number | undefined {
  for (const block of blocks) {
    if (block.key.kind !== "item" || block.key.itemId !== point.itemId) continue
    const geometry = byBlockKey[blockKey(block)]
    const measured = geometry?.points[point.graphemeOffset]
      ?? (geometry?.key.folded ? Object.values(geometry.points)[0] : undefined)
    if (measured && Number.isSafeInteger(measured.row) && measured.row >= 0 && measured.row < geometry!.rows) return measured.row
  }
  return undefined
}

function frameFor(input: TranscriptRuntimeInput, blocks: readonly TranscriptBlock[], displayedCanonicalRevision: number, revision: number, damage: TranscriptDamage, previousGeometry?: TranscriptGeometry): TranscriptFrame {
  return Object.freeze({
    threadId: input.threadId,
    canonicalGeneration: input.canonicalGeneration,
    displayedCanonicalRevision,
    presentationRevision: revision,
    mode: input.mode,
    transcript: presentationTranscript(input.transcript, blocks),
    blocks,
    window: passThroughWindow(blocks),
    geometry: reconciledGeometry(previousGeometry, input, blocks),
    damage: frozenDamage(damage),
  })
}

function buildFrame(input: TranscriptRuntimeInput, previous: TranscriptFrame | undefined, revision: number, damage: TranscriptDamage): TranscriptFrame {
  const planned = buildTranscriptBlocks({ conversation: input.conversation, transcript: input.transcript, excludedTurnIds: input.excludedTurnIds })
  const blocks = previous ? reconcileBlocks(previous.blocks, planned) : planned
  return frameFor(input, blocks, input.canonicalRevision, revision, damage, previous?.geometry)
}

/** Stateless full-rebuild fallback for inert renderers; it owns no runtime lifetime. */
export function createTranscriptFrame(input: TranscriptRuntimeInput): TranscriptFrame {
  return buildFrame(input, undefined, 1, fullDamage)
}

/**
 * Renderer-neutral presentation cache. It retains one coherent displayed
 * revision while detached; canonical and semantic authority remain upstream.
 */
export class TranscriptRuntime {
  private frame: TranscriptFrame
  private latestInput: TranscriptRuntimeInput
  private windowPolicy: TranscriptWindowPolicy | undefined
  private heightIndex: TranscriptHeightIndex | undefined
  private readonly diagnostics: TranscriptRuntimeDiagnostics | undefined
  private readonly itemBlockIndexes = new Map<ItemId, number>()
  private hiddenDamage: TranscriptDamage = noneDamage
  private readonly listeners = new Set<() => void>()
  private disposed = false
  private notifying = false
  private readonly queuedInputs: TranscriptRuntimeInput[] = []
  private lastRevealId = -1

  constructor(input: TranscriptRuntimeInput, options: TranscriptRuntimeOptions = {}) {
    this.latestInput = input
    this.windowPolicy = options.windowPolicy && Object.freeze({ ...options.windowPolicy })
    this.diagnostics = options.diagnostics
    // Canonical-order indexing is setup work, never a surprise inside the
    // first user-visible reveal against this authoritative snapshot.
    transcriptOrderIndex(input.transcript.order, this.diagnostics)
    const initial = createTranscriptFrame(input)
    transcriptTextLengthRange(initial.transcript, 0, 0, this.diagnostics)
    if (this.diagnostics) {
      this.diagnostics.completePlanBuilds += 1
      this.diagnostics.completePlanBlockVisits += initial.blocks.length
    }
    const index = this.heightIndexForFrame(initial, true)
    this.frame = this.withPlannedWindow(initial, index, displayedReveal(input, initial, this.diagnostics))
    this.heightIndex = index
    this.reindex(this.frame.blocks)
    this.lastRevealId = input.reveal?.id ?? -1
  }

  getSnapshot = (): TranscriptFrame => this.frame
  getThreadId = (): ThreadId => this.latestInput.threadId
  measurementBase = (frame: TranscriptFrame = this.frame): Readonly<BlockMeasurementBase> => Object.freeze({
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

  private heightIndexForFrame(frame: TranscriptFrame, estimatesOnly = false): TranscriptHeightIndex | undefined {
    if (!this.windowPolicy) return undefined
    const blockByKey = new Map(frame.blocks.map(block => [blockKey(block), block]))
    const overrides = estimatesOnly ? [] : Object.values(frame.geometry.byBlockKey).flatMap(geometry => {
      const block = blockByKey.get(geometry.key.blockKey)
      if (!block || !geometryMatchesBlock(geometry, block,
        block.key.kind === "item" && Boolean(frame.transcript.folded[block.key.itemId]))) return []
      return [{ blockKey: geometry.key.blockKey, contentRevision: geometry.key.contentRevision, rows: geometry.rows }]
    })
    return createHeightIndex(frame.blocks, overrides)
  }

  private revealExistsInDisplayedFrame(input: TranscriptRuntimeInput, frame: TranscriptFrame, point: LogicalPoint): boolean {
    const latest = input.transcript.projectionById[point.itemId]
    const displayed = frame.transcript.projectionById[point.itemId]
    if (!latest || !displayed || !latest.source.startsWith(displayed.source)) return false
    const targetSpan = latest.sourceSpans[point.graphemeOffset]
    // A concrete grapheme beginning at the old source end belongs to hidden
    // appended output. The document-end sentinel belongs to the displayed
    // revision only when both revisions have the same source extent.
    if (targetSpan
      ? targetSpan.from >= displayed.source.length || targetSpan.to > displayed.source.length
      : latest.source.length !== displayed.source.length) return false
    const mapped = mapPoint(input.transcript, frame.transcript.projectionById, point)
    if (!mapped) return false
    const index = this.heightIndex
    if (index?.supports(frame.blocks)) return transcriptPointBlockIndex(frame.blocks, index, mapped, undefined) !== undefined
    // Inert consumers intentionally omit windowing and retain the complete
    // reference plan; only that pass-through path may use the linear oracle.
    return !this.windowPolicy && pointIsMaterialized(frame.blocks, mapped)
  }

  private withPlannedWindow(
    frame: TranscriptFrame,
    index: TranscriptHeightIndex | undefined,
    reveal?: LogicalPoint,
    geometryByKey: Readonly<Record<string, BlockGeometry>> = frame.geometry.byBlockKey,
  ): TranscriptFrame {
    if (!this.windowPolicy) return frame
    const viewport = frame.transcript.viewport
    const localRow = viewport.kind === "point"
      ? pointBlockLocalRow(frame.window.blocks, geometryByKey, viewport.point) : undefined
    const attachment = frame.mode === "follow" || viewport.kind === "tail"
      ? Object.freeze({ kind: "tail" as const })
      : Object.freeze({ kind: "point" as const, point: viewport.point, preferredScreenRow: viewport.preferredScreenRow,
        ...(localRow === undefined ? {} : { blockLocalRow: localRow }) })
    const planned = index ? planTranscriptWindow({
      blocks: frame.blocks,
      heights: index,
      viewportRows: this.windowPolicy.viewportRows,
      overscanRows: this.windowPolicy.overscanRows,
      attachment,
      ...(reveal ? { reveal } : {}),
    }) : passThroughWindow(frame.blocks)
    const window = sameWindow(frame.window, planned) ? frame.window : planned
    const alreadyWindowLocal = window === frame.window
      && frame.geometry.totalRows === index?.totalRows
      && frame.geometry.blockRows.length === window.blocks.length
      && frame.geometry.blockRows.every((rows, position) => rows.blockKey === blockKey(window.blocks[position]!))
    const geometry = alreadyWindowLocal ? frame.geometry : composeTranscriptWindowGeometry(
      window.blocks,
      frame.transcript.folded,
      geometryByKey,
      frame.geometry.generation,
      frame.geometry.revision,
      window.topSpacerRows,
      index?.totalRows ?? frame.geometry.totalRows,
      frame.geometry.width,
      frame.geometry.styleRevision,
    )
    return window === frame.window && geometry === frame.geometry ? frame : Object.freeze({ ...frame, window, geometry })
  }

  /** Renderer dimensions refine this presentation's bounded policy; semantic authority stays upstream. */
  setWindowViewport(viewportRows: number, overscanRows = viewportRows): TranscriptFrame {
    if (this.disposed || this.notifying || !Number.isSafeInteger(viewportRows) || viewportRows < 1
      || !Number.isSafeInteger(overscanRows) || overscanRows < 0) return this.frame
    if (this.windowPolicy?.viewportRows === viewportRows && this.windowPolicy.overscanRows === overscanRows) return this.frame
    this.windowPolicy = Object.freeze({ viewportRows, overscanRows })
    const index = this.heightIndex?.supports(this.frame.blocks) ? this.heightIndex : this.heightIndexForFrame(this.frame)
    const next = this.withPlannedWindow(Object.freeze({
      ...this.frame,
      presentationRevision: this.frame.presentationRevision + 1,
      damage: Object.freeze({ kind: "view" as const }),
    }), index)
    return sameWindow(this.frame.window, next.window) ? this.frame : this.publish(next, index)
  }

  private publish(frame: TranscriptFrame, index: TranscriptHeightIndex | undefined = this.heightIndex): TranscriptFrame {
    this.frame = frame
    this.heightIndex = index
    this.notifying = true
    try {
      for (const listener of [...this.listeners]) {
        try { listener() } catch { /* one renderer cannot starve other observers */ }
      }
    } finally { this.notifying = false }
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
      if (block.key.blockId !== "root" || this.itemBlockIndexes.has(block.key.itemId)) this.itemBlockIndexes.set(block.key.itemId, -1)
      else this.itemBlockIndexes.set(block.key.itemId, index)
    }
  }

  private incrementalFrame(input: TranscriptRuntimeInput, itemIds: readonly ItemId[], damage: TranscriptDamage): TranscriptFrame | undefined {
    let nextBlocks: TranscriptBlock[] | undefined
    const projections: Record<string, TranscriptItemBlock["projection"]> = { ...this.frame.transcript.projectionById }
    for (const itemId of itemIds) {
      const index = this.itemBlockIndexes.get(itemId)
      const prior = index === undefined || index < 0 ? undefined : this.frame.blocks[index]
      const next = buildTranscriptItemBlock(input, itemId)
      if (!prior && !next) continue
      if (!prior || !("projection" in prior) || !next || prior.turnId !== next.turnId) return undefined
      projections[itemId] = next.projection
      if (sameBlock(prior, next)) continue
      nextBlocks ??= [...this.frame.blocks]
      nextBlocks[index!] = next
    }
    const blocks = nextBlocks ? Object.freeze(nextBlocks) : this.frame.blocks
    const transcript = presentationTranscriptWithProjections(input.transcript, this.frame.transcript.order, Object.freeze(projections))
    inheritTranscriptTextLengthIndexChanges(this.frame.transcript, transcript, itemIds, this.diagnostics)
    const frame = Object.freeze({
      threadId: input.threadId,
      canonicalGeneration: input.canonicalGeneration,
      displayedCanonicalRevision: input.canonicalRevision,
      presentationRevision: this.frame.presentationRevision + 1,
      mode: input.mode,
      transcript,
      blocks,
      window: passThroughWindow(blocks),
      geometry: reconciledGeometry(this.frame.geometry, input, blocks),
      damage: frozenDamage(damage),
    })
    return frame
  }

  private presentationFrame(input: TranscriptRuntimeInput, damage: TranscriptDamage): TranscriptFrame {
    const geometry = shallowRecordEqual(input.transcript.folded, this.frame.transcript.folded)
      ? this.frame.geometry : reconciledGeometry(this.frame.geometry, input, this.frame.blocks)
    const frame = Object.freeze({
      ...this.frame,
      presentationRevision: this.frame.presentationRevision + 1,
      mode: input.mode,
      transcript: presentationTranscriptWithProjections(input.transcript, this.frame.transcript.order, this.frame.transcript.projectionById),
      geometry,
      damage: frozenDamage(damage),
    })
    return frame
  }

  private publishPresentation(input: TranscriptRuntimeInput, damage: TranscriptDamage): TranscriptFrame {
    const foldsChanged = !shallowRecordEqual(input.transcript.folded, this.frame.transcript.folded)
    const raw = this.presentationFrame(input, damage)
    const index = foldsChanged
      ? this.heightIndexForFrame(raw)
      : this.heightIndex?.supports(raw.blocks) ? this.heightIndex : this.heightIndexForFrame(raw)
    return this.publish(this.withPlannedWindow(raw, index, displayedReveal(input, raw, this.diagnostics)), index)
  }

  /**
   * Atomically accepts one renderer measurement batch when every captured base
   * revision still describes this exact presentation. Stale native work is a
   * strict no-op and can never partially replace newer geometry.
   */
  reportMeasurements(batch: BlockMeasurementBatch): TranscriptFrame {
    if (this.disposed || this.notifying || !batch.measurements.length) return this.frame
    if (batch.threadId !== this.latestInput.threadId
      || batch.canonicalGeneration !== this.latestInput.canonicalGeneration
      || batch.displayedCanonicalRevision !== this.frame.displayedCanonicalRevision
      || batch.basePresentationRevision !== this.frame.presentationRevision
      || batch.geometryGeneration !== this.frame.geometry.generation) return this.frame

    const blocks = new Map(this.frame.window.blocks.map(block => [blockKey(block), block]))
    const measuredKeys = new Set<string>()
    for (const measurement of batch.measurements) {
      if (measuredKeys.has(measurement.key.blockKey)) return this.frame
      measuredKeys.add(measurement.key.blockKey)
      const block = blocks.get(measurement.key.blockKey)
      if (!block || !geometryMatchesBlock(measurement, block,
        block.key.kind === "item" && Boolean(this.frame.transcript.folded[block.key.itemId]))) return this.frame
      if (!Number.isSafeInteger(measurement.nativeRevision) || measurement.nativeRevision < 0
        || !Number.isSafeInteger(measurement.rows) || measurement.rows < 1
        || !Number.isSafeInteger(measurement.key.width) || measurement.key.width < 1) return this.frame
      const prior = this.frame.geometry.byBlockKey[measurement.key.blockKey]
      if (prior && measurement.nativeRevision <= prior.nativeRevision) return this.frame
    }
    const first = batch.measurements[0]!
    if (batch.measurements.some(measurement => measurement.key.width !== first.key.width
      || measurement.key.styleRevision !== first.key.styleRevision)) return this.frame
    if (this.frame.geometry.width !== undefined && (this.frame.geometry.width !== first.key.width
      || this.frame.geometry.styleRevision !== first.key.styleRevision)) return this.frame

    // Geometry retention is deliberately budgeted to one complete variant per
    // materialized block. Replacing the keyed value releases the prior large
    // variant atomically; partial point eviction would corrupt navigation.
    const nextByKey: Record<string, BlockGeometry> = { ...this.frame.geometry.byBlockKey }
    let nextIndex = this.heightIndex?.supports(this.frame.blocks) ? this.heightIndex : this.heightIndexForFrame(this.frame)
    for (const measurement of batch.measurements) {
      const frozen = freezeBlockGeometry(measurement)
      nextByKey[measurement.key.blockKey] = frozen
      if (nextIndex) {
        const blockIndex = nextIndex.blockIndex(measurement.key.blockKey)
        const priorRows = blockIndex === undefined ? undefined : nextIndex.rowRange(blockIndex, blockIndex + 1)?.rows
        const replaced = nextIndex.replaceHeight({
          blockKey: measurement.key.blockKey,
          contentRevision: measurement.key.contentRevision,
          rows: measurement.rows,
        })
        if (replaced === nextIndex && priorRows !== measurement.rows) return this.frame
        nextIndex = replaced
      }
    }
    if (!this.windowPolicy) {
      const geometry = composeTranscriptGeometry(this.frame.blocks, this.frame.transcript.folded, nextByKey,
        this.frame.geometry.generation, this.frame.geometry.revision + 1, first.key.width, first.key.styleRevision)
      return this.publish(Object.freeze({
        ...this.frame,
        presentationRevision: this.frame.presentationRevision + 1,
        geometry,
        damage: noneDamage,
      }), nextIndex)
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
    )
    const corrected = this.withPlannedWindow(Object.freeze({
      ...this.frame,
      presentationRevision: this.frame.presentationRevision + 1,
      geometry,
      damage: noneDamage,
    }), nextIndex, undefined, nextByKey)
    return this.publish(corrected, nextIndex)
  }

  /** Invalidate the active layout generation so late native results are rejected. */
  resetLayout(_reason: LayoutResetReason): TranscriptFrame {
    if (this.disposed || this.notifying) return this.frame
    const geometry = emptyTranscriptGeometry(this.frame.geometry.generation + 1, this.frame.geometry.revision + 1)
    const index = this.heightIndexForFrame(Object.freeze({ ...this.frame, geometry }), true)
    const reset = this.withPlannedWindow(Object.freeze({
      ...this.frame,
      presentationRevision: this.frame.presentationRevision + 1,
      geometry,
      damage: Object.freeze({ kind: "layout" as const }),
    }), index)
    return this.publish(reset, index)
  }

  private rebuild(input: TranscriptRuntimeInput, damage: TranscriptDamage, reuse = true, incrementalItemIds?: readonly ItemId[]): TranscriptFrame {
    this.hiddenDamage = noneDamage
    const incremental = reuse && incrementalItemIds ? this.incrementalFrame(input, incrementalItemIds, damage) : undefined
    const rebuilt = incremental ? undefined : buildFrame(input, reuse ? this.frame : undefined, this.frame.presentationRevision + 1, damage)
    if (rebuilt && this.diagnostics) {
      this.diagnostics.completePlanBuilds += 1
      this.diagnostics.completePlanBlockVisits += rebuilt.blocks.length
    }
    const raw = incremental ?? rebuilt!
    if (rebuilt) transcriptTextLengthRange(raw.transcript, 0, 0, this.diagnostics)
    const index = this.heightIndex?.supports(raw.blocks) ? this.heightIndex : this.heightIndexForFrame(raw)
    const next = this.withPlannedWindow(raw, index, displayedReveal(input, raw, this.diagnostics))
    if (!incremental) this.reindex(next.blocks)
    return this.publish(next, index)
  }

  update(input: TranscriptRuntimeInput): TranscriptFrame {
    if (this.disposed) return this.frame
    if (this.notifying) { this.queuedInputs.push(input); return this.frame }
    const priorInput = this.latestInput
    const priorFrame = this.frame
    const lineageChanged = input.threadId !== priorInput.threadId || input.canonicalGeneration !== priorInput.canonicalGeneration
    if (!lineageChanged && input.canonicalRevision < priorInput.canonicalRevision) return priorFrame
    if (!lineageChanged && input.canonicalRevision === priorInput.canonicalRevision && input.conversation !== priorInput.conversation) {
      this.latestInput = input
      transcriptOrderIndex(input.transcript.order, this.diagnostics)
      return this.rebuild(input, fullDamage, false)
    }

    const revisionChanged = lineageChanged || input.canonicalRevision !== priorInput.canonicalRevision
    const exclusionsChanged = !sameList(input.excludedTurnIds, priorInput.excludedTurnIds)
    const suppliedCanonicalDamage = frozenDamage(input.canonicalDamage)
    const canonicalDamage = lineageChanged || exclusionsChanged || (revisionChanged && suppliedCanonicalDamage.kind === "none")
      ? fullDamage : suppliedCanonicalDamage
    const presentationDamage = frozenDamage(input.presentationDamage)
    const revealIsNew = Boolean(input.reveal && input.reveal.id > this.lastRevealId)
    if (input.reveal) this.lastRevealId = Math.max(this.lastRevealId, input.reveal.id)
    this.latestInput = input
    transcriptOrderIndex(input.transcript.order, this.diagnostics)

    if (lineageChanged) return this.rebuild(input, fullDamage, false)
    if (exclusionsChanged) return this.rebuild(input, fullDamage)

    if (input.mode === "detached") {
      const detaching = priorFrame.mode !== "detached"
      if (detaching && revisionChanged) return this.rebuild(input, mergeDamage(canonicalDamage, presentationDamage), true, blockDamageIds(canonicalDamage))
      if (revisionChanged) this.hiddenDamage = mergeDamage(this.hiddenDamage, canonicalDamage)

      if (revealIsNew) {
        const reveal = validReveal(input, this.diagnostics)
        if (!reveal) return priorFrame
        if (!this.revealExistsInDisplayedFrame(input, priorFrame, reveal)) {
          const hiddenDamage = this.hiddenDamage
          return this.rebuild(input, mergeDamage(presentationDamage, mergeDamage({ kind: "view" }, hiddenDamage)), true, blockDamageIds(hiddenDamage))
        }
        return this.publishPresentation(input, mergeDamage(presentationDamage, Object.freeze({ kind: "view" as const })))
      }

      if (detaching || presentationDamage.kind !== "none") {
        return this.publishPresentation(input, presentationDamage.kind === "none" ? noneDamage : presentationDamage)
      }
      return priorFrame
    }

    const reattaching = priorFrame.mode === "detached"
    if (!reattaching && !revisionChanged && presentationDamage.kind === "none") return priorFrame
    const damage = reattaching
      ? mergeDamage(this.hiddenDamage, mergeDamage(canonicalDamage, presentationDamage))
      : mergeDamage(canonicalDamage, presentationDamage)
    if (!revisionChanged && !reattaching) return this.publishPresentation(input, damage)
    const incrementalItemIds = reattaching
      ? blockDamageIds(this.hiddenDamage, canonicalDamage)
      : blockDamageIds(canonicalDamage)
    return this.rebuild(input, damage, true, incrementalItemIds)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.queuedInputs.length = 0
    this.listeners.clear()
  }
}
