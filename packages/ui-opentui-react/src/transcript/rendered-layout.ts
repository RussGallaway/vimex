import type { CliRenderer, Renderable, ScrollBoxRenderable } from "@opentui/core"
import type { ConversationItem, ItemId, TurnId } from "@vimex/conversation"
import {
  blockKey,
  blockGraphemeRange,
  composeTranscriptGeometry,
  type BlockGeometry,
  type GeometryStyleRevision,
  type LogicalPoint,
  type TranscriptBlock,
  type TranscriptFrame,
  type TranscriptItemBlock,
  type TranscriptRuntime,
  type TranscriptState,
} from "@vimex/transcript"
import { blockRefForPoint, pointInLayout, type MeasuredPoint, type TranscriptLayout, type VisualLine } from "./layout"
import { invalidateRenderedBlock, measureRenderedBlock, takeDirtyRenderedBlocks } from "./measure-rendered-block"

export interface RuntimeLayoutSource {
  readonly frame: TranscriptFrame
  readonly runtime?: TranscriptRuntime
  readonly styleRevision: GeometryStyleRevision
  readonly diagnostics?: RenderedLayoutDiagnostics
}

/** Mutable deterministic counters for focused tests and diagnostic benchmarks. */
export interface RenderedLayoutDiagnostics {
  candidateBlocks: number
  visibleCandidates: number
  overscanCandidates: number
  attemptedMeasurements: number
  changedMeasurements: number
  cachedMeasurements: number
  rejectedMeasurements: number
  placementValidationVisits: number
  pendingAfter: number
  trackedMountedRoots: number
  prunedRoots: number
  visibleBeforeOverscan: boolean
  attemptedKeys?: string[]
}

interface LayoutCache {
  readonly geometry: TranscriptFrame["geometry"]
  readonly materializedBlocks?: readonly TranscriptBlock[]
  readonly originX: number
  readonly originY: number
  readonly layout: TranscriptLayout
}

const layoutCache = new WeakMap<ScrollBoxRenderable, LayoutCache>()
const legacyGeometryCache = new WeakMap<ScrollBoxRenderable, {
  order: TranscriptState["order"]
  projectionById: TranscriptState["projectionById"]
  folded: TranscriptState["folded"]
  width: number
  measurements: readonly BlockGeometry[]
  geometry: TranscriptFrame["geometry"]
}>()
interface MeasurementSchedule {
  threadId?: string
  canonicalGeneration?: number
  geometryGeneration?: number
  windowBlocks?: readonly TranscriptBlock[]
  readonly pending: Set<string>
  readonly rejectedRetries: Map<string, number>
  readonly indexByKey: Map<string, number>
  readonly keysByItem: Map<string, readonly string[]>
  readonly renderableByKey: Map<string, Renderable>
}
const TRANSIENT_MEASUREMENT_RETRY_LIMIT = 8
const measurementSchedules = new WeakMap<ScrollBoxRenderable, MeasurementSchedule>()

function scheduleFor(scrollbox: ScrollBoxRenderable): MeasurementSchedule {
  let schedule = measurementSchedules.get(scrollbox)
  if (!schedule) {
    schedule = { pending: new Set(), rejectedRetries: new Map(), indexByKey: new Map(), keysByItem: new Map(), renderableByKey: new Map() }
    measurementSchedules.set(scrollbox, schedule)
  }
  return schedule
}

function indexBlocks(schedule: MeasurementSchedule, blocks: readonly TranscriptBlock[]): void {
  schedule.indexByKey.clear()
  schedule.keysByItem.clear()
  blocks.forEach((block, index) => {
    const key = blockKey(block)
    schedule.indexByKey.set(key, index)
    if (block.key.kind === "item") schedule.keysByItem.set(block.key.itemId, Object.freeze([...(schedule.keysByItem.get(block.key.itemId) ?? []), key]))
  })
}

interface ScheduleSynchronization {
  readonly lineageChanged: boolean
  readonly layoutReset: boolean
  readonly windowChanged: boolean
  readonly priorByKey: ReadonlyMap<string, TranscriptBlock>
}

function synchronizeMeasurementSchedule(
  scrollbox: ScrollBoxRenderable,
  frame: TranscriptFrame,
  diagnostics?: RenderedLayoutDiagnostics,
): ScheduleSynchronization {
  const schedule = scheduleFor(scrollbox)
  const blocks = frame.window.blocks
  const lineageChanged = schedule.threadId !== frame.threadId || schedule.canonicalGeneration !== frame.canonicalGeneration
  const layoutReset = schedule.geometryGeneration !== frame.geometry.generation
  const windowChanged = schedule.windowBlocks !== blocks
  const priorByKey = new Map((schedule.windowBlocks ?? []).map(block => [blockKey(block), block]))
  if (lineageChanged || layoutReset) {
    schedule.pending.clear()
    schedule.rejectedRetries.clear()
    if (diagnostics) diagnostics.prunedRoots += schedule.renderableByKey.size
    schedule.renderableByKey.clear()
    indexBlocks(schedule, blocks)
    for (const block of blocks) schedule.pending.add(blockKey(block))
  } else if (windowChanged) {
    const mountedKeys = new Set(blocks.map(blockKey))
    for (const key of schedule.pending) if (!mountedKeys.has(key)) {
      schedule.pending.delete(key)
      schedule.rejectedRetries.delete(key)
    }
    for (const key of schedule.renderableByKey.keys()) if (!mountedKeys.has(key)) {
      schedule.renderableByKey.delete(key)
      schedule.rejectedRetries.delete(key)
      if (diagnostics) diagnostics.prunedRoots += 1
    }
    indexBlocks(schedule, blocks)
    for (const block of blocks) if (priorByKey.get(blockKey(block)) !== block) schedule.pending.add(blockKey(block))
  }
  schedule.threadId = frame.threadId
  schedule.canonicalGeneration = frame.canonicalGeneration
  schedule.geometryGeneration = frame.geometry.generation
  schedule.windowBlocks = blocks
  if (diagnostics) {
    diagnostics.pendingAfter = schedule.pending.size
    diagnostics.trackedMountedRoots = schedule.renderableByKey.size
  }
  return { lineageChanged, layoutReset, windowChanged, priorByKey }
}

/** Drop scheduler ownership for departed roots without inspecting or measuring native content. */
export function synchronizeRenderedTranscriptWindow(
  scrollbox: ScrollBoxRenderable,
  frame: TranscriptFrame,
  diagnostics?: RenderedLayoutDiagnostics,
): void {
  synchronizeMeasurementSchedule(scrollbox, frame, diagnostics)
}

/** Release all renderer-side presentation caches owned by an unmounted transcript root. */
export function releaseRenderedTranscriptLayout(scrollbox: ScrollBoxRenderable): void {
  measurementSchedules.delete(scrollbox)
  layoutCache.delete(scrollbox)
  legacyGeometryCache.delete(scrollbox)
}

export function transcriptBlockRenderableId(block: Pick<TranscriptBlock, "key">): string {
  return block.key.kind === "item"
    ? transcriptItemRenderableId(block.key.itemId, block.key.blockId)
    : `transcript-block:turn-activity:${block.key.turnId}`
}

export function transcriptItemRenderableId(itemId: ItemId, blockId = "root"): string {
  return `transcript-block:${itemId}:${blockId}`
}

export function transcriptRenderableIdForPoint(layout: TranscriptLayout, point: LogicalPoint): string {
  return transcriptItemRenderableId(point.itemId, blockRefForPoint(layout, point)?.blockId ?? "root")
}

function legacyRenderableId(itemId: ItemId): string {
  return `transcript-item:${itemId}`
}

function translatedLayout(layout: TranscriptLayout, x: number, y: number): TranscriptLayout {
  const translated = Object.create(Object.getPrototypeOf(layout)) as TranscriptLayout
  const descriptors = Object.getOwnPropertyDescriptors(layout)
  delete descriptors.screenOffset
  Object.defineProperties(translated, descriptors)
  Object.defineProperty(translated, "screenOffset", { enumerable: true, configurable: false, value: Object.freeze({ x, y }) })
  return Object.freeze(translated)
}

/** Translate cached native placement after a scroll without measuring roots. */
export function translateTranscriptLayout(layout: TranscriptLayout, deltaX: number, deltaY: number): TranscriptLayout {
  if (!deltaX && !deltaY) return layout
  return translatedLayout(layout, (layout.screenOffset?.x ?? 0) + deltaX, (layout.screenOffset?.y ?? 0) + deltaY)
}

function findBlockRenderable(scrollbox: ScrollBoxRenderable, block: TranscriptBlock): Renderable | undefined {
  return scrollbox.getRenderable(transcriptBlockRenderableId(block))
    ?? (block.key.kind === "item" ? scrollbox.getRenderable(legacyRenderableId(block.key.itemId)) : undefined)
}

function syntheticBlocks(state: TranscriptState): readonly TranscriptItemBlock[] {
  return state.order.flatMap((id) => {
    const projection = state.projectionById[id]
    if (!projection) return []
    const item = { id, turnId: "__geometry__" as TurnId, kind: "assistant", markdown: projection.source, status: "complete" } as ConversationItem
    return [{
      key: { kind: "item" as const, itemId: id, blockId: "root" },
      turnId: "__geometry__" as TurnId,
      item,
      renderItem: item,
      projection,
      sourceSpan: { from: 0, to: projection.source.length },
      contentRevision: projection.revision,
      estimatedRows: 1,
      followedByActivity: false,
    } satisfies TranscriptItemBlock]
  })
}

function linesFor(geometry: TranscriptFrame["geometry"], blocks: readonly TranscriptBlock[]): { lines: readonly VisualLine[]; linesByItem: Readonly<Record<string, readonly VisualLine[]>> } {
  const lines: VisualLine[] = []
  const linesByItem: Record<string, VisualLine[]> = {}
  for (const block of blocks) {
    if (!("projection" in block)) continue
    const key = blockKey(block)
    const start = geometry.rowByBlockKey[key] ?? 0
    const itemLines = (geometry.byBlockKey[key]?.lines ?? []).map(line => ({ itemId: block.key.itemId, from: line.from, to: line.to, row: start + line.row }))
    linesByItem[block.key.itemId] = [...(linesByItem[block.key.itemId] ?? []), ...itemLines]
    lines.push(...itemLines)
  }
  return { lines: Object.freeze(lines), linesByItem: Object.freeze(linesByItem) }
}

function lazyPoints(layout: TranscriptLayout, blocks: readonly TranscriptBlock[]): TranscriptLayout["points"] {
  const itemBlocks = blocks.filter((block): block is TranscriptItemBlock => "projection" in block)
  const itemIds = [...new Set(itemBlocks.map(block => block.key.itemId))]
  const itemRecords = new Map<string, object>()
  return new Proxy(Object.create(null) as Record<string, Readonly<Record<number, MeasuredPoint>>>, {
    ownKeys: () => itemIds,
    getOwnPropertyDescriptor: (_target, property) => typeof property === "string" && itemIds.includes(property as ItemId)
      ? { enumerable: true, configurable: true } : undefined,
    get: (_target, property) => {
      if (typeof property !== "string") return undefined
      const cached = itemRecords.get(property)
      if (cached) return cached
      const blocksForItem = itemBlocks.filter(candidate => candidate.key.itemId === property)
      if (!blocksForItem.length) return undefined
      const offsets = [...new Set(blocksForItem.flatMap(block => Object.keys(layout.geometry?.byBlockKey[blockKey(block)]?.points ?? {})))].sort((left, right) => Number(left) - Number(right))
      const record = new Proxy(Object.create(null) as Record<number, MeasuredPoint>, {
        ownKeys: () => offsets,
        getOwnPropertyDescriptor: (_inner, offset) => typeof offset === "string" && offsets.includes(offset)
          ? { enumerable: true, configurable: true } : undefined,
        get: (_inner, offset) => {
          if (typeof offset !== "string") return undefined
          return pointInLayout(layout, { itemId: blocksForItem[0]!.key.itemId, graphemeOffset: Number(offset) })
        },
      })
      itemRecords.set(property, record)
      return record
    },
  })
}

function buildLayout(
  scrollbox: ScrollBoxRenderable,
  blocks: readonly TranscriptBlock[],
  geometry: TranscriptFrame["geometry"],
  materializedBlocks?: readonly TranscriptBlock[],
): TranscriptLayout {
  const placementByBlockKey: Record<string, { screenX: number; screenY: number }> = {}
  const blockKeyByItem: Record<string, string> = {}
  const blockKeysByItem: Record<string, { blockKey: string; blockId: string; from: number; to: number }[]> = {}
  for (const block of blocks) {
    const renderable = findBlockRenderable(scrollbox, block)
    if (!renderable) continue
    const key = blockKey(block)
    placementByBlockKey[key] = { screenX: renderable.screenX, screenY: renderable.screenY }
    if (!("projection" in block)) continue
    blockKeyByItem[block.key.itemId] ??= key
    const { from, to } = blockGraphemeRange(block)
    ;(blockKeysByItem[block.key.itemId] ??= []).push({ blockKey: key, blockId: block.key.blockId, from, to })
  }
  const layout = {
    width: scrollbox.viewport.width,
    ...(materializedBlocks ? { materializedBlocks } : {}),
    geometry,
    placementByBlockKey: Object.freeze(placementByBlockKey),
    blockKeysByItem: Object.freeze(Object.fromEntries(Object.entries(blockKeysByItem).map(([itemId, refs]) => [itemId, Object.freeze(refs.map(ref => Object.freeze(ref)))]))),
    blockKeyByItem: Object.freeze(blockKeyByItem),
    screenBlockRows: Object.freeze(blocks.flatMap(block => {
      if (!("projection" in block)) return []
      const key = blockKey(block)
      const placement = placementByBlockKey[key]
      if (!placement) return []
      const rows = geometry.byBlockKey[key]?.rows ?? Math.max(1, block.estimatedRows)
      return [Object.freeze({ blockKey: key, itemId: block.key.itemId, screenY: placement.screenY, rows })]
    })),
  } as TranscriptLayout
  let indexed: ReturnType<typeof linesFor> | undefined
  const indexes = () => indexed ??= linesFor(geometry, blocks)
  Object.defineProperty(layout, "lines", { enumerable: true, configurable: false, get: () => indexes().lines })
  Object.defineProperty(layout, "linesByItem", { enumerable: true, configurable: false, get: () => indexes().linesByItem })
  Object.defineProperty(layout, "points", { enumerable: true, configurable: false, value: lazyPoints(layout, blocks) })
  return Object.freeze(layout)
}

function placementsMatch(
  scrollbox: ScrollBoxRenderable,
  blocks: readonly TranscriptBlock[],
  layout: TranscriptLayout,
  offset: Readonly<{ x: number; y: number }>,
  diagnostics?: RenderedLayoutDiagnostics,
): boolean {
  for (const block of blocks) {
    if (diagnostics) diagnostics.placementValidationVisits += 1
    const renderable = findBlockRenderable(scrollbox, block)
    const placement = layout.placementByBlockKey?.[blockKey(block)]
    if (!renderable || !placement) {
      if (renderable || placement) return false
      continue
    }
    if (renderable.screenX !== placement.screenX + offset.x || renderable.screenY !== placement.screenY + offset.y) return false
  }
  return true
}

function currentGeometry(renderer: CliRenderer, scrollbox: ScrollBoxRenderable, source: RuntimeLayoutSource | TranscriptState): { blocks: readonly TranscriptBlock[]; geometry: TranscriptFrame["geometry"] } {
  const runtimeSource = "frame" in source ? source : undefined
  const diagnostics = runtimeSource?.diagnostics
  if (diagnostics) {
    diagnostics.candidateBlocks = 0
    diagnostics.visibleCandidates = 0
    diagnostics.overscanCandidates = 0
    diagnostics.attemptedMeasurements = 0
    diagnostics.changedMeasurements = 0
    diagnostics.cachedMeasurements = 0
    diagnostics.rejectedMeasurements = 0
    diagnostics.placementValidationVisits = 0
    diagnostics.pendingAfter = 0
    diagnostics.trackedMountedRoots = 0
    diagnostics.prunedRoots = 0
    diagnostics.visibleBeforeOverscan = true
    if (diagnostics.attemptedKeys) diagnostics.attemptedKeys.length = 0
  }
  const frame = runtimeSource?.frame
  const blocks: readonly TranscriptBlock[] = frame?.window.blocks ?? syntheticBlocks(source as TranscriptState)
  const state = frame?.transcript ?? source as TranscriptState
  const width = Math.max(1, scrollbox.viewport.width)
  const styleRevision = runtimeSource?.styleRevision ?? "legacy"
  if (runtimeSource?.runtime && frame!.geometry.width !== undefined
    && (frame!.geometry.width !== width || frame!.geometry.styleRevision !== styleRevision)) {
    runtimeSource.runtime.resetLayout(frame!.geometry.width !== width ? "width" : "style")
    return { blocks, geometry: frame!.geometry }
  }
  const schedule = scheduleFor(scrollbox)
  const candidates = new Set<string>()
  if (!runtimeSource?.runtime) {
    for (const block of blocks) if ("projection" in block) candidates.add(blockKey(block))
  } else {
    const { lineageChanged, layoutReset, windowChanged, priorByKey } = synchronizeMeasurementSchedule(scrollbox, frame!, diagnostics)
    if (lineageChanged || layoutReset) {
      for (const block of blocks) candidates.add(blockKey(block))
    } else {
      if (windowChanged) {
        for (const block of blocks) {
          const key = blockKey(block)
          const geometry = frame!.geometry.byBlockKey[key]
          const folded = block.key.kind === "item" && Boolean(state.folded[block.key.itemId])
          if (priorByKey.get(key) !== block || !geometry || geometry.key.contentRevision !== block.contentRevision
            || geometry.key.folded !== folded || geometry.key.width !== width || geometry.key.styleRevision !== styleRevision) candidates.add(key)
        }
      }
      for (const block of blocks) {
        const key = blockKey(block)
        const renderable = findBlockRenderable(scrollbox, block)
        const tracked = schedule.renderableByKey.get(key)
        if (renderable && tracked && renderable !== tracked) candidates.add(key)
      }
      if (frame!.damage.kind === "full" || frame!.damage.kind === "layout") {
        for (const block of blocks) candidates.add(blockKey(block))
      } else if (frame!.damage.kind === "blocks" || frame!.damage.kind === "folds") {
        for (const itemId of frame!.damage.itemIds) {
          const keys = schedule.keysByItem.get(itemId)
          if (keys?.length) for (const key of keys) candidates.add(key)
        }
      }
    }
    for (const dirty of takeDirtyRenderedBlocks()) {
      if (dirty.blockKey && schedule.renderableByKey.get(dirty.blockKey) === dirty.renderable) candidates.add(dirty.blockKey)
    }
    for (const key of schedule.pending) {
      candidates.add(key)
    }
  }
  const measurementBase = runtimeSource?.runtime?.measurementBase(frame)
  const measured: BlockGeometry[] = []
  const top = scrollbox.viewport.screenY
  const bottom = top + scrollbox.viewport.height
  const orderedCandidates = [...candidates].flatMap(key => {
    const index = schedule.indexByKey.get(key)
    const block = index === undefined ? blocks.find(candidate => blockKey(candidate) === key) : blocks[index]
    if (!block) return []
    const renderable = findBlockRenderable(scrollbox, block)
    if (!renderable) return []
    schedule.renderableByKey.set(key, renderable)
    const visible = renderable.screenY < bottom && renderable.screenY + renderable.height > top
    const distance = visible ? 0 : renderable.screenY >= bottom ? renderable.screenY - bottom : top - (renderable.screenY + renderable.height)
    return [{ key, block, renderable, visible, distance, index: index ?? Number.MAX_SAFE_INTEGER }]
  }).sort((left, right) => Number(right.visible) - Number(left.visible) || left.distance - right.distance || left.index - right.index)
  if (diagnostics) {
    diagnostics.candidateBlocks = candidates.size
    diagnostics.visibleCandidates = orderedCandidates.filter(candidate => candidate.visible).length
    diagnostics.overscanCandidates = orderedCandidates.length - diagnostics.visibleCandidates
    diagnostics.attemptedMeasurements = orderedCandidates.length
    diagnostics.visibleBeforeOverscan = orderedCandidates.slice(0, diagnostics.visibleCandidates).every(candidate => candidate.visible)
      && orderedCandidates.slice(diagnostics.visibleCandidates).every(candidate => !candidate.visible)
    diagnostics.attemptedKeys?.push(...orderedCandidates.map(candidate => candidate.key))
  }
  let rejectedMeasurements = 0
  for (const { key, block, renderable } of orderedCandidates) {
    const next = measureRenderedBlock({ renderer, renderable, block, width, styleRevision,
      folded: block.key.kind === "item" && Boolean(state.folded[block.key.itemId]) })
    // React/OpenTUI can briefly expose a newly reconciled child at its final
    // coordinate while the owning block still reports its prior placement.
    // Such a sample is not block-local geometry; retry it on the next frame
    // instead of poisoning the height index with a transient global delta.
    if (next.rows > Math.max(1, renderable.height)) {
      const retry = (schedule.rejectedRetries.get(key) ?? 0) + 1
      schedule.rejectedRetries.set(key, retry)
      if (retry <= TRANSIENT_MEASUREMENT_RETRY_LIMIT) {
        schedule.pending.add(key)
        invalidateRenderedBlock(renderable)
        renderer.requestRender()
      } else schedule.pending.delete(key)
      rejectedMeasurements += 1
      continue
    }
    schedule.rejectedRetries.delete(key)
    const prior = frame?.geometry.byBlockKey[blockKey(block)]
    if (!prior || prior.nativeRevision !== next.nativeRevision || prior.key.contentRevision !== next.key.contentRevision
      || prior.key.width !== next.key.width || prior.key.styleRevision !== next.key.styleRevision || prior.key.folded !== next.key.folded) measured.push(next)
    else schedule.pending.delete(key)
  }
  if (runtimeSource?.runtime && measured.length) {
    for (const geometry of measured) schedule.pending.add(geometry.key.blockKey)
    runtimeSource.runtime.reportMeasurements({ ...measurementBase!, measurements: measured })
    if (diagnostics) {
      diagnostics.changedMeasurements = measured.length
      diagnostics.cachedMeasurements = orderedCandidates.length - measured.length - rejectedMeasurements
      diagnostics.rejectedMeasurements = rejectedMeasurements
      diagnostics.pendingAfter = schedule.pending.size
      diagnostics.trackedMountedRoots = schedule.renderableByKey.size
    }
    return { blocks, geometry: frame!.geometry }
  }
  if (diagnostics) {
    diagnostics.changedMeasurements = measured.length
    diagnostics.cachedMeasurements = orderedCandidates.length - measured.length - rejectedMeasurements
    diagnostics.rejectedMeasurements = rejectedMeasurements
    diagnostics.pendingAfter = schedule.pending.size
    diagnostics.trackedMountedRoots = schedule.renderableByKey.size
  }
  if (frame && runtimeSource?.runtime) return { blocks, geometry: frame.geometry }
  const legacy = legacyGeometryCache.get(scrollbox)
  if (legacy && legacy.order === state.order && legacy.projectionById === state.projectionById && legacy.folded === state.folded
    && legacy.width === width && legacy.measurements.length === measured.length
    && measured.every((geometry, index) => geometry === legacy.measurements[index])) return { blocks, geometry: legacy.geometry }
  const byBlockKey = Object.fromEntries(measured.map(geometry => [geometry.key.blockKey, geometry]))
  const geometry = composeTranscriptGeometry(blocks, state.folded, byBlockKey, 0, 1, width, styleRevision)
  legacyGeometryCache.set(scrollbox, { order: state.order, projectionById: state.projectionById, folded: state.folded, width, measurements: measured, geometry })
  return { blocks, geometry }
}

export function measureRenderedTranscript(renderer: CliRenderer, scrollbox: ScrollBoxRenderable, source: RuntimeLayoutSource | TranscriptState): TranscriptLayout | undefined {
  const { blocks, geometry } = currentGeometry(renderer, scrollbox, source)
  const materializedBlocks = "frame" in source ? blocks : undefined
  if (geometry.measuredBlockCount === 0) return undefined
  const originX = scrollbox.viewport.screenX - scrollbox.scrollLeft
  const originY = scrollbox.viewport.screenY - scrollbox.scrollTop
  const cached = layoutCache.get(scrollbox)
  if (cached?.geometry === geometry && cached.materializedBlocks === materializedBlocks) {
    const offset = { x: originX - cached.originX, y: originY - cached.originY }
    if (placementsMatch(scrollbox, blocks, cached.layout, offset, "frame" in source ? source.diagnostics : undefined)) {
      if (offset.x === (cached.layout.screenOffset?.x ?? 0) && offset.y === (cached.layout.screenOffset?.y ?? 0)) return cached.layout
      const translated = translatedLayout(cached.layout, offset.x, offset.y)
      layoutCache.set(scrollbox, { ...cached, layout: translated })
      return translated
    }
  }
  const layout = buildLayout(scrollbox, blocks, geometry, materializedBlocks)
  layoutCache.set(scrollbox, { geometry, materializedBlocks, originX, originY, layout })
  return layout
}

export function measuredPoint(layout: TranscriptLayout, point: LogicalPoint | undefined): MeasuredPoint | undefined {
  return pointInLayout(layout, point)
}

/** Current runtime geometry with the last known native placements; never exposes stale block geometry. */
export function rebaseTranscriptLayout(layout: TranscriptLayout, geometry: TranscriptFrame["geometry"]): TranscriptLayout {
  const screenBlockRows = (layout.screenBlockRows ?? []).flatMap(row => {
    const placement = layout.placementByBlockKey?.[row.blockKey]
    return placement ? [Object.freeze({ ...row, screenY: placement.screenY, rows: geometry.byBlockKey[row.blockKey]?.rows ?? row.rows })] : []
  })
  return Object.freeze({
    width: layout.width,
    ...(layout.materializedBlocks ? { materializedBlocks: layout.materializedBlocks } : {}),
    lines: Object.freeze([]),
    linesByItem: Object.freeze({}),
    geometry,
    placementByBlockKey: layout.placementByBlockKey,
    blockKeysByItem: layout.blockKeysByItem,
    blockKeyByItem: layout.blockKeyByItem,
    screenBlockRows: Object.freeze(screenBlockRows),
    screenOffset: layout.screenOffset,
  })
}

export function visibleMeasuredPoints(layout: TranscriptLayout, viewport: { screenY: number; height: number }): readonly MeasuredPoint[] {
  if (!layout.geometry || !layout.screenBlockRows) return Object.values(layout.points ?? {}).flatMap(points => Object.values(points))
  const result: MeasuredPoint[] = []
  const offsetY = layout.screenOffset?.y ?? 0
  const top = viewport.screenY - offsetY
  const bottom = top + viewport.height
  let low = 0, high = layout.screenBlockRows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const block = layout.screenBlockRows[middle]!
    if (block.screenY + block.rows <= top) low = middle + 1
    else high = middle
  }
  for (let index = low; index < layout.screenBlockRows.length; index++) {
    const block = layout.screenBlockRows[index]!
    if (block.screenY >= bottom) break
    const geometry = layout.geometry.byBlockKey[block.blockKey]
    if (!geometry) continue
    const fromRow = Math.max(0, Math.floor(top - block.screenY))
    const toRow = Math.min(block.rows, Math.ceil(bottom - block.screenY))
    for (let row = fromRow; row < toRow; row++) {
      const offsets = geometry.pointOffsetsByRow?.[row]
        ?? Object.values(geometry.points).filter(point => point.row === row).map(point => point.graphemeOffset)
      for (const graphemeOffset of offsets) {
        const point = pointInLayout(layout, { itemId: block.itemId, graphemeOffset })
        if (point) result.push(point)
      }
    }
  }
  return result
}

function viewportEdgePoint(layout: TranscriptLayout, scrollbox: ScrollBoxRenderable, edge: "top" | "bottom"): MeasuredPoint | undefined {
  const top = scrollbox.viewport.screenY
  const bottom = top + scrollbox.viewport.height
  let candidate: MeasuredPoint | undefined
  for (const point of visibleMeasuredPoints(layout, scrollbox.viewport)) {
    if (point.hidden || point.screenY < top || point.screenY >= bottom) continue
    if (!candidate || (edge === "top" ? point.screenY < candidate.screenY : point.screenY > candidate.screenY)
      || (point.screenY === candidate.screenY && point.screenX < candidate.screenX)) candidate = point
  }
  return candidate
}

export function topVisiblePoint(layout: TranscriptLayout, scrollbox: ScrollBoxRenderable): MeasuredPoint | undefined {
  return viewportEdgePoint(layout, scrollbox, "top")
}

/** First text cell on the lowest visible content row, excluding decorative padding. */
export function bottomVisiblePoint(layout: TranscriptLayout, scrollbox: ScrollBoxRenderable): MeasuredPoint | undefined {
  return viewportEdgePoint(layout, scrollbox, "bottom")
}
