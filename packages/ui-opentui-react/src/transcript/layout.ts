import type { ItemId } from "@vimex/conversation"
import { graphemes, type LogicalPoint, type TranscriptState } from "@vimex/transcript"

export interface VisualLine {
  itemId: ItemId
  from: number
  to: number
  row: number
}

export interface TranscriptLayout {
  width: number
  lines: readonly VisualLine[]
  linesByItem: Readonly<Record<string, readonly VisualLine[]>>
  /** Translation from cached native coordinates; use measuredPoint for screen positions. */
  screenOffset?: { readonly x: number; readonly y: number }
  points?: Readonly<Record<string, Readonly<Record<number, MeasuredPoint>>>>
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

function lineForPoint(layout: TranscriptLayout, point: LogicalPoint): VisualLine | undefined {
  const lines = layout.linesByItem[point.itemId]
  if (!lines?.length) return undefined
  const measured = layout.points?.[point.itemId]?.[point.graphemeOffset]
  if (measured) return lines.find(line => line.row === measured.row)
  return lines.find((line, index) => point.graphemeOffset < line.to || (index === lines.length - 1 && point.graphemeOffset <= line.to))
}

// Published layouts are immutable; index measured rows once per reflow so a
// cursor step does not flatten and sort an entire long transcript.
const measuredRows = new WeakMap<object, Map<number, MeasuredPoint[]>>()
function pointsOnRow(layout: TranscriptLayout, row: number): readonly MeasuredPoint[] {
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

export function movePoint(
  layout: TranscriptLayout,
  point: LogicalPoint | undefined,
  motion: "left" | "right" | "up" | "down" | "line-start" | "line-end" | "first" | "last",
): { point: LogicalPoint; preferredScreenRow: number } | undefined {
  if (layout.lines.length === 0) return undefined
  const measured = point ? layout.points?.[point.itemId]?.[point.graphemeOffset] : undefined
  if (measured && (motion === "up" || motion === "down")) {
    const targetRow = measured.row + (motion === "down" ? 1 : -1)
    let target: MeasuredPoint | undefined
    for (const candidate of pointsOnRow(layout, targetRow)) {
      if (!target || Math.abs(candidate.column - measured.column) < Math.abs(target.column - measured.column)) target = candidate
    }
    if (target) return { point: { itemId: target.itemId, graphemeOffset: target.graphemeOffset }, preferredScreenRow: target.row }
  }
  const current = point ? lineForPoint(layout, point) : undefined
  const line = current ?? layout.lines.at(-1)!
  const lineIndex = layout.lines.indexOf(line)
  const column = Math.max(0, (point?.graphemeOffset ?? line.to) - line.from)
  let target = line
  let offset = point?.graphemeOffset ?? line.to

  switch (motion) {
    case "left": {
      if (offset > line.from) offset -= 1
      else if (lineIndex > 0) {
        target = layout.lines[lineIndex - 1]!
        offset = target.to
      }
      break
    }
    case "right": {
      if (offset < line.to) offset += 1
      else if (lineIndex < layout.lines.length - 1) {
        target = layout.lines[lineIndex + 1]!
        offset = target.from
      }
      break
    }
    case "up":
      target = layout.lines[Math.max(0, lineIndex - 1)]!
      offset = Math.min(target.to, target.from + column)
      break
    case "down":
      target = layout.lines[Math.min(layout.lines.length - 1, lineIndex + 1)]!
      offset = Math.min(target.to, target.from + column)
      break
    case "line-start":
      offset = line.from
      break
    case "line-end":
      offset = line.to
      break
    case "first":
      target = layout.lines[0]!
      offset = target.from
      break
    case "last":
      target = layout.lines.at(-1)!
      offset = target.to
      break
  }

  return { point: { itemId: target.itemId, graphemeOffset: offset }, preferredScreenRow: target.row }
}

export function orderedSelectionBounds(state: TranscriptState): { start: LogicalPoint; end: LogicalPoint } | undefined {
  const selection = state.selection
  if (!selection) return undefined
  const ai = state.order.indexOf(selection.anchor.itemId)
  const hi = state.order.indexOf(selection.head.itemId)
  if (ai < hi || (ai === hi && selection.anchor.graphemeOffset <= selection.head.graphemeOffset)) {
    return { start: selection.anchor, end: selection.head }
  }
  return { start: selection.head, end: selection.anchor }
}

export function selectedRangeForItem(state: TranscriptState, itemId: ItemId): { from: number; to: number } | undefined {
  const bounds = orderedSelectionBounds(state)
  if (!bounds) return undefined
  const itemIndex = state.order.indexOf(itemId)
  const startIndex = state.order.indexOf(bounds.start.itemId)
  const endIndex = state.order.indexOf(bounds.end.itemId)
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
