import type { ThreadId } from "@vimex/conversation"
import type { TranscriptBlock, TranscriptBlockPresentation } from "./window"
import { blockKey } from "./window"

export type GeometryStyleRevision = string | number
export type LayoutResetReason = "width" | "style" | "syntax" | "renderer" | "budget"

export interface BlockGeometryKey {
  readonly blockKey: string
  readonly contentRevision: number
  readonly width: number
  readonly styleRevision: GeometryStyleRevision
  readonly folded: boolean
  readonly presentation?: TranscriptBlockPresentation
}

/** A renderer-neutral logical point. Rows and columns are local to one block. */
export interface BlockPoint {
  readonly graphemeOffset: number
  /** Native cell coordinate relative to the block renderable. */
  readonly x: number
  /** Native cell coordinate relative to the block renderable. */
  readonly y: number
  readonly row: number
  readonly column: number
  readonly hidden?: boolean
}

export interface BlockLine {
  readonly from: number
  readonly to: number
  readonly row: number
}

export interface BlockGeometry {
  readonly key: Readonly<BlockGeometryKey>
  /** Monotonic native revision captured by the renderer adapter. */
  readonly nativeRevision: number
  readonly rows: number
  readonly pointCount?: number
  readonly points: Readonly<Record<number, BlockPoint>>
  /** Grapheme offsets grouped by local visual row, built once per changed block. */
  readonly pointOffsetsByRow?: Readonly<Record<number, readonly number[]>>
  readonly lines: readonly BlockLine[]
  readonly lineByRow?: Readonly<Record<number, BlockLine>>
}

export interface TranscriptBlockRows {
  readonly blockKey: string
  readonly itemId?: string
  readonly start: number
  readonly rows: number
}

export interface BlockMeasurementBase {
  readonly threadId: ThreadId
  readonly canonicalGeneration: number
  readonly displayedCanonicalRevision: number
  readonly basePresentationRevision: number
  readonly geometryGeneration: number
}

export interface BlockMeasurementBatch extends BlockMeasurementBase {
  readonly measurements: readonly BlockGeometry[]
}

export interface TranscriptGeometry {
  readonly generation: number
  readonly revision: number
  readonly width?: number
  readonly styleRevision?: GeometryStyleRevision
  readonly byBlockKey: Readonly<Record<string, BlockGeometry>>
  readonly rowByBlockKey: Readonly<Record<string, number>>
  readonly blockRows: readonly TranscriptBlockRows[]
  readonly totalRows: number
  readonly measuredBlockCount: number
  readonly totalPoints: number
}

export function freezeBlockGeometry(value: BlockGeometry): BlockGeometry {
  if (Object.isFrozen(value) && value.pointCount !== undefined && value.pointOffsetsByRow && value.lineByRow) return value
  const points = Object.freeze(Object.fromEntries(Object.entries(value.points).map(([offset, point]) => [offset, Object.freeze({
    graphemeOffset: point.graphemeOffset,
    x: point.x,
    y: point.y,
    row: point.row,
    column: point.column,
    ...(point.hidden ? { hidden: true } : {}),
  })])))
  const lines = Object.freeze(value.lines.map(line => Object.freeze({ from: line.from, to: line.to, row: line.row })))
  const lineByRow = Object.freeze(Object.fromEntries(lines.map(line => [line.row, line])))
  const offsetsByRow: Record<number, number[]> = {}
  for (const point of Object.values(points)) (offsetsByRow[point.row] ??= []).push(point.graphemeOffset)
  const pointOffsetsByRow = Object.freeze(Object.fromEntries(Object.entries(offsetsByRow).map(([row, offsets]) => [
    row,
    Object.freeze(offsets.sort((left, right) => left - right)),
  ])))
  return Object.freeze({
    key: Object.freeze({ ...value.key }),
    nativeRevision: value.nativeRevision,
    rows: value.rows,
    pointCount: Object.keys(points).length,
    points,
    pointOffsetsByRow,
    lines,
    lineByRow,
  })
}

export function emptyTranscriptGeometry(generation = 0, revision = 0): TranscriptGeometry {
  return Object.freeze({
    generation,
    revision,
    byBlockKey: Object.freeze({}),
    rowByBlockKey: Object.freeze({}),
    blockRows: Object.freeze([]),
    totalRows: 0,
    measuredBlockCount: 0,
    totalPoints: 0,
  })
}

export function geometryMatchesBlock(geometry: BlockGeometry, block: TranscriptBlock, folded: boolean, presentation: TranscriptBlockPresentation = "item"): boolean {
  return geometry.key.blockKey === blockKey(block)
    && geometry.key.contentRevision === block.contentRevision
    && geometry.key.folded === folded
    && (geometry.key.presentation ?? "item") === presentation
}

/** Compose global rows from immutable block-local geometry without cloning points or lines. */
export function composeTranscriptGeometry(
  blocks: readonly TranscriptBlock[],
  foldedByItem: Readonly<Record<string, boolean>>,
  byBlockKey: Readonly<Record<string, BlockGeometry>>,
  generation: number,
  revision: number,
  width?: number,
  styleRevision?: GeometryStyleRevision,
  presentationByBlock: Readonly<Record<string, { readonly kind: Exclude<TranscriptBlockPresentation, "item"> }>> = {},
): TranscriptGeometry {
  const retained: Record<string, BlockGeometry> = {}
  const rowByBlockKey: Record<string, number> = {}
  const blockRows: TranscriptBlockRows[] = []
  let row = 0
  let measuredBlockCount = 0
  let totalPoints = 0
  for (const block of blocks) {
    const key = blockKey(block)
    rowByBlockKey[key] = row
    const presentation = presentationByBlock[key]?.kind ?? "item"
    const folded = block.key.kind === "item" && (presentation !== "item" || Boolean(foldedByItem[block.key.itemId]))
    const geometry = byBlockKey[key]
    const rows = geometry && geometryMatchesBlock(geometry, block, folded, presentation)
      && (width === undefined || geometry.key.width === width)
      && (styleRevision === undefined || geometry.key.styleRevision === styleRevision)
      ? Math.max(0, geometry.rows) : presentation === "activity-hidden" ? 0 : Math.max(1, block.estimatedRows)
    blockRows.push(Object.freeze({ blockKey: key, ...(block.key.kind === "item" ? { itemId: block.key.itemId } : {}), start: row, rows }))
    if (geometry && geometryMatchesBlock(geometry, block, folded, presentation)
      && (width === undefined || geometry.key.width === width)
      && (styleRevision === undefined || geometry.key.styleRevision === styleRevision)) {
      retained[key] = geometry
      measuredBlockCount += 1
      totalPoints += geometry.pointCount ?? Object.keys(geometry.points).length
    }
    row += rows
  }
  return Object.freeze({
    generation,
    revision,
    width,
    styleRevision,
    byBlockKey: Object.freeze(retained),
    rowByBlockKey: Object.freeze(rowByBlockKey),
    blockRows: Object.freeze(blockRows),
    totalRows: row,
    measuredBlockCount,
    totalPoints,
  })
}
