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
  points?: Readonly<Record<string, Readonly<Record<number, MeasuredPoint>>>>
}

export interface MeasuredPoint {
  itemId: ItemId
  graphemeOffset: number
  row: number
  column: number
  screenX: number
  screenY: number
}

const mark = /\p{Mark}/u
const wide = /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u

export function graphemeCellWidth(value: string): number {
  if (!value || mark.test(value)) return 0
  return wide.test(value) ? 2 : 1
}

function wrapProjection(itemId: ItemId, text: string, width: number, startRow: number): VisualLine[] {
  const cells = graphemes(text)
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
      push(index)
      from = index + 1
      continue
    }
    const next = graphemeCellWidth(cell)
    if (used > 0 && used + next > width) push(index)
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
    const itemLines = wrapProjection(itemId, projection.plain, safeWidth, lines.length)
    lines.push(...itemLines)
    linesByItem[itemId] = itemLines
  }
  return { width: safeWidth, lines, linesByItem }
}

function lineForPoint(layout: TranscriptLayout, point: LogicalPoint): VisualLine | undefined {
  const lines = layout.linesByItem[point.itemId]
  if (!lines?.length) return undefined
  return lines.find((line, index) => point.graphemeOffset < line.to || (index === lines.length - 1 && point.graphemeOffset <= line.to))
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
    const candidates = Object.values(layout.points ?? {}).flatMap((points) => Object.values(points)).filter((candidate) => candidate.row === targetRow)
    const target = candidates.sort((a, b) => Math.abs(a.column - measured.column) - Math.abs(b.column - measured.column))[0]
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
