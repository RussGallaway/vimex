import type { ItemId } from "@vimex/conversation"
import {
  adjacentTranscriptItem,
  blockKey,
  graphemes,
  transcriptBoundaryItem,
  transcriptOrderIndex,
  type LogicalPoint,
  type TranscriptBlock,
  type TranscriptGeometry,
  type TranscriptState,
} from "@vimex/transcript"

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

export interface MaterializedSelectionEndpoints {
  readonly anchor: MeasuredPoint
  readonly head: MeasuredPoint
}

export interface MaterializedSelectionDiagnostics {
  blockVisits: number
  pointVisits: number
}

export function graphemeCellWidth(value: string): number {
  return value ? Bun.stringWidth(value) : 0
}

function wrapProjection(
  itemId: ItemId,
  text: string,
  width: number,
  startRow: number,
  folded: boolean,
): VisualLine[] {
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

export function buildTranscriptLayout(
  state: TranscriptState,
  width: number,
): TranscriptLayout {
  const safeWidth = Math.max(1, Math.floor(width))
  const lines: VisualLine[] = []
  const linesByItem: Record<string, readonly VisualLine[]> = {}
  for (const itemId of state.order) {
    const projection = state.projectionById[itemId]
    if (!projection) continue
    const itemLines = wrapProjection(
      itemId,
      projection.plain,
      safeWidth,
      lines.length,
      Boolean(state.folded[itemId]),
    )
    lines.push(...itemLines)
    linesByItem[itemId] = itemLines
  }
  return { width: safeWidth, lines, linesByItem }
}

export interface TargetedMotionDiagnostics {
  wrappedItems: number
  itemTransitions: number
}

export type TranscriptMotion =
  | "left"
  | "right"
  | "up"
  | "down"
  | "line-start"
  | "line-end"
  | "first"
  | "last"

/**
 * Exact estimated-layout fallback for a logical target outside the mounted
 * native window. Only projections visited by the requested motion are wrapped;
 * buildTranscriptLayout remains the complete reference oracle for tests.
 */
export function movePointInTranscript(
  state: TranscriptState,
  width: number,
  point: LogicalPoint | undefined,
  motion: TranscriptMotion,
  repeat = 1,
  diagnostics?: TargetedMotionDiagnostics,
): { point: LogicalPoint; preferredScreenRow: number } | undefined {
  const safeWidth = Math.max(1, Math.floor(width))
  const cache = new Map<ItemId, readonly VisualLine[]>()
  const linesFor = (itemId: ItemId): readonly VisualLine[] => {
    const cached = cache.get(itemId)
    if (cached) return cached
    const projection = state.projectionById[itemId]
    const lines = projection
      ? wrapProjection(
          itemId,
          projection.plain,
          safeWidth,
          0,
          Boolean(state.folded[itemId]),
        )
      : []
    cache.set(itemId, lines)
    if (diagnostics) diagnostics.wrappedItems++
    return lines
  }
  const boundary = (direction: "forward" | "backward") => {
    const itemId = transcriptBoundaryItem(state, direction)
    if (!itemId) return undefined
    const lines = linesFor(itemId)
    const line = direction === "forward" ? lines[0] : lines.at(-1)
    return line && { itemId, line }
  }
  const adjacent = (itemId: ItemId, direction: "forward" | "backward") => {
    let candidate = itemId
    while (true) {
      const next = adjacentTranscriptItem(state, candidate, direction)
      if (!next) return undefined
      candidate = next
      if (diagnostics) diagnostics.itemTransitions++
      const lines = linesFor(candidate)
      const line = direction === "forward" ? lines[0] : lines.at(-1)
      if (line) return { itemId: candidate, line }
    }
  }
  const lineAt = (current: LogicalPoint) => {
    const lines = linesFor(current.itemId)
    const line = lines.find(
      (candidate, index) =>
        current.graphemeOffset < candidate.to ||
        (index === lines.length - 1 && current.graphemeOffset <= candidate.to),
    )
    return line ? { lines, line, index: lines.indexOf(line) } : undefined
  }
  const edge =
    motion === "first"
      ? boundary("forward")
      : motion === "last"
        ? boundary("backward")
        : undefined
  if (motion === "first" || motion === "last") {
    if (!edge) return undefined
    return {
      point: {
        itemId: edge.itemId,
        graphemeOffset: motion === "first" ? edge.line.from : edge.line.to,
      },
      preferredScreenRow: edge.line.row,
    }
  }
  let initial = point
  if (!initial || !state.projectionById[initial.itemId]) {
    const last = boundary("backward")
    if (!last) return undefined
    initial = { itemId: last.itemId, graphemeOffset: last.line.to }
  }
  let current: LogicalPoint = initial
  const steps = Number.isFinite(repeat) ? Math.max(1, Math.trunc(repeat)) : 1
  let preferredScreenRow = 0
  let moved = false
  const crossingMotion =
    motion === "left" ||
    motion === "right" ||
    motion === "up" ||
    motion === "down"
  for (let step = 0; step < steps; step++) {
    const located = lineAt(current)
    if (!located)
      return step ? { point: current, preferredScreenRow } : undefined
    const { lines, line, index } = located
    const column = Math.max(0, current.graphemeOffset - line.from)
    let targetItem: ItemId = current.itemId
    let targetLine = line
    let offset = current.graphemeOffset
    if (motion === "left") {
      if (offset > line.from) offset--
      else if (index > 0) {
        targetLine = lines[index - 1]!
        offset = targetLine.to
      } else {
        const target = adjacent(current.itemId, "backward")
        if (target) {
          targetItem = target.itemId
          targetLine = target.line
          offset = targetLine.to
        }
      }
    } else if (motion === "right") {
      if (offset < line.to) offset++
      else if (index < lines.length - 1) {
        targetLine = lines[index + 1]!
        offset = targetLine.from
      } else {
        const target = adjacent(current.itemId, "forward")
        if (target) {
          targetItem = target.itemId
          targetLine = target.line
          offset = targetLine.from
        }
      }
    } else if (motion === "up" || motion === "down") {
      const direction = motion === "down" ? "forward" : "backward"
      const localIndex = index + (motion === "down" ? 1 : -1)
      if (localIndex >= 0 && localIndex < lines.length)
        targetLine = lines[localIndex]!
      else {
        const target = adjacent(current.itemId, direction)
        if (target) {
          targetItem = target.itemId
          targetLine = target.line
        }
      }
      offset = Math.min(targetLine.to, targetLine.from + column)
    } else if (motion === "line-start") offset = line.from
    else if (motion === "line-end") offset = line.to
    const next: LogicalPoint = { itemId: targetItem, graphemeOffset: offset }
    preferredScreenRow = targetLine.row
    if (
      next.itemId === current.itemId &&
      next.graphemeOffset === current.graphemeOffset
    ) {
      return crossingMotion && !moved
        ? undefined
        : { point: current, preferredScreenRow }
    }
    moved = true
    current = next
  }
  return { point: current, preferredScreenRow }
}

export function blockRefForPoint(
  layout: TranscriptLayout,
  point: LogicalPoint,
): ItemBlockGeometryRef | undefined {
  const refs = layout.blockKeysByItem?.[point.itemId]
  return refs?.find(
    (ref, index) =>
      point.graphemeOffset >= ref.from &&
      (point.graphemeOffset < ref.to ||
        (index === refs.length - 1 && point.graphemeOffset === ref.to)),
  )
}

function geometryKeyForPoint(
  layout: TranscriptLayout,
  point: LogicalPoint,
): string | undefined {
  return (
    blockRefForPoint(layout, point)?.blockKey ??
    layout.blockKeyByItem?.[point.itemId]
  )
}

function lineForPoint(
  layout: TranscriptLayout,
  point: LogicalPoint,
): VisualLine | undefined {
  const geometryKey = geometryKeyForPoint(layout, point)
  const geometry = geometryKey
    ? layout.geometry?.byBlockKey[geometryKey]
    : undefined
  if (geometry) {
    const local = geometry.points[point.graphemeOffset]
    let line = local ? geometry.lineByRow?.[local.row] : undefined
    if (!line && local)
      line = geometry.lines.find((candidate) => candidate.row === local.row)
    if (!line && !local) {
      let low = 0,
        high = geometry.lines.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (geometry.lines[middle]!.to < point.graphemeOffset) low = middle + 1
        else high = middle
      }
      line = geometry.lines[Math.min(low, geometry.lines.length - 1)]
    }
    if (!line) return undefined
    return {
      itemId: point.itemId,
      from: line.from,
      to: line.to,
      row: (layout.geometry?.rowByBlockKey[geometryKey!] ?? 0) + line.row,
    }
  }
  const lines = layout.linesByItem[point.itemId]
  if (!lines?.length) return undefined
  const measured = layout.points?.[point.itemId]?.[point.graphemeOffset]
  if (measured) return lines.find((line) => line.row === measured.row)
  return lines.find(
    (line, index) =>
      point.graphemeOffset < line.to ||
      (index === lines.length - 1 && point.graphemeOffset <= line.to),
  )
}

export function pointInLayout(
  layout: TranscriptLayout,
  point: LogicalPoint | undefined,
): MeasuredPoint | undefined {
  if (!point) return undefined
  const geometryKey = geometryKeyForPoint(layout, point)
  const geometry = geometryKey
    ? layout.geometry?.byBlockKey[geometryKey]
    : undefined
  const direct = geometry?.points[point.graphemeOffset]
  const local =
    direct ??
    (geometry?.key.folded ? Object.values(geometry.points)[0] : undefined)
  const placement = geometryKey
    ? layout.placementByBlockKey?.[geometryKey]
    : undefined
  if (local && placement)
    return {
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
  if (
    !measured ||
    !layout.screenOffset ||
    (!layout.screenOffset.x && !layout.screenOffset.y)
  )
    return measured
  return {
    ...measured,
    screenX: measured.screenX + layout.screenOffset.x,
    screenY: measured.screenY + layout.screenOffset.y,
  }
}

// Published layouts are immutable; index measured rows once per reflow so a
// cursor step does not flatten and sort an entire long transcript.
const measuredRows = new WeakMap<object, Map<number, MeasuredPoint[]>>()
function pointsOnRow(
  layout: TranscriptLayout,
  row: number,
): readonly MeasuredPoint[] {
  if (layout.geometry && layout.placementByBlockKey) {
    const result: MeasuredPoint[] = []
    const blockRow = blockAtRow(layout.geometry.blockRows, row)
    const geometry = blockRow && layout.geometry.byBlockKey[blockRow.blockKey]
    if (!blockRow?.itemId || !geometry) return result
    const localRow = row - blockRow.start
    const offsets =
      geometry.pointOffsetsByRow?.[localRow] ??
      Object.values(geometry.points)
        .filter((point) => point.row === localRow)
        .map((point) => point.graphemeOffset)
    for (const graphemeOffset of offsets) {
      const point = pointInLayout(layout, {
        itemId: blockRow.itemId as ItemId,
        graphemeOffset,
      })
      if (point) result.push(point)
    }
    return result
  }
  const key = layout.points ?? layout
  let rows = measuredRows.get(key)
  if (!rows) {
    rows = new Map()
    for (const item of Object.values(layout.points ?? {}))
      for (const point of Object.values(item)) {
        const existing = rows.get(point.row)
        if (existing) existing.push(point)
        else rows.set(point.row, [point])
      }
    measuredRows.set(key, rows)
  }
  return rows.get(row) ?? []
}

function blockAtRow(rows: TranscriptGeometry["blockRows"], row: number) {
  let low = 0,
    high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (rows[middle]!.start + rows[middle]!.rows <= row) low = middle + 1
    else high = middle
  }
  const candidate = rows[low]
  return candidate && row >= candidate.start ? candidate : undefined
}

function geometryLineAtRow(
  layout: TranscriptLayout,
  row: number,
): VisualLine | undefined {
  if (!layout.geometry) return undefined
  const blockRow = blockAtRow(layout.geometry.blockRows, row)
  if (!blockRow?.itemId) return undefined
  const geometry = layout.geometry.byBlockKey[blockRow.blockKey]
  const localRow = row - blockRow.start
  const line =
    geometry?.lineByRow?.[localRow] ??
    geometry?.lines.find((candidate) => candidate.row === localRow)
  return (
    line && {
      itemId: blockRow.itemId as ItemId,
      from: line.from,
      to: line.to,
      row,
    }
  )
}

function geometryLineFrom(
  layout: TranscriptLayout,
  row: number,
  direction: -1 | 1,
): VisualLine | undefined {
  const rows = layout.geometry?.blockRows
  if (!rows?.length) return undefined
  const minimum = rows[0]!.start
  const last = rows.at(-1)!
  const maximum = last.start + last.rows
  const firstRow =
    direction > 0 ? Math.max(row, minimum) : Math.min(row, maximum - 1)
  for (
    let current = firstRow;
    current >= minimum && current < maximum;
    current += direction
  ) {
    const line = geometryLineAtRow(layout, current)
    if (line) return line
  }
  return undefined
}

function moveGeometryPoint(
  layout: TranscriptLayout,
  point: LogicalPoint | undefined,
  motion:
    | "left"
    | "right"
    | "up"
    | "down"
    | "line-start"
    | "line-end"
    | "first"
    | "last",
): { point: LogicalPoint; preferredScreenRow: number } | undefined {
  const geometry = layout.geometry
  if (
    !geometry ||
    (!layout.blockKeysByItem && !layout.blockKeyByItem) ||
    geometry.measuredBlockCount === 0
  )
    return undefined
  const current = point ? lineForPoint(layout, point) : undefined
  const first = geometryLineFrom(layout, 0, 1)
  const last = geometryLineFrom(layout, geometry.totalRows - 1, -1)
  let line = current ?? last
  if (!line || !first || !last) return undefined
  const measured = pointInLayout(layout, point)
  const logicalColumn = Math.max(
    0,
    (point?.graphemeOffset ?? line.to) - line.from,
  )
  let offset = point?.graphemeOffset ?? line.to

  if (motion === "up" || motion === "down") {
    const direction = motion === "down" ? 1 : -1
    const targetLine = geometryLineFrom(layout, line.row + direction, direction)
    if (!targetLine)
      return {
        point: point ?? { itemId: line.itemId, graphemeOffset: offset },
        preferredScreenRow: line.row,
      }
    const candidates = pointsOnRow(layout, targetLine.row)
    let targetPoint: MeasuredPoint | undefined
    for (const candidate of candidates) {
      const desired = measured?.column ?? logicalColumn
      if (
        !targetPoint ||
        Math.abs(candidate.column - desired) <
          Math.abs(targetPoint.column - desired)
      )
        targetPoint = candidate
    }
    if (targetPoint)
      return {
        point: {
          itemId: targetPoint.itemId,
          graphemeOffset: targetPoint.graphemeOffset,
        },
        preferredScreenRow: targetPoint.row,
      }
    return {
      point: {
        itemId: targetLine.itemId,
        graphemeOffset: Math.min(
          targetLine.to,
          targetLine.from + logicalColumn,
        ),
      },
      preferredScreenRow: targetLine.row,
    }
  }
  if (motion === "left") {
    if (offset > line.from) offset--
    else {
      const previous = geometryLineFrom(layout, line.row - 1, -1)
      if (previous) {
        line = previous
        offset = previous.to
      }
    }
  } else if (motion === "right") {
    if (offset < line.to) offset++
    else {
      const next = geometryLineFrom(layout, line.row + 1, 1)
      if (next) {
        line = next
        offset = next.from
      }
    }
  } else if (motion === "line-start") offset = line.from
  else if (motion === "line-end") offset = line.to
  else if (motion === "first") {
    line = first
    offset = first.from
  } else if (motion === "last") {
    line = last
    offset = last.to
  }
  return {
    point: { itemId: line.itemId, graphemeOffset: offset },
    preferredScreenRow: line.row,
  }
}

export function movePoint(
  layout: TranscriptLayout,
  point: LogicalPoint | undefined,
  motion: TranscriptMotion,
): { point: LogicalPoint; preferredScreenRow: number } | undefined {
  if (layout.geometry && (layout.blockKeysByItem || layout.blockKeyByItem))
    return moveGeometryPoint(layout, point, motion)
  if (
    layout.geometry?.measuredBlockCount === 0 ||
    (!layout.geometry && layout.lines.length === 0)
  )
    return undefined
  const measured = pointInLayout(layout, point)
  if (measured && (motion === "up" || motion === "down")) {
    const targetRow = measured.row + (motion === "down" ? 1 : -1)
    let target: MeasuredPoint | undefined
    for (const candidate of pointsOnRow(layout, targetRow)) {
      if (
        !target ||
        Math.abs(candidate.column - measured.column) <
          Math.abs(target.column - measured.column)
      )
        target = candidate
    }
    if (target)
      return {
        point: { itemId: target.itemId, graphemeOffset: target.graphemeOffset },
        preferredScreenRow: target.row,
      }
  }
  const runtimeLines = layout.lines
  if (runtimeLines.length === 0) return undefined
  const current = point ? lineForPoint(layout, point) : undefined
  const line = current ?? runtimeLines.at(-1)!
  const lineIndex = runtimeLines.findIndex(
    (candidate) =>
      candidate.itemId === line.itemId &&
      candidate.row === line.row &&
      candidate.from === line.from,
  )
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

  return {
    point: { itemId: target.itemId, graphemeOffset: offset },
    preferredScreenRow: target.row,
  }
}

export function orderedSelectionBounds(
  state: TranscriptState,
): { start: LogicalPoint; end: LogicalPoint } | undefined {
  const selection = state.selection
  if (!selection) return undefined
  const order = transcriptOrderIndex(state.order)
  const ai = order.get(selection.anchor.itemId) ?? -1
  const hi = order.get(selection.head.itemId) ?? -1
  if (
    ai < hi ||
    (ai === hi &&
      selection.anchor.graphemeOffset <= selection.head.graphemeOffset)
  ) {
    return { start: selection.anchor, end: selection.head }
  }
  return { start: selection.head, end: selection.anchor }
}

export function selectedRangeForItem(
  state: TranscriptState,
  itemId: ItemId,
): { from: number; to: number } | undefined {
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
    let inclusiveEnd = Math.min(
      Math.max(0, parts.length - 1),
      Math.max(from, to - 1),
    )
    while (inclusiveEnd < parts.length && parts[inclusiveEnd] !== "\n")
      inclusiveEnd += 1
    to = Math.min(parts.length, inclusiveEnd + 1)
  }
  return { from, to }
}

/**
 * Intersect a complete semantic selection with the currently materialized
 * native geometry. The result preserves selection direction and never asks an
 * unmounted endpoint to provide a native node.
 */
export function materializedSelectionEndpoints(
  state: TranscriptState,
  layout: TranscriptLayout,
  diagnostics?: MaterializedSelectionDiagnostics,
  viewport?: Readonly<{ screenY: number; height: number }>,
): MaterializedSelectionEndpoints | undefined {
  if (!state.selection) return undefined
  const order = transcriptOrderIndex(state.order)
  const ranges = new Map<ItemId, { from: number; to: number } | undefined>()
  const rangeFor = (itemId: ItemId) => {
    if (ranges.has(itemId)) return ranges.get(itemId)
    const range = selectedRangeForItem(state, itemId)
    ranges.set(itemId, range)
    return range
  }
  const compare = (left: MeasuredPoint, right: MeasuredPoint) => {
    const item =
      (order.get(left.itemId) ?? -1) - (order.get(right.itemId) ?? -1)
    return item || left.graphemeOffset - right.graphemeOffset
  }
  let first: MeasuredPoint | undefined
  let last: MeasuredPoint | undefined
  const visitPoint = (point: MeasuredPoint) => {
    if (diagnostics) diagnostics.pointVisits += 1
    if (
      viewport &&
      (point.screenY < viewport.screenY ||
        point.screenY >= viewport.screenY + viewport.height)
    )
      return
    const range = rangeFor(point.itemId)
    if (
      !range ||
      point.graphemeOffset < range.from ||
      point.graphemeOffset >= range.to
    )
      return
    if (!first || compare(point, first) < 0) first = point
    if (!last || compare(point, last) > 0) last = point
  }

  if (
    layout.geometry &&
    (layout.screenBlockRows || layout.materializedBlocks)
  ) {
    const mounted =
      layout.screenBlockRows ??
      layout.materializedBlocks!.flatMap((block) =>
        block.key.kind === "item"
          ? [
              {
                blockKey: blockKey(block),
                itemId: block.key.itemId,
                screenY: 0,
                rows: block.estimatedRows,
              },
            ]
          : [],
      )
    for (const block of mounted) {
      if (diagnostics) diagnostics.blockVisits += 1
      if (
        viewport &&
        (block.screenY + block.rows <= viewport.screenY ||
          block.screenY >= viewport.screenY + viewport.height)
      )
        continue
      const selected = rangeFor(block.itemId)
      if (!selected) continue
      const geometry = layout.geometry.byBlockKey[block.blockKey]
      if (!geometry) continue
      if (geometry.key.folded) {
        const ref = layout.blockKeysByItem?.[block.itemId]?.find(
          (candidate) => candidate.blockKey === block.blockKey,
        )
        if (!ref) continue
        const from = Math.max(selected.from, ref.from)
        const to = Math.min(selected.to, ref.to)
        const offsets = from < to ? [from, to - 1] : []
        const projectionLength =
          state.projectionById[block.itemId]?.sourceSpans.length
        if (
          projectionLength === ref.to &&
          selected.from <= ref.to &&
          selected.to > ref.to
        )
          offsets.push(ref.to)
        for (const offset of new Set(offsets)) {
          const point = pointInLayout(layout, {
            itemId: block.itemId,
            graphemeOffset: offset,
          })
          if (point) visitPoint(point)
        }
        continue
      }
      const firstRow = viewport
        ? Math.max(0, Math.floor(viewport.screenY - block.screenY))
        : 0
      const lastRow = viewport
        ? Math.min(
            block.rows,
            Math.ceil(viewport.screenY + viewport.height - block.screenY),
          )
        : block.rows
      const offsets =
        viewport && geometry.pointOffsetsByRow
          ? Array.from(
              { length: Math.max(0, lastRow - firstRow) },
              (_, index) => firstRow + index,
            ).flatMap((row) => geometry.pointOffsetsByRow?.[row] ?? [])
          : Object.keys(geometry.points).map(Number)
      for (const graphemeOffset of offsets) {
        const point = pointInLayout(layout, {
          itemId: block.itemId,
          graphemeOffset,
        })
        if (point) visitPoint(point)
      }
    }
  } else {
    for (const points of Object.values(layout.points ?? {}))
      for (const point of Object.values(points)) visitPoint(point)
  }
  if (!first || !last) return undefined
  const anchorIndex = order.get(state.selection.anchor.itemId) ?? -1
  const headIndex = order.get(state.selection.head.itemId) ?? -1
  const forward =
    anchorIndex < headIndex ||
    (anchorIndex === headIndex &&
      state.selection.anchor.graphemeOffset <=
        state.selection.head.graphemeOffset)
  return forward ? { anchor: first, head: last } : { anchor: last, head: first }
}
