import type { ConversationState, ItemId, ThreadId, TurnId } from "@vimex/conversation"
import type { LogicalPoint, TranscriptState } from "./domain/transcript-document"
import { composeTranscriptGeometry, emptyTranscriptGeometry, freezeBlockGeometry, geometryMatchesBlock, type BlockMeasurementBase, type BlockMeasurementBatch, type LayoutResetReason, type TranscriptGeometry } from "./geometry"
import { blockKey, buildTranscriptBlocks, buildTranscriptItemBlock, passThroughWindow, type TranscriptBlock, type TranscriptItemBlock, type TranscriptWindow } from "./window"

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
    && shallowRecordEqual(left.item, right.item)
    && shallowRecordEqual(left.renderItem, right.renderItem)
  if (!("turn" in left) || !("turn" in right)) return false
  return left.turn.status === right.turn.status
    && left.turn.startedAt === right.turn.startedAt
    && left.turn.completedAt === right.turn.completedAt
    && left.turn.durationMs === right.turn.durationMs
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
  return Object.freeze({
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
}

function presentationTranscript(state: TranscriptState, blocks: readonly TranscriptBlock[]): TranscriptState {
  const projections = new Map<ItemId, TranscriptItemBlock["projection"]>()
  for (const block of itemBlocks(blocks)) if (!projections.has(block.key.itemId)) projections.set(block.key.itemId, block.projection)
  return presentationTranscriptWithProjections(state, Object.freeze([...projections.keys()]), Object.freeze(Object.fromEntries(projections)))
}

function validReveal(input: TranscriptRuntimeInput): LogicalPoint | undefined {
  const point = input.reveal?.point
  if (!point || !Number.isInteger(point.graphemeOffset) || point.graphemeOffset < 0) return undefined
  const projection = input.transcript.projectionById[point.itemId]
  if (!projection || !input.transcript.order.includes(point.itemId) || point.graphemeOffset > projection.sourceSpans.length) return undefined
  return point
}

function revealIsMaterialized(input: TranscriptRuntimeInput, blocks: readonly TranscriptBlock[], point: LogicalPoint): boolean {
  const latest = input.transcript.projectionById[point.itemId]
  if (!latest) return false
  const offset = sourceOffset(latest, point.graphemeOffset)
  return itemBlocks(blocks).some(block => block.key.itemId === point.itemId
    && offset >= block.sourceSpan.from
    && (offset < block.sourceSpan.to
      || (block.sourceSpan.to === latest.source.length && offset === block.sourceSpan.to)))
}

function reconciledGeometry(previous: TranscriptGeometry | undefined, input: TranscriptRuntimeInput, blocks: readonly TranscriptBlock[]): TranscriptGeometry {
  if (!previous) return composeTranscriptGeometry(blocks, input.transcript.folded, {}, 0, 0)
  return composeTranscriptGeometry(blocks, input.transcript.folded, previous.byBlockKey, previous.generation, previous.revision, previous.width, previous.styleRevision)
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
  private readonly itemBlockIndexes = new Map<ItemId, number>()
  private hiddenDamage: TranscriptDamage = noneDamage
  private readonly listeners = new Set<() => void>()
  private disposed = false
  private notifying = false
  private readonly queuedInputs: TranscriptRuntimeInput[] = []
  private lastRevealId = -1

  constructor(input: TranscriptRuntimeInput) {
    this.latestInput = input
    this.frame = createTranscriptFrame(input)
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

  private publish(frame: TranscriptFrame): TranscriptFrame {
    this.frame = frame
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
    let materialized = false
    let projections: Record<string, TranscriptItemBlock["projection"]> | undefined
    for (const itemId of itemIds) {
      const index = this.itemBlockIndexes.get(itemId)
      const prior = index === undefined || index < 0 ? undefined : this.frame.blocks[index]
      const next = buildTranscriptItemBlock(input, itemId)
      if (!prior && !next) continue
      materialized = true
      if (!prior || !("projection" in prior) || !next || prior.turnId !== next.turnId) return undefined
      projections ??= { ...this.frame.transcript.projectionById }
      projections[itemId] = next.projection
      if (sameBlock(prior, next)) continue
      nextBlocks ??= [...this.frame.blocks]
      nextBlocks[index!] = next
    }
    // Canonical-only items (for example reasoning) never enter the semantic
    // transcript. Advancing them must not publish a frame or wake renderers.
    if (!materialized) return this.frame
    const blocks = nextBlocks ? Object.freeze(nextBlocks) : this.frame.blocks
    const transcript = presentationTranscriptWithProjections(input.transcript, this.frame.transcript.order, Object.freeze(projections!))
    return Object.freeze({
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
  }

  private presentationFrame(input: TranscriptRuntimeInput, damage: TranscriptDamage): TranscriptFrame {
    const geometry = shallowRecordEqual(input.transcript.folded, this.frame.transcript.folded)
      ? this.frame.geometry : reconciledGeometry(this.frame.geometry, input, this.frame.blocks)
    return Object.freeze({
      ...this.frame,
      presentationRevision: this.frame.presentationRevision + 1,
      mode: input.mode,
      transcript: presentationTranscriptWithProjections(input.transcript, this.frame.transcript.order, this.frame.transcript.projectionById),
      geometry,
      damage: frozenDamage(damage),
    })
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

    const blocks = new Map(this.frame.blocks.map(block => [blockKey(block), block]))
    const measuredKeys = new Set<string>()
    for (const measurement of batch.measurements) {
      if (measuredKeys.has(measurement.key.blockKey)) return this.frame
      measuredKeys.add(measurement.key.blockKey)
      const block = blocks.get(measurement.key.blockKey)
      if (!block || !geometryMatchesBlock(measurement, block,
        block.key.kind === "item" && Boolean(this.frame.transcript.folded[block.key.itemId]))) return this.frame
      if (!Number.isInteger(measurement.nativeRevision) || measurement.nativeRevision < 0
        || !Number.isInteger(measurement.rows) || measurement.rows < 1
        || !Number.isInteger(measurement.key.width) || measurement.key.width < 1) return this.frame
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
    const nextByKey: Record<string, import("./geometry").BlockGeometry> = { ...this.frame.geometry.byBlockKey }
    let changed = false
    for (const measurement of batch.measurements) {
      const frozen = freezeBlockGeometry(measurement)
      nextByKey[measurement.key.blockKey] = frozen
      changed = true
    }
    if (!changed) return this.frame
    const geometry = composeTranscriptGeometry(this.frame.blocks, this.frame.transcript.folded, nextByKey,
      this.frame.geometry.generation, this.frame.geometry.revision + 1, first.key.width, first.key.styleRevision)
    return this.publish(Object.freeze({
      ...this.frame,
      presentationRevision: this.frame.presentationRevision + 1,
      geometry,
      damage: noneDamage,
    }))
  }

  /** Invalidate the active layout generation so late native results are rejected. */
  resetLayout(_reason: LayoutResetReason): TranscriptFrame {
    if (this.disposed || this.notifying) return this.frame
    const geometry = emptyTranscriptGeometry(this.frame.geometry.generation + 1, this.frame.geometry.revision + 1)
    return this.publish(Object.freeze({
      ...this.frame,
      presentationRevision: this.frame.presentationRevision + 1,
      geometry,
      damage: Object.freeze({ kind: "layout" as const }),
    }))
  }

  private rebuild(input: TranscriptRuntimeInput, damage: TranscriptDamage, reuse = true, incrementalItemIds?: readonly ItemId[]): TranscriptFrame {
    this.hiddenDamage = noneDamage
    const incremental = reuse && incrementalItemIds ? this.incrementalFrame(input, incrementalItemIds, damage) : undefined
    if (incremental === this.frame) {
      return input.mode === this.frame.mode ? this.frame : this.publish(this.presentationFrame(input, damage))
    }
    const next = incremental ?? buildFrame(input, reuse ? this.frame : undefined, this.frame.presentationRevision + 1, damage)
    if (!incremental) this.reindex(next.blocks)
    return this.publish(next)
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

    if (lineageChanged) return this.rebuild(input, fullDamage, false)
    if (exclusionsChanged) return this.rebuild(input, fullDamage)

    if (input.mode === "detached") {
      const detaching = priorFrame.mode !== "detached"
      if (detaching && revisionChanged) return this.rebuild(input, mergeDamage(canonicalDamage, presentationDamage), true, blockDamageIds(canonicalDamage))
      if (revisionChanged) this.hiddenDamage = mergeDamage(this.hiddenDamage, canonicalDamage)

      if (revealIsNew) {
        const reveal = validReveal(input)
        if (!reveal) return priorFrame
        if (!revealIsMaterialized(input, priorFrame.blocks, reveal)) {
          const hiddenDamage = this.hiddenDamage
          return this.rebuild(input, mergeDamage(presentationDamage, mergeDamage({ kind: "view" }, hiddenDamage)), true, blockDamageIds(hiddenDamage))
        }
        return this.publish(this.presentationFrame(input, mergeDamage(presentationDamage, Object.freeze({ kind: "view" as const }))))
      }

      if (detaching || presentationDamage.kind !== "none") {
        return this.publish(this.presentationFrame(input, presentationDamage.kind === "none" ? noneDamage : presentationDamage))
      }
      return priorFrame
    }

    const reattaching = priorFrame.mode === "detached"
    if (!reattaching && !revisionChanged && presentationDamage.kind === "none") return priorFrame
    const damage = reattaching
      ? mergeDamage(this.hiddenDamage, mergeDamage(canonicalDamage, presentationDamage))
      : mergeDamage(canonicalDamage, presentationDamage)
    if (!revisionChanged && !reattaching) return this.publish(this.presentationFrame(input, damage))
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
