import type { ItemId } from "@vimex/conversation"
import { graphemes, transcriptOrderIndex, type LogicalPoint, type TranscriptBlock, type TranscriptGeometry, type TranscriptState } from "@vimex/transcript"

export interface VisualLine {
  itemId: ItemId
  from: number
  to: number
  row: number
}

export interface TranscriptLayout {
  width: number
  /** Exact runtime window whose native placements this layout describes. */
  materializedBlocks?: readonly TranscriptBlock[]
  lines: readonly VisualLine[]
  linesByItem: Readonly<Record<string, readonly VisualLine[]>>
  /** Translation from cached native coordinates; use measuredPoint for screen positions. */
  screenOffset?: { readonly x: number; readonly y: number }
  points?: Readonly<Record<string, Readonly<Record<number, MeasuredPoint>>>>
  /** Runtime-owned block-local geometry. Native placement remains UI-local. */
  geometry?: TranscriptGeometry
  placementByBlockKey?: Readonly<Record<string, BlockPlacement>>
  blockKeysByItem?: Readonly<Record<string, readonly ItemBlockGeometryRef[]>>
  screenBlockRows?: readonly ScreenBlockRows[]
  /** @deprecated root-block compatibility for estimated/test layouts. */
  blockKeyByItem?: Readonly<Record<string, string>>
}

export interface ItemBlockGeometryRef {
  readonly blockKey: string
  readonly blockId?: string
  /** Inclusive logical grapheme offset. */
  readonly from: number
  /** Exclusive, except that the final block also owns the document-end cursor. */
  readonly to: number
}

export interface ScreenBlockRows {
  readonly blockKey: string
  readonly itemId: ItemId
  readonly screenY: number
  readonly rows: number
}

export interface BlockPlacement {
  readonly screenX: number
  readonly screenY: number
}

export interface MeasuredPoint {
  /** Cursor fallback for text hidden inside a collapsed block; not a jump target. */
  hidden?: boolean
  itemId: ItemId
  graphemeOffset: number
  row: number
  column: number
  screenX: number
  screenY: number
}

export function graphemeCellWidth(value: string): number {
  return value ? Bun.stringWidth(value) : 0
}

function wrapProjection(itemId: ItemId, text: string, width: number, startRow: number, folded: boolean): VisualLine[] {
  const cells = graphemes(text)
  if (folded) return [{ itemId, from: 0, to: cells.length, row: startRow }]
  const lines: VisualLine[] = []
  let from = 0
  let used = 0
  let row = startRow

  const push = (to: number) => {
    lines.push({ itemId, from, to, row })
    row += 1
    from = to
    used = 0
  }

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index] ?? ""
    if (cell === "\n") {
      push(Math.max(from, index - 1))
      // Native measurement places the newline cursor at the beginning of the
      // following visual row, alongside its first grapheme.
      from = index
      continue
    }
    const next = graphemeCellWidth(cell)
    if (used > 0 && used + next > width) {
      push(index - 1)
      from = index
    }
    used += next
  }
  push(cells.length)
  return lines
}

export function buildTranscriptLayout(state: TranscriptState, width: number): TranscriptLayout {
  const safeWidth = Math.max(1, Math.floor(width))
  const lines: VisualLine[] = []
  const linesByItem: Record<string, readonly VisualLine[]> = {}
  for (const itemId of state.order) {
    const projection = state.projectionById[itemId]
    if (!projection) continue
    const itemLines = wrapProjection(itemId, projection.plain, safeWidth, lines.length, Boolean(state.folded[itemId]))
    lines.push(...itemLines)
    linesByItem[itemId] = itemLines
  }
  return { width: safeWidth, lines, linesByItem }
}

export function blockRefForPoint(layout: TranscriptLayout, point: LogicalPoint): ItemBlockGeometryRef | undefined {
  const refs = layout.blockKeysByItem?.[point.itemId]
  return refs?.find((ref, index) => point.graphemeOffset >= ref.from
    && (point.graphemeOffset < ref.to || (index === refs.length - 1 && point.graphemeOffset === ref.to)))
}

function geometryKeyForPoint(layout: TranscriptLayout, point: LogicalPoint): string | undefined {
  return blockRefForPoint(layout, point)?.blockKey ?? layout.blockKeyByItem?.[point.itemId]
}

function lineForPoint(layout: TranscriptLayout, point: LogicalPoint): VisualLine | undefined {
  const geometryKey = geometryKeyForPoint(layout, point)
  const geometry = geometryKey ? layout.geometry?.byBlockKey[geometryKey] : undefined
  if (geometry) {
    const local = geometry.points[point.graphemeOffset]
    let line = local ? geometry.lineByRow?.[local.row] : undefined
    if (!line && local) line = geometry.lines.find(candidate => candidate.row === local.row)
    if (!line && !local) {
      let low = 0, high = geometry.lines.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (geometry.lines[middle]!.to < point.graphemeOffset) low = middle + 1
        else high = middle
      }
      line = geometry.lines[Math.min(low, geometry.lines.length - 1)]
    }
    if (!line) return undefined
    return { itemId: point.itemId, from: line.from, to: line.to, row: (layout.geometry?.rowByBlockKey[geometryKey!] ?? 0) + line.row }
  }
  const lines = layout.linesByItem[point.itemId]
  if (!lines?.length) return undefined
  const measured = layout.points?.[point.itemId]?.[point.graphemeOffset]
  if (measured) return lines.find(line => line.row === measured.row)
  return lines.find((line, index) => point.graphemeOffset < line.to || (index === lines.length - 1 && point.graphemeOffset <= line.to))
}

export function pointInLayout(layout: TranscriptLayout, point: LogicalPoint | undefined): MeasuredPoint | undefined {
  if (!point) return undefined
  const geometryKey = geometryKeyForPoint(layout, point)
  const geometry = geometryKey ? layout.geometry?.byBlockKey[geometryKey] : undefined
  const direct = geometry?.points[point.graphemeOffset]
  const local = direct ?? (geometry?.key.folded ? Object.values(geometry.points)[0] : undefined)
  const placement = geometryKey ? layout.placementByBlockKey?.[geometryKey] : undefined
  if (local && placement) return {
    itemId: point.itemId,
    graphemeOffset: point.graphemeOffset,
    row: (layout.geometry?.rowByBlockKey[geometryKey!] ?? 0) + local.row,
    column: local.column,
    screenX: placement.screenX + local.x + (layout.screenOffset?.x ?? 0),
    screenY: placement.screenY + local.y + (layout.screenOffset?.y ?? 0),
    ...(!direct || local.hidden ? { hidden: true } : {}),
  }
  if (layout.geometry) return undefined
  const measured = layout.points?.[point.itemId]?.[point.graphemeOffset]
  if (!measured || !layout.screenOffset || (!layout.screenOffset.x && !layout.screenOffset.y)) return measured
  return { ...measured, screenX: measured.screenX + layout.screenOffset.x, screenY: measured.screenY + layout.screenOffset.y }
}

// Published layouts are immutable; index measured rows once per reflow so a
// cursor step does not flatten and sort an entire long transcript.
const measuredRows = new WeakMap<object, Map<number, MeasuredPoint[]>>()
function pointsOnRow(layout: TranscriptLayout, row: number): readonly MeasuredPoint[] {
  if (layout.geometry && layout.placementByBlockKey) {
    const result: MeasuredPoint[] = []
    const blockRow = blockAtRow(layout.geometry.blockRows, row)
    const geometry = blockRow && layout.geometry.byBlockKey[blockRow.blockKey]
    if (!blockRow?.itemId || !geometry) return result
    const localRow = row - blockRow.start
    const offsets = geometry.pointOffsetsByRow?.[localRow]
      ?? Object.values(geometry.points).filter(point => point.row === localRow).map(point => point.graphemeOffset)
    for (const graphemeOffset of offsets) {
      const point = pointInLayout(layout, { itemId: blockRow.itemId as ItemId, graphemeOffset })
      if (point) result.push(point)
    }
    return result
  }
  const key = layout.points ?? layout
  let rows = measuredRows.get(key)
  if (!rows) {
    rows = new Map()
    for (const item of Object.values(layout.points ?? {})) for (const point of Object.values(item)) {
      const existing = rows.get(point.row)
      if (existing) existing.push(point)
      else rows.set(point.row, [point])
    }
    measuredRows.set(key, rows)
  }
  return rows.get(row) ?? []
}

function blockAtRow(rows: TranscriptGeometry["blockRows"], row: number) {
  let low = 0, high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (rows[middle]!.start + rows[middle]!.rows <= row) low = middle + 1
    else high = middle
  }
  const candidate = rows[low]
  return candidate && row >= candidate.start ? candidate : undefined
}

function geometryLineAtRow(layout: TranscriptLayout, row: number): VisualLine | undefined {
  if (!layout.geometry) return undefined
  const blockRow = blockAtRow(layout.geometry.blockRows, row)
  if (!blockRow?.itemId) return undefined
  const geometry = layout.geometry.byBlockKey[blockRow.blockKey]
  const localRow = row - blockRow.start
  const line = geometry?.lineByRow?.[localRow] ?? geometry?.lines.find(candidate => candidate.row === localRow)
  return line && { itemId: blockRow.itemId as ItemId, from: line.from, to: line.to, row }
}

function geometryLineFrom(layout: TranscriptLayout, row: number, direction: -1 | 1): VisualLine | undefined {
  const limit = layout.geometry?.totalRows ?? 0
  for (let current = row; current >= 0 && current < limit; current += direction) {
    const line = geometryLineAtRow(layout, current)
    if (line) return line
  }
  return undefined
}

function moveGeometryPoint(
  layout: TranscriptLayout,
  point: LogicalPoint | undefined,
  motion: "left" | "right" | "up" | "down" | "line-start" | "line-end" | "first" | "last",
): { point: LogicalPoint; preferredScreenRow: number } | undefined {
  const geometry = layout.geometry
  if (!geometry || (!layout.blockKeysByItem && !layout.blockKeyByItem) || geometry.measuredBlockCount === 0) return undefined
  const current = point ? lineForPoint(layout, point) : undefined
  const first = geometryLineFrom(layout, 0, 1)
  const last = geometryLineFrom(layout, geometry.totalRows - 1, -1)
  let line = current ?? last
  if (!line || !first || !last) return undefined
  const measured = pointInLayout(layout, point)
  const logicalColumn = Math.max(0, (point?.graphemeOffset ?? line.to) - line.from)
  let offset = point?.graphemeOffset ?? line.to

  if (motion === "up" || motion === "down") {
    const direction = motion === "down" ? 1 : -1
    const targetLine = geometryLineFrom(layout, line.row + direction, direction)
    if (!targetLine) return { point: point ?? { itemId: line.itemId, graphemeOffset: offset }, preferredScreenRow: line.row }
    const candidates = pointsOnRow(layout, targetLine.row)
    let targetPoint: MeasuredPoint | undefined
    for (const candidate of candidates) {
      const desired = measured?.column ?? logicalColumn
      if (!targetPoint || Math.abs(candidate.column - desired) < Math.abs(targetPoint.column - desired)) targetPoint = candidate
    }
    if (targetPoint) return { point: { itemId: targetPoint.itemId, graphemeOffset: targetPoint.graphemeOffset }, preferredScreenRow: targetPoint.row }
    return { point: { itemId: targetLine.itemId, graphemeOffset: Math.min(targetLine.to, targetLine.from + logicalColumn) }, preferredScreenRow: targetLine.row }
  }
  if (motion === "left") {
    if (offset > line.from) offset--
    else {
      const previous = geometryLineFrom(layout, line.row - 1, -1)
      if (previous) { line = previous; offset = previous.to }
    }
  } else if (motion === "right") {
    if (offset < line.to) offset++
    else {
      const next = geometryLineFrom(layout, line.row + 1, 1)
      if (next) { line = next; offset = next.from }
    }
  } else if (motion === "line-start") offset = line.from
  else if (motion === "line-end") offset = line.to
  else if (motion === "first") { line = first; offset = first.from }
  else if (motion === "last") { line = last; offset = last.to }
  return { point: { itemId: line.itemId, graphemeOffset: offset }, preferredScreenRow: line.row }
}

export function movePoint(
  layout: TranscriptLayout,
  point: LogicalPoint | undefined,
  motion: "left" | "right" | "up" | "down" | "line-start" | "line-end" | "first" | "last",
): { point: LogicalPoint; preferredScreenRow: number } | undefined {
  if (layout.geometry && (layout.blockKeysByItem || layout.blockKeyByItem)) return moveGeometryPoint(layout, point, motion)
  if (layout.geometry?.measuredBlockCount === 0 || (!layout.geometry && layout.lines.length === 0)) return undefined
  const measured = pointInLayout(layout, point)
  if (measured && (motion === "up" || motion === "down")) {
    const targetRow = measured.row + (motion === "down" ? 1 : -1)
    let target: MeasuredPoint | undefined
    for (const candidate of pointsOnRow(layout, targetRow)) {
      if (!target || Math.abs(candidate.column - measured.column) < Math.abs(target.column - measured.column)) target = candidate
    }
    if (target) return { point: { itemId: target.itemId, graphemeOffset: target.graphemeOffset }, preferredScreenRow: target.row }
  }
  const runtimeLines = layout.lines
  if (runtimeLines.length === 0) return undefined
  const current = point ? lineForPoint(layout, point) : undefined
  const line = current ?? runtimeLines.at(-1)!
  const lineIndex = runtimeLines.findIndex(candidate => candidate.itemId === line.itemId && candidate.row === line.row && candidate.from === line.from)
  const column = Math.max(0, (point?.graphemeOffset ?? line.to) - line.from)
  let target = line
  let offset = point?.graphemeOffset ?? line.to

  switch (motion) {
    case "left": {
      if (offset > line.from) offset -= 1
      else if (lineIndex > 0) {
        target = runtimeLines[lineIndex - 1]!
        offset = target.to
      }
      break
    }
    case "right": {
      if (offset < line.to) offset += 1
      else if (lineIndex < runtimeLines.length - 1) {
        target = runtimeLines[lineIndex + 1]!
        offset = target.from
      }
      break
    }
    case "up":
      target = runtimeLines[Math.max(0, lineIndex - 1)]!
      offset = Math.min(target.to, target.from + column)
      break
    case "down":
      target = runtimeLines[Math.min(runtimeLines.length - 1, lineIndex + 1)]!
      offset = Math.min(target.to, target.from + column)
      break
    case "line-start":
      offset = line.from
      break
    case "line-end":
      offset = line.to
      break
    case "first":
      target = runtimeLines[0]!
      offset = target.from
      break
    case "last":
      target = runtimeLines.at(-1)!
      offset = target.to
      break
  }

  return { point: { itemId: target.itemId, graphemeOffset: offset }, preferredScreenRow: target.row }
}

export function orderedSelectionBounds(state: TranscriptState): { start: LogicalPoint; end: LogicalPoint } | undefined {
  const selection = state.selection
  if (!selection) return undefined
  const order = transcriptOrderIndex(state.order)
  const ai = order.get(selection.anchor.itemId) ?? -1
  const hi = order.get(selection.head.itemId) ?? -1
  if (ai < hi || (ai === hi && selection.anchor.graphemeOffset <= selection.head.graphemeOffset)) {
    return { start: selection.anchor, end: selection.head }
  }
  return { start: selection.head, end: selection.anchor }
}

export function selectedRangeForItem(state: TranscriptState, itemId: ItemId): { from: number; to: number } | undefined {
  const bounds = orderedSelectionBounds(state)
  if (!bounds) return undefined
  const order = transcriptOrderIndex(state.order)
  const itemIndex = order.get(itemId) ?? -1
  const startIndex = order.get(bounds.start.itemId) ?? -1
  const endIndex = order.get(bounds.end.itemId) ?? -1
  if (itemIndex < startIndex || itemIndex > endIndex) return undefined
  const parts = graphemes(state.projectionById[itemId]?.plain ?? "")
  let from = itemIndex === startIndex ? bounds.start.graphemeOffset : 0
  let to = itemIndex === endIndex ? bounds.end.graphemeOffset + 1 : parts.length
  if (state.selection?.shape === "line") {
    while (from > 0 && parts[from - 1] !== "\n") from -= 1
    let inclusiveEnd = Math.min(Math.max(0, parts.length - 1), Math.max(from, to - 1))
    while (inclusiveEnd < parts.length && parts[inclusiveEnd] !== "\n") inclusiveEnd += 1
    to = Math.min(parts.length, inclusiveEnd + 1)
  }
  return { from, to }
}
