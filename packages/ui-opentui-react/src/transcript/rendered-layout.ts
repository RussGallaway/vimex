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
  type TranscriptBlockPresentation,
  type TranscriptActivityPresentation,
  type TranscriptFrame,
  type TranscriptItemBlock,
  type TranscriptRuntime,
  type TranscriptState,
} from "@vimex/transcript"
import { blockRefForPoint, pointInLayout, type MeasuredPoint, type TranscriptLayout, type VisualLine } from "./layout"
import { measureRenderedBlock, takeDirtyRenderedBlocks } from "./measure-rendered-block"

export interface RuntimeLayoutSource {
  readonly frame: TranscriptFrame
  readonly runtime?: TranscriptRuntime
  readonly styleRevision: GeometryStyleRevision
}

interface LayoutCache {
  readonly geometry: TranscriptFrame["geometry"]
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
  readonly indexByKey: Map<string, number>
  readonly keysByItem: Map<string, readonly string[]>
  readonly renderableByKey: Map<string, Renderable>
}

function blockPresentation(block: TranscriptBlock, presentation: Readonly<Record<string, TranscriptActivityPresentation>>): TranscriptBlockPresentation {
  return presentation[blockKey(block)]?.kind ?? "item"
}
const measurementSchedules = new WeakMap<ScrollBoxRenderable, MeasurementSchedule>()

function scheduleFor(scrollbox: ScrollBoxRenderable): MeasurementSchedule {
  let schedule = measurementSchedules.get(scrollbox)
  if (!schedule) {
    schedule = { pending: new Set(), indexByKey: new Map(), keysByItem: new Map(), renderableByKey: new Map() }
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
  const itemRecords = new Map<string, object>()
  return new Proxy(Object.create(null) as Record<string, Readonly<Record<number, MeasuredPoint>>>, {
    ownKeys: () => itemBlocks.map(block => block.key.itemId),
    getOwnPropertyDescriptor: (_target, property) => typeof property === "string" && itemBlocks.some(block => block.key.itemId === property)
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

function buildLayout(scrollbox: ScrollBoxRenderable, blocks: readonly TranscriptBlock[], geometry: TranscriptFrame["geometry"]): TranscriptLayout {
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
    geometry,
    placementByBlockKey: Object.freeze(placementByBlockKey),
    blockKeysByItem: Object.freeze(Object.fromEntries(Object.entries(blockKeysByItem).map(([itemId, refs]) => [itemId, Object.freeze(refs.map(ref => Object.freeze(ref)))]))),
    blockKeyByItem: Object.freeze(blockKeyByItem),
    screenBlockRows: Object.freeze(geometry.blockRows.flatMap(row => {
      const placement = placementByBlockKey[row.blockKey]
      return row.rows > 0 && row.itemId && placement ? [Object.freeze({ blockKey: row.blockKey, itemId: row.itemId as ItemId, screenY: placement.screenY, rows: row.rows })] : []
    })),
  } as TranscriptLayout
  let indexed: ReturnType<typeof linesFor> | undefined
  const indexes = () => indexed ??= linesFor(geometry, blocks)
  Object.defineProperty(layout, "lines", { enumerable: true, configurable: false, get: () => indexes().lines })
  Object.defineProperty(layout, "linesByItem", { enumerable: true, configurable: false, get: () => indexes().linesByItem })
  Object.defineProperty(layout, "points", { enumerable: true, configurable: false, value: lazyPoints(layout, blocks) })
  return Object.freeze(layout)
}

function currentGeometry(renderer: CliRenderer, scrollbox: ScrollBoxRenderable, source: RuntimeLayoutSource | TranscriptState): { blocks: readonly TranscriptBlock[]; geometry: TranscriptFrame["geometry"] } {
  const runtimeSource = "frame" in source ? source : undefined
  const frame = runtimeSource?.frame
  const blocks: readonly TranscriptBlock[] = frame?.blocks ?? syntheticBlocks(source as TranscriptState)
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
    const lineageChanged = schedule.threadId !== frame!.threadId || schedule.canonicalGeneration !== frame!.canonicalGeneration
    const layoutReset = schedule.geometryGeneration !== frame!.geometry.generation
    if (lineageChanged || layoutReset || frame!.damage.kind === "full" || frame!.damage.kind === "layout") {
      schedule.pending.clear()
      schedule.renderableByKey.clear()
      indexBlocks(schedule, blocks)
      for (const block of blocks) candidates.add(blockKey(block))
    } else if (frame!.damage.kind === "blocks") {
      const missing = new Set<string>()
      for (const itemId of frame!.damage.itemIds) {
        const keys = schedule.keysByItem.get(itemId)
        if (keys?.length) for (const key of keys) candidates.add(key)
        else missing.add(itemId)
      }
      // Existing streaming items stay O(changed). A newly appended semantic
      // item is absent from the prior index, so discover only missing IDs once.
      if (missing.size) {
        const discovered = new Map<string, string[]>()
        blocks.forEach((block, index) => {
          if (block.key.kind !== "item" || !missing.has(block.key.itemId)) return
          const key = blockKey(block)
          schedule.indexByKey.set(key, index)
          let keys = discovered.get(block.key.itemId)
          if (!keys) {
            keys = []
            discovered.set(block.key.itemId, keys)
          }
          keys.push(key)
          candidates.add(key)
        })
        for (const [itemId, keys] of discovered) schedule.keysByItem.set(itemId, Object.freeze(keys))
      }
    }
    if (schedule.windowBlocks !== frame!.window.blocks && frame!.damage.kind === "view") {
      // Reattachment and explicit reveals can replace a pinned plan under view
      // damage. The transition is infrequent (and Stage 5 bounds the window),
      // so recover every newly materialized or geometry-invalidated block.
      for (const block of frame!.window.blocks) {
        const key = blockKey(block)
        if (!schedule.indexByKey.has(key) || !frame!.geometry.byBlockKey[key]) candidates.add(key)
      }
    }
    for (const dirty of takeDirtyRenderedBlocks()) {
      if (dirty.blockKey && schedule.renderableByKey.get(dirty.blockKey) === dirty.renderable) candidates.add(dirty.blockKey)
    }
    for (const key of schedule.pending) {
      candidates.add(key)
    }
    schedule.threadId = frame!.threadId
    schedule.canonicalGeneration = frame!.canonicalGeneration
    schedule.geometryGeneration = frame!.geometry.generation
    schedule.windowBlocks = frame!.window.blocks
  }
  const measurementBase = runtimeSource?.runtime?.measurementBase(frame)
  const presentation = frame?.window.activityPresentation ?? Object.freeze({})
  const measured: BlockGeometry[] = []
  for (const key of candidates) {
    const index = schedule.indexByKey.get(key)
    const block = index === undefined ? blocks.find(candidate => blockKey(candidate) === key) : blocks[index]
    if (!block) continue
    const renderable = findBlockRenderable(scrollbox, block)
    if (!renderable) continue
    schedule.renderableByKey.set(key, renderable)
    const blockMode = blockPresentation(block, presentation)
    const next = measureRenderedBlock({ renderer, renderable, block, width, styleRevision, presentation: blockMode,
      folded: block.key.kind === "item" && (blockMode !== "item" || Boolean(state.folded[block.key.itemId])) })
    const prior = frame?.geometry.byBlockKey[blockKey(block)]
    if (!prior || prior.nativeRevision !== next.nativeRevision || prior.key.contentRevision !== next.key.contentRevision
      || prior.key.width !== next.key.width || prior.key.styleRevision !== next.key.styleRevision || prior.key.folded !== next.key.folded
      || (prior.key.presentation ?? "item") !== (next.key.presentation ?? "item")) measured.push(next)
    else schedule.pending.delete(key)
  }
  if (runtimeSource?.runtime && measured.length) {
    for (const geometry of measured) schedule.pending.add(geometry.key.blockKey)
    runtimeSource.runtime.reportMeasurements({ ...measurementBase!, measurements: measured })
    return { blocks, geometry: frame!.geometry }
  }
  if (frame && runtimeSource?.runtime) return { blocks, geometry: frame.geometry }
  const legacy = legacyGeometryCache.get(scrollbox)
  if (legacy && legacy.order === state.order && legacy.projectionById === state.projectionById && legacy.folded === state.folded
    && legacy.width === width && legacy.measurements.length === measured.length
    && measured.every((geometry, index) => geometry === legacy.measurements[index])) return { blocks, geometry: legacy.geometry }
  const byBlockKey = Object.fromEntries(measured.map(geometry => [geometry.key.blockKey, geometry]))
  const geometry = composeTranscriptGeometry(blocks, state.folded, byBlockKey, 0, 1, width, styleRevision, presentation)
  legacyGeometryCache.set(scrollbox, { order: state.order, projectionById: state.projectionById, folded: state.folded, width, measurements: measured, geometry })
  return { blocks, geometry }
}

export function measureRenderedTranscript(renderer: CliRenderer, scrollbox: ScrollBoxRenderable, source: RuntimeLayoutSource | TranscriptState): TranscriptLayout | undefined {
  const { blocks, geometry } = currentGeometry(renderer, scrollbox, source)
  if (geometry.measuredBlockCount === 0) return undefined
  const originX = scrollbox.viewport.screenX - scrollbox.scrollLeft
  const originY = scrollbox.viewport.screenY - scrollbox.scrollTop
  const cached = layoutCache.get(scrollbox)
  if (cached?.geometry === geometry) {
    const offset = { x: originX - cached.originX, y: originY - cached.originY }
    if (offset.x === (cached.layout.screenOffset?.x ?? 0) && offset.y === (cached.layout.screenOffset?.y ?? 0)) return cached.layout
    const translated = translatedLayout(cached.layout, offset.x, offset.y)
    layoutCache.set(scrollbox, { ...cached, layout: translated })
    return translated
  }
  const layout = buildLayout(scrollbox, blocks, geometry)
  layoutCache.set(scrollbox, { geometry, originX, originY, layout })
  return layout
}

export function measuredPoint(layout: TranscriptLayout, point: LogicalPoint | undefined): MeasuredPoint | undefined {
  return pointInLayout(layout, point)
}

/** Current runtime geometry with the last known native placements; never exposes stale block geometry. */
export function rebaseTranscriptLayout(layout: TranscriptLayout, geometry: TranscriptFrame["geometry"]): TranscriptLayout {
  const screenBlockRows = geometry.blockRows.flatMap(row => {
    const placement = layout.placementByBlockKey?.[row.blockKey]
    return row.rows > 0 && row.itemId && placement ? [Object.freeze({ blockKey: row.blockKey, itemId: row.itemId as ItemId, screenY: placement.screenY, rows: row.rows })] : []
  })
  return Object.freeze({
    width: layout.width,
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
