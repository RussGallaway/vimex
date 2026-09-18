import { TextBufferRenderable, type CliRenderer, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import type { ItemId } from "@vimex/conversation"
import { graphemes, type LogicalPoint, type TranscriptState } from "@vimex/transcript"
import type { MeasuredPoint, TranscriptLayout, VisualLine } from "./layout"
import { graphemeCellWidth } from "./layout"

interface ScreenCell { char: string; x: number; y: number }

function cellsIn(renderer: CliRenderer, renderable: Renderable): ScreenCell[] {
  const measured: ScreenCell[] = []
  const visit = (current: Renderable) => {
    if (current instanceof TextBufferRenderable) {
      const lines = current.plainText.split("\n")
      const info = current.lineInfo
      for (let sourceRow = 0; sourceRow < lines.length; sourceRow += 1) {
        let column = 0
        for (const part of graphemes(lines[sourceRow] ?? "")) {
          const candidates = info.lineSources.flatMap((source, index) => source === sourceRow ? [index] : [])
          const visual = candidates.filter((index) => (info.lineStartCols[index] ?? 0) <= column).at(-1) ?? candidates[0] ?? sourceRow
          const start = info.lineStartCols[visual] ?? 0
          measured.push({ char: [...part][0] ?? part, x: current.screenX + column - start, y: current.screenY + visual })
          column += graphemeCellWidth(part)
        }
      }
    }
    for (const child of current.getChildren()) if ("screenX" in child) visit(child as Renderable)
  }
  visit(renderable)
  if (measured.length) return measured.sort((a, b) => a.y - b.y || a.x - b.x)

  const buffer = renderer.currentRenderBuffer
  const cells: ScreenCell[] = []
  const left = Math.max(0, renderable.screenX)
  const top = Math.max(0, renderable.screenY)
  const right = Math.min(buffer.width, renderable.screenX + renderable.width)
  const bottom = Math.min(buffer.height, renderable.screenY + renderable.height)
  const chars = buffer.buffers.char
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const value = chars[y * buffer.width + x] ?? 0
      if (value > 0) cells.push({ char: String.fromCodePoint(value), x, y })
    }
  }
  return cells
}

function sameCell(grapheme: string, cell: ScreenCell): boolean {
  if (/\s/u.test(grapheme)) return /\s/u.test(cell.char)
  return [...grapheme][0] === cell.char
}

function measureItem(renderer: CliRenderer, renderable: Renderable, itemId: ItemId, text: string): Record<number, MeasuredPoint> {
  const cells = cellsIn(renderer, renderable)
  const parts = graphemes(text)
  const result: Record<number, MeasuredPoint> = {}
  let cellIndex = 0
  let last: ScreenCell | undefined
  let firstRow = cells[0]?.y ?? renderable.screenY
  for (let offset = 0; offset < parts.length; offset += 1) {
    const part = parts[offset] ?? ""
    if (part === "\n") {
      const next = cells.find((cell, index) => index >= cellIndex && (!last || cell.y > last.y))
      if (next) {
        result[offset] = { itemId, graphemeOffset: offset, row: next.y - firstRow, column: 0, screenX: next.x, screenY: next.y }
        last = next
      }
      continue
    }
    let found = -1
    for (let index = cellIndex; index < cells.length; index += 1) {
      if (sameCell(part, cells[index]!)) { found = index; break }
    }
    if (found < 0) continue
    const cell = cells[found]!
    if (offset === 0) firstRow = cell.y
    result[offset] = {
      itemId,
      graphemeOffset: offset,
      row: cell.y - firstRow,
      column: cell.x - renderable.screenX,
      screenX: cell.x,
      screenY: cell.y,
    }
    cellIndex = found + 1
    last = cell
  }
  if (last) result[parts.length] = {
    itemId,
    graphemeOffset: parts.length,
    row: last.y - firstRow,
    column: last.x - renderable.screenX + 1,
    screenX: last.x + 1,
    screenY: last.y,
  }
  return result
}

export function measureRenderedTranscript(
  renderer: CliRenderer,
  scrollbox: ScrollBoxRenderable,
  state: TranscriptState,
): TranscriptLayout | undefined {
  const points: Record<string, Record<number, MeasuredPoint>> = {}
  const lines: VisualLine[] = []
  const linesByItem: Record<string, VisualLine[]> = {}
  let absoluteRow = 0
  for (const itemId of state.order) {
    const item = scrollbox.getRenderable(`transcript-item:${itemId}`)
    const projection = state.projectionById[itemId]
    if (!item || !projection) continue
    const itemPoints = measureItem(renderer, item, itemId, projection.plain)
    if (state.folded[itemId]) {
      const visible = Object.values(itemPoints).sort((a, b) => a.graphemeOffset - b.graphemeOffset)
      const fallback = visible[0]
      if (fallback) {
        for (let offset = 0; offset <= graphemes(projection.plain).length; offset += 1) {
          itemPoints[offset] ??= { ...fallback, graphemeOffset: offset }
        }
      }
    }
    points[itemId] = itemPoints
    const byRow = new Map<number, MeasuredPoint[]>()
    for (const point of Object.values(itemPoints)) {
      const list = byRow.get(point.screenY) ?? []
      list.push(point)
      byRow.set(point.screenY, list)
    }
    const itemLines: VisualLine[] = []
    for (const rowPoints of [...byRow.values()].sort((a, b) => a[0]!.screenY - b[0]!.screenY)) {
      rowPoints.sort((a, b) => a.column - b.column)
      const line = { itemId, from: rowPoints[0]!.graphemeOffset, to: rowPoints.at(-1)!.graphemeOffset, row: absoluteRow++ }
      itemLines.push(line)
      lines.push(line)
      for (const point of rowPoints) point.row = line.row
    }
    linesByItem[itemId] = itemLines
  }
  return lines.length ? { width: scrollbox.viewport.width, lines, linesByItem, points } : undefined
}

export function measuredPoint(layout: TranscriptLayout, point: LogicalPoint | undefined): MeasuredPoint | undefined {
  return point ? layout.points?.[point.itemId]?.[point.graphemeOffset] : undefined
}

export function topVisiblePoint(layout: TranscriptLayout, scrollbox: ScrollBoxRenderable): MeasuredPoint | undefined {
  const top = scrollbox.viewport.screenY
  return Object.values(layout.points ?? {}).flatMap((points) => Object.values(points))
    .filter((point) => point.screenY >= top)
    .sort((a, b) => a.screenY - b.screenY || a.screenX - b.screenX)[0]
}
