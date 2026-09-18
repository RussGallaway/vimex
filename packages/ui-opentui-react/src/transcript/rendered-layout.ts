import { MarkdownRenderable, TextBufferRenderable, TextTableRenderable, type BlockState, type CliRenderer, type Renderable, type ScrollBoxRenderable, type TextBufferView } from "@opentui/core"
import type { ItemId } from "@vimex/conversation"
import { graphemes, projectMarkdown, type LogicalPoint, type TranscriptState } from "@vimex/transcript"
import type { MeasuredPoint, TranscriptLayout, VisualLine } from "./layout"
import { graphemeCellWidth } from "./layout"

interface ScreenCell { char: string; x: number; y: number }
const blockProjectionCache = new WeakMap<object, { raw: string; plain: string }>()
type LayoutFingerprint = readonly unknown[]
const renderedLayoutCache = new WeakMap<ScrollBoxRenderable, { fingerprint: LayoutFingerprint; layout: TranscriptLayout }>()

function cellsIn(renderer: CliRenderer, renderable: Renderable): ScreenCell[] {
  const measured: ScreenCell[] = []
  const visit = (current: Renderable) => {
    if (current instanceof TextBufferRenderable) {
      const lines = current.plainText.split("\n")
      const info = current.lineInfo
      const visualsBySource = new Map<number, number[]>()
      info.lineSources.forEach((source, index) => {
        const candidates = visualsBySource.get(source) ?? []
        candidates.push(index)
        visualsBySource.set(source, candidates)
      })
      for (let sourceRow = 0; sourceRow < lines.length; sourceRow += 1) {
        let column = 0
        const candidates = visualsBySource.get(sourceRow) ?? []
        let candidateIndex = 0
        for (const part of graphemes(lines[sourceRow] ?? "")) {
          while (candidateIndex + 1 < candidates.length && (info.lineStartCols[candidates[candidateIndex + 1]!] ?? 0) <= column) candidateIndex += 1
          const visual = candidates[candidateIndex] ?? sourceRow
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
  const lines = buffer.getSpanLines()
  for (let y = top; y < bottom; y += 1) {
    let x = 0
    for (const span of lines[y]?.spans ?? []) {
      const spanStart = x
      let localX = 0
      for (const part of graphemes(span.text)) {
        const cellX = spanStart + localX
        if (cellX >= left && cellX < right) cells.push({ char: [...part][0] ?? part, x: cellX, y })
        localX += graphemeCellWidth(part)
      }
      x = spanStart + span.width
    }
  }
  return cells
}

function sameCell(grapheme: string, cell: ScreenCell): boolean {
  if (/\s/u.test(grapheme)) return /\s/u.test(cell.char)
  if (grapheme === "|" && cell.char === "│") return true
  return [...grapheme][0] === cell.char
}

function measureRaw(renderer: CliRenderer, renderable: Renderable, itemId: ItemId, text: string): Record<number, MeasuredPoint> {
  const cells = cellsIn(renderer, renderable)
  const parts = graphemes(text)
  const result: Record<number, MeasuredPoint> = {}
  let cellIndex = 0
  let last: ScreenCell | undefined
  let firstRow = cells[0]?.y ?? renderable.screenY
  for (let offset = 0; offset < parts.length; offset += 1) {
    const part = parts[offset] ?? ""
    if (part === "\n") {
      let next: ScreenCell | undefined
      for (let index = cellIndex; index < cells.length; index += 1) {
        if (!last || cells[index]!.y > last.y) { next = cells[index]; break }
      }
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

function fillPointGaps(itemId: ItemId, text: string, points: Record<number, MeasuredPoint>): Record<number, MeasuredPoint> {
  const length = graphemes(text).length
  const known = Object.keys(points).map(Number).sort((a, b) => a - b)
  if (known.length === 0) return points
  let nextIndex = 0
  for (let offset = 0; offset <= length; offset += 1) {
    if (points[offset]) continue
    while (nextIndex < known.length && known[nextIndex]! < offset) nextIndex += 1
    const previousOffset = nextIndex > 0 ? known[nextIndex - 1] : undefined
    const nextOffset = known[nextIndex]
    const previous = previousOffset === undefined ? undefined : points[previousOffset]
    const next = nextOffset === undefined ? undefined : points[nextOffset]
    let basis = previous ?? next
    if (previous && next) {
      if (previous.screenY === next.screenY) {
        const ratio = (offset - previousOffset!) / (nextOffset! - previousOffset!)
        const screenX = Math.round(previous.screenX + (next.screenX - previous.screenX) * ratio)
        points[offset] = { itemId, graphemeOffset: offset, row: previous.row, column: previous.column + screenX - previous.screenX, screenX, screenY: previous.screenY }
        continue
      }
      basis = offset - previousOffset! <= nextOffset! - offset ? previous : next
    }
    if (basis) points[offset] = { ...basis, itemId, graphemeOffset: offset }
  }
  return points
}

function markdownBlocks(markdown: MarkdownRenderable): readonly BlockState[] {
  return (markdown as unknown as { _blockStates?: readonly BlockState[] })._blockStates ?? []
}

interface TableLayout { columnOffsets: readonly number[]; rowOffsets: readonly number[] }
interface TableCell { textBufferView: TextBufferView }
interface TableRuntime { _layout?: TableLayout; _cells?: readonly (readonly TableCell[])[] }

function appendLineInfo(fingerprint: unknown[], view: TextBufferRenderable | TextBufferView) {
  const info = view.lineInfo
  fingerprint.push(view instanceof TextBufferRenderable ? view.plainText : view.getPlainText(), info.lineSources.length, ...info.lineSources, info.lineStartCols.length, ...info.lineStartCols)
}

function appendNativeFingerprint(fingerprint: unknown[], renderable: Renderable, seen: Set<Renderable>) {
  if (seen.has(renderable)) return
  seen.add(renderable)
  fingerprint.push(renderable, renderable.screenX, renderable.screenY, renderable.width, renderable.height)
  if (renderable instanceof TextBufferRenderable) appendLineInfo(fingerprint, renderable)
  if (renderable instanceof MarkdownRenderable) {
    const runtime = renderable as unknown as { _parseState?: object | null; _stableBlockCount?: number }
    fingerprint.push(runtime._parseState, runtime._stableBlockCount, markdownBlocks(renderable).length)
    for (const block of markdownBlocks(renderable)) {
      fingerprint.push(block, block.tokenRaw)
      appendNativeFingerprint(fingerprint, block.renderable, seen)
    }
  }
  if (renderable instanceof TextTableRenderable) {
    const runtime = renderable as unknown as TableRuntime
    fingerprint.push(runtime._layout)
    if (runtime._layout) fingerprint.push(...runtime._layout.columnOffsets, ...runtime._layout.rowOffsets)
    for (const row of runtime._cells ?? []) for (const cell of row) appendLineInfo(fingerprint, cell.textBufferView)
  }
  for (const child of renderable.getChildren()) if ("screenX" in child) appendNativeFingerprint(fingerprint, child as Renderable, seen)
}

function layoutFingerprint(renderer: CliRenderer, scrollbox: ScrollBoxRenderable, state: TranscriptState): LayoutFingerprint {
  const fingerprint: unknown[] = [
    renderer.currentRenderBuffer.width,
    renderer.currentRenderBuffer.height,
    scrollbox.viewport.screenX,
    scrollbox.viewport.screenY,
    scrollbox.viewport.width,
    scrollbox.viewport.height,
    scrollbox.scrollTop,
    scrollbox.scrollLeft,
    state.order,
    state.projectionById,
    state.folded,
  ]
  const seen = new Set<Renderable>()
  for (const itemId of state.order) {
    const projection = state.projectionById[itemId]
    fingerprint.push(itemId, projection, projection?.revision, state.folded[itemId])
    const item = scrollbox.getRenderable(`transcript-item:${itemId}`)
    if (item) appendNativeFingerprint(fingerprint, item, seen)
  }
  return fingerprint
}

function sameFingerprint(left: LayoutFingerprint, right: LayoutFingerprint): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

function cellPoint(view: TextBufferView, originX: number, originY: number, sourceOffset: number): { x: number; y: number } {
  const parts = graphemes(view.getPlainText())
  let column = 0
  for (let index = 0; index < Math.min(sourceOffset, parts.length); index += 1) column += graphemeCellWidth(parts[index]!)
  const info = view.lineInfo
  const candidates = info.lineSources.flatMap((source, index) => source === 0 ? [index] : [])
  const visual = candidates.filter((index) => (info.lineStartCols[index] ?? 0) <= column).at(-1) ?? candidates[0] ?? 0
  return { x: originX + column - (info.lineStartCols[visual] ?? 0), y: originY + visual }
}

function measureTable(table: TextTableRenderable, itemId: ItemId, text: string): Record<number, MeasuredPoint> {
  const runtime = table as unknown as TableRuntime
  const layout = runtime._layout
  const cells = runtime._cells
  if (!layout || !cells) return {}
  const result: Record<number, MeasuredPoint> = {}
  const outer = table.outerBorder ? 1 : 0
  let logicalLineStart = 0
  const logicalLines = text.split("\n")
  for (let row = 0; row < Math.min(logicalLines.length, cells.length); row += 1) {
    const line = graphemes(logicalLines[row] ?? "")
    const pipes = line.flatMap((part, index) => part === "|" ? [index] : [])
    const rowY = table.screenY + outer + (layout.rowOffsets[row] ?? row) + table.cellPaddingY
    for (let boundary = 0; boundary < pipes.length; boundary += 1) {
      const offset = logicalLineStart + pipes[boundary]!
      const x = table.screenX + (layout.columnOffsets[Math.min(boundary, layout.columnOffsets.length - 1)] ?? 0)
      result[offset] = { itemId, graphemeOffset: offset, row, column: x - table.screenX, screenX: x, screenY: rowY }
    }
    for (let columnIndex = 0; columnIndex < Math.min(cells[row]!.length, Math.max(0, pipes.length - 1)); columnIndex += 1) {
      const from = pipes[columnIndex]! + 1
      const to = pipes[columnIndex + 1]!
      const segment = line.slice(from, to)
      const leading = segment.findIndex((part) => !/^\s$/u.test(part))
      if (leading < 0) continue
      const trailing = segment.findLastIndex((part) => !/^\s$/u.test(part))
      const logical = segment.slice(leading, trailing + 1)
      const view = cells[row]![columnIndex]!.textBufferView
      const source = graphemes(view.getPlainText())
      let sourceOffset = 0
      for (let local = 0; local < logical.length; local += 1) {
        const found = source.findIndex((part, index) => index >= sourceOffset && sameCell(logical[local]!, { char: [...part][0] ?? part, x: 0, y: 0 }))
        if (found < 0) continue
        const originX = table.screenX + outer + (layout.columnOffsets[columnIndex] ?? 0) + table.cellPaddingX
        const point = cellPoint(view, originX, rowY, found)
        const graphemeOffset = logicalLineStart + from + leading + local
        result[graphemeOffset] = { itemId, graphemeOffset, row, column: point.x - table.screenX, screenX: point.x, screenY: point.y }
        sourceOffset = found + 1
      }
    }
    logicalLineStart += line.length + 1
  }
  return fillPointGaps(itemId, text, result)
}

function measureMarkdown(renderer: CliRenderer, markdown: MarkdownRenderable, itemId: ItemId, text: string): Record<number, MeasuredPoint> {
  const result: Record<number, MeasuredPoint> = {}
  let sourceCursor = 0
  let logicalCursor = 0
  for (const block of markdownBlocks(markdown)) {
    const cached = blockProjectionCache.get(block as object)
    const projected = cached?.raw === block.tokenRaw ? cached.plain : projectMarkdown(block.tokenRaw).plain
    if (!cached || cached.raw !== block.tokenRaw) blockProjectionCache.set(block as object, { raw: block.tokenRaw, plain: projected })
    const core = projected.replace(/\n+$/u, "")
    if (!core) continue
    const start = text.indexOf(core, sourceCursor)
    if (start < 0) continue
    logicalCursor += graphemes(text.slice(sourceCursor, start)).length
    const logicalStart = logicalCursor
    const measured = block.renderable instanceof TextTableRenderable
      ? measureTable(block.renderable, itemId, core)
      : measureRaw(renderer, block.renderable, itemId, core)
    for (const [localOffset, point] of Object.entries(measured)) {
      const graphemeOffset = logicalStart + Number(localOffset)
      result[graphemeOffset] = { ...point, graphemeOffset }
    }
    sourceCursor = start + core.length
    logicalCursor += graphemes(core).length
  }
  return fillPointGaps(itemId, text, result)
}

function measureItem(renderer: CliRenderer, renderable: Renderable, itemId: ItemId, text: string): Record<number, MeasuredPoint> {
  const markdown = renderable.getRenderable(`markdown:${itemId}`)
  if (markdown instanceof MarkdownRenderable) return measureMarkdown(renderer, markdown, itemId, text)
  return fillPointGaps(itemId, text, measureRaw(renderer, renderable, itemId, text))
}

export function measureRenderedTranscript(
  renderer: CliRenderer,
  scrollbox: ScrollBoxRenderable,
  state: TranscriptState,
): TranscriptLayout | undefined {
  const fingerprint = layoutFingerprint(renderer, scrollbox, state)
  const cached = renderedLayoutCache.get(scrollbox)
  if (cached && sameFingerprint(cached.fingerprint, fingerprint)) return cached.layout
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
  if (!lines.length) return undefined
  const layout = { width: scrollbox.viewport.width, lines, linesByItem, points }
  renderedLayoutCache.set(scrollbox, { fingerprint, layout })
  return layout
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
