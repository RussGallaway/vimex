import { DiffRenderable, MarkdownRenderable, TextBufferRenderable, TextTableRenderable, type BlockState, type CliRenderer, type Renderable, type ScrollBoxRenderable, type TextBufferView } from "@opentui/core"
import type { ItemId } from "@vimex/conversation"
import { graphemes, projectMarkdown, type LogicalPoint, type TranscriptState } from "@vimex/transcript"
import type { MeasuredPoint, TranscriptLayout, VisualLine } from "./layout"
import { graphemeCellWidth } from "./layout"

interface ScreenCell { char: string; x: number; y: number }
const blockProjectionCache = new WeakMap<object, { raw: string; plain: string }>()
type LayoutFingerprint = readonly unknown[]
const renderedLayoutCache = new WeakMap<ScrollBoxRenderable, { fingerprint: LayoutFingerprint; layout: TranscriptLayout; originX: number; originY: number }>()
interface ItemGeometryCache {
  fingerprint: LayoutFingerprint
  points: Readonly<Record<number, MeasuredPoint>>
  originX: number
  originY: number
  itemX: number
  itemY: number
}
const itemGeometryCache = new WeakMap<Renderable, ItemGeometryCache>()

function cellsIn(renderer: CliRenderer, renderable: Renderable): ScreenCell[] {
  const measured: ScreenCell[] = []
  const visit = (current: Renderable) => {
    if (current.id.startsWith("decoration:")) return
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
          // Native text keeps its full logical content when the visible header
          // is truncated. Hidden graphemes share the last visible cell rather
          // than producing a cursor outside the renderable (or terminal).
          if (current.width > 0 && current.height > 0) measured.push({
            char: [...part][0] ?? part,
            x: current.screenX + Math.max(0, Math.min(column - start, current.width - 1)),
            y: current.screenY + Math.max(0, Math.min(visual, current.height - 1)),
          })
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

function appendLineInfo(fingerprint: unknown[], view: TextBufferRenderable | TextBufferView, includeContent = true) {
  const info = view.lineInfo
  if (includeContent) fingerprint.push(view instanceof TextBufferRenderable ? view.plainText : view.getPlainText())
  fingerprint.push(info.lineSources.length, ...info.lineSources, info.lineStartCols.length, ...info.lineStartCols)
}

function localPosition(renderable: Renderable, originX: number, originY: number): { x: number; y: number } {
  const native = renderable as Renderable & { _x?: number; _y?: number }
  return { x: native._x ?? renderable.screenX - originX, y: native._y ?? renderable.screenY - originY }
}

function appendNativeFingerprint(fingerprint: unknown[], renderable: Renderable, seen: Set<Renderable>, originX: number, originY: number, includeContent = false, includePosition = true) {
  if (seen.has(renderable)) return
  seen.add(renderable)
  // Viewport culling may freeze offscreen screen coordinates while the scroll
  // origin moves. Yoga-local coordinates describe actual content geometry and
  // remain stable across a pure scroll translation.
  const position = localPosition(renderable, originX, originY)
  if (includePosition) fingerprint.push(position.x, position.y)
  fingerprint.push(renderable.width, renderable.height)
  if (renderable instanceof TextBufferRenderable) appendLineInfo(fingerprint, renderable, includeContent)
  if (renderable instanceof MarkdownRenderable) {
    const runtime = renderable as unknown as { _stableBlockCount?: number }
    fingerprint.push(runtime._stableBlockCount, markdownBlocks(renderable).length)
    for (const block of markdownBlocks(renderable)) {
      fingerprint.push(block.tokenRaw)
      appendNativeFingerprint(fingerprint, block.renderable, seen, renderable.screenX, renderable.screenY, true)
    }
  }
  if (renderable instanceof TextTableRenderable) {
    const runtime = renderable as unknown as TableRuntime
    if (runtime._layout) fingerprint.push(...runtime._layout.columnOffsets, ...runtime._layout.rowOffsets)
    for (const row of runtime._cells ?? []) for (const cell of row) appendLineInfo(fingerprint, cell.textBufferView)
  }
  for (const child of renderable.getChildren()) if ("screenX" in child) appendNativeFingerprint(fingerprint, child as Renderable, seen, renderable.screenX, renderable.screenY, includeContent)
}

function layoutFingerprint(renderer: CliRenderer, scrollbox: ScrollBoxRenderable, state: TranscriptState, itemFingerprints: Map<ItemId, LayoutFingerprint>): LayoutFingerprint {
  const fingerprint: unknown[] = [
    renderer.currentRenderBuffer.width,
    renderer.currentRenderBuffer.height,
    scrollbox.viewport.screenX,
    scrollbox.viewport.screenY,
    scrollbox.viewport.width,
    scrollbox.viewport.height,
    state.order,
    state.projectionById,
    state.folded,
  ]
  for (const itemId of state.order) {
    const projection = state.projectionById[itemId]
    fingerprint.push(itemId, projection, projection?.revision, state.folded[itemId])
    const item = scrollbox.getRenderable(`transcript-item:${itemId}`)
    if (item) {
      const position = localPosition(item, scrollbox.viewport.screenX - scrollbox.scrollLeft, scrollbox.viewport.screenY - scrollbox.scrollTop)
      fingerprint.push(position.x, position.y)
      const itemFingerprint: unknown[] = [projection, projection?.revision, state.folded[itemId]]
      appendNativeFingerprint(itemFingerprint, item, new Set(), scrollbox.viewport.screenX - scrollbox.scrollLeft, scrollbox.viewport.screenY - scrollbox.scrollTop, false, false)
      itemFingerprints.set(itemId, itemFingerprint)
      fingerprint.push(itemFingerprint.length, ...itemFingerprint)
    }
  }
  return fingerprint
}

function sameFingerprint(left: LayoutFingerprint, right: LayoutFingerprint): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

function translateItemPoints(
  cached: ItemGeometryCache,
  originX: number,
  originY: number,
  itemX: number,
  itemY: number,
): Record<number, MeasuredPoint> {
  const deltaX = originX + itemX - cached.originX - cached.itemX
  const deltaY = originY + itemY - cached.originY - cached.itemY
  const translated: Record<number, MeasuredPoint> = {}
  for (const [offset, point] of Object.entries(cached.points)) translated[Number(offset)] = {
    ...point,
    screenX: point.screenX + deltaX,
    screenY: point.screenY + deltaY,
  }
  return translated
}

function cacheItemPoints(
  item: Renderable,
  fingerprint: LayoutFingerprint,
  points: Record<number, MeasuredPoint>,
  originX: number,
  originY: number,
  itemX: number,
  itemY: number,
): Record<number, MeasuredPoint> {
  const stored = Object.fromEntries(Object.entries(points).map(([offset, point]) => [offset, { ...point }]))
  const cached = { fingerprint, points: stored, originX, originY, itemX, itemY }
  itemGeometryCache.set(item, cached)
  // Line construction below assigns absolute rows. Keep the cached geometry
  // private so rebuilding one item can never mutate a layout already returned
  // to the viewport.
  return translateItemPoints(cached, originX, originY, itemX, itemY)
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

interface DiffRuntime {
  diff: string
  leftCodeRenderable?: TextBufferRenderable | null
  rightCodeRenderable?: TextBufferRenderable | null
}

function measureDiff(renderer: CliRenderer, diff: DiffRenderable, itemId: ItemId): Record<number, MeasuredPoint> {
  const runtime = diff as unknown as DiffRuntime
  const sides = {
    left: runtime.leftCodeRenderable ?? undefined,
    right: runtime.rightCodeRenderable ?? undefined,
  }
  const sideState = Object.fromEntries(Object.entries(sides).map(([name, side]) => {
    const lines = side?.plainText.split("\n") ?? []
    const starts: number[] = []
    let offset = 0
    for (const line of lines) { starts.push(offset); offset += graphemes(line).length + 1 }
    return [name, { side, lines, starts, cursor: 0, points: side ? measureRaw(renderer, side, itemId, side.plainText) : {} }]
  })) as Record<"left" | "right", { side?: TextBufferRenderable; lines: string[]; starts: number[]; cursor: number; points: Record<number, MeasuredPoint> }>
  const result: Record<number, MeasuredPoint> = {}
  const sourceLines = runtime.diff.split("\n")
  const sourceOffsets: number[] = []
  let sourceOffset = 0
  for (const line of sourceLines) { sourceOffsets.push(sourceOffset); sourceOffset += graphemes(line).length + 1 }
  let inHunk = false
  let oldRemaining = 0
  let newRemaining = 0
  const consume = (sideName: "left" | "right", content: string, at: number, map: boolean) => {
    const side = sideState[sideName].side ? sideState[sideName] : sideState.left
    let row = -1
    for (let index = side.cursor; index < side.lines.length; index++) {
      if (side.lines[index] === content) { row = index; break }
    }
    if (row < 0) return
    side.cursor = row + 1
    if (!map) return
    const base = side.starts[row]!
    const contentLength = graphemes(content).length
    const visualRow = side.side?.lineInfo.lineSources.findIndex(source => source === row) ?? -1
    const first = side.points[base] ?? (side.side && visualRow >= 0 ? {
      itemId, graphemeOffset: base, row: visualRow, column: 0,
      screenX: side.side.screenX, screenY: side.side.screenY + visualRow,
    } : undefined)
    if (first) result[at] = { ...first, graphemeOffset: at }
    for (let local = 0; local < contentLength; local++) {
      const point = side.points[base + local]
      if (point) result[at + 1 + local] = { ...point, graphemeOffset: at + 1 + local }
    }
  }
  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
    const line = sourceLines[lineIndex]!
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))?/.exec(line)
    if (header) {
      inHunk = true
      oldRemaining = Number(header[1] ?? 1)
      newRemaining = Number(header[2] ?? 1)
      continue
    }
    if (!inHunk) continue
    const marker = line[0]
    if (marker === " ") {
      const content = line.slice(1)
      consume("left", content, sourceOffsets[lineIndex]!, true)
      if (sideState.right.side) consume("right", content, sourceOffsets[lineIndex]!, false)
      oldRemaining--
      newRemaining--
    } else if (marker === "+" || marker === "-") {
      if (!sideState.right.side) {
        consume("left", line.slice(1), sourceOffsets[lineIndex]!, true)
        if (marker === "+") newRemaining--
        else oldRemaining--
      } else {
        // OpenTUI aligns each contiguous remove/add group to its longest side
        // and pads the shorter pane with empty native rows. Consume the whole
        // group before synchronizing cursors so a later blank changed line
        // cannot bind to one of those padding rows.
        while (lineIndex < sourceLines.length && (oldRemaining > 0 || newRemaining > 0)) {
          const changed = sourceLines[lineIndex]!
          const changedMarker = changed[0]
          if (changedMarker !== "+" && changedMarker !== "-") break
          consume(changedMarker === "+" ? "right" : "left", changed.slice(1), sourceOffsets[lineIndex]!, true)
          if (changedMarker === "+") newRemaining--
          else oldRemaining--
          lineIndex++
        }
        lineIndex--
        const aligned = Math.max(sideState.left.cursor, sideState.right.cursor)
        sideState.left.cursor = aligned
        sideState.right.cursor = aligned
      }
    }
    if (oldRemaining <= 0 && newRemaining <= 0) inHunk = false
  }
  return fillPointGaps(itemId, runtime.diff, result)
}

function diffRenderables(renderable: Renderable): DiffRenderable[] {
  const result: DiffRenderable[] = []
  const visit = (current: Renderable) => {
    if (current instanceof DiffRenderable) result.push(current)
    else for (const child of current.getChildren()) if ("screenX" in child) visit(child as Renderable)
  }
  visit(renderable)
  return result
}

function measureItem(renderer: CliRenderer, renderable: Renderable, itemId: ItemId, text: string): Record<number, MeasuredPoint> {
  const markdown = renderable.getRenderable(`markdown:${itemId}`)
  if (markdown instanceof MarkdownRenderable) return measureMarkdown(renderer, markdown, itemId, text)
  const diffs = diffRenderables(renderable)
  if (diffs.length) {
    const result: Record<number, MeasuredPoint> = {}
    let sourceCursor = 0
    let logicalCursor = 0
    for (const diff of diffs) {
      const source = (diff as unknown as DiffRuntime).diff
      const start = text.indexOf(source, sourceCursor)
      if (start < 0) continue
      logicalCursor += graphemes(text.slice(sourceCursor, start)).length
      for (const [offset, point] of Object.entries(measureDiff(renderer, diff, itemId))) {
        const graphemeOffset = logicalCursor + Number(offset)
        result[graphemeOffset] = { ...point, graphemeOffset }
      }
      sourceCursor = start + source.length
      logicalCursor += graphemes(source).length
    }
    return fillPointGaps(itemId, text, result)
  }
  return fillPointGaps(itemId, text, measureRaw(renderer, renderable, itemId, text))
}

export function measureRenderedTranscript(
  renderer: CliRenderer,
  scrollbox: ScrollBoxRenderable,
  state: TranscriptState,
): TranscriptLayout | undefined {
  const itemFingerprints = new Map<ItemId, LayoutFingerprint>()
  const fingerprint = layoutFingerprint(renderer, scrollbox, state, itemFingerprints)
  const cached = renderedLayoutCache.get(scrollbox)
  const originX = scrollbox.viewport.screenX - scrollbox.scrollLeft
  const originY = scrollbox.viewport.screenY - scrollbox.scrollTop
  if (cached && sameFingerprint(cached.fingerprint, fingerprint)) {
    const offset = { x: originX - cached.originX, y: originY - cached.originY }
    if (offset.x === (cached.layout.screenOffset?.x ?? 0) && offset.y === (cached.layout.screenOffset?.y ?? 0)) return cached.layout
    const translated = { ...cached.layout, screenOffset: offset }
    renderedLayoutCache.set(scrollbox, { ...cached, layout: translated })
    return translated
  }
  const points: Record<string, Record<number, MeasuredPoint>> = {}
  const lines: VisualLine[] = []
  const linesByItem: Record<string, VisualLine[]> = {}
  let absoluteRow = 0
  for (const itemId of state.order) {
    const item = scrollbox.getRenderable(`transcript-item:${itemId}`)
    const projection = state.projectionById[itemId]
    if (!item || !projection) continue
    const itemPosition = localPosition(item, originX, originY)
    const itemFingerprint = itemFingerprints.get(itemId)!
    const cachedItem = itemGeometryCache.get(item)
    let itemPoints: Record<number, MeasuredPoint>
    if (cachedItem && sameFingerprint(cachedItem.fingerprint, itemFingerprint)) {
      itemPoints = translateItemPoints(cachedItem, originX, originY, itemPosition.x, itemPosition.y)
    } else {
      const measured = measureItem(renderer, item, itemId, projection.plain)
      if (state.folded[itemId]) {
        const visible = Object.values(measured).sort((a, b) => a.graphemeOffset - b.graphemeOffset)
        const fallback = visible[0]
        if (fallback) {
          const length = graphemes(projection.plain).length
          for (let offset = 0; offset <= length; offset += 1) {
            measured[offset] ??= { ...fallback, graphemeOffset: offset, hidden: true }
          }
        }
      }
      itemPoints = cacheItemPoints(item, itemFingerprint, measured, originX, originY, itemPosition.x, itemPosition.y)
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
  renderedLayoutCache.set(scrollbox, { fingerprint, layout, originX, originY })
  return layout
}

function translatedPoint(layout: TranscriptLayout, point: MeasuredPoint | undefined): MeasuredPoint | undefined {
  if (!point || !layout.screenOffset || (!layout.screenOffset.x && !layout.screenOffset.y)) return point
  return { ...point, screenX: point.screenX + layout.screenOffset.x, screenY: point.screenY + layout.screenOffset.y }
}

export function measuredPoint(layout: TranscriptLayout, point: LogicalPoint | undefined): MeasuredPoint | undefined {
  return translatedPoint(layout, point ? layout.points?.[point.itemId]?.[point.graphemeOffset] : undefined)
}

const visibleRowIndex = new WeakMap<object, readonly MeasuredPoint[]>()
function viewportEdgePoint(layout: TranscriptLayout, scrollbox: ScrollBoxRenderable, edge: "top" | "bottom"): MeasuredPoint | undefined {
  const points = layout.points
  if (!points) return undefined
  let rows = visibleRowIndex.get(points)
  if (!rows) {
    const firstByRow = new Map<number, MeasuredPoint>()
    for (const item of Object.values(points)) for (const point of Object.values(item)) {
      const first = firstByRow.get(point.screenY)
      if (!first || point.screenX < first.screenX) firstByRow.set(point.screenY, point)
    }
    rows = [...firstByRow.values()].sort((a, b) => a.screenY - b.screenY)
    visibleRowIndex.set(points, rows)
  }
  const top = scrollbox.viewport.screenY - (layout.screenOffset?.y ?? 0)
  let low = 0, high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (rows[middle]!.screenY < top) low = middle + 1
    else high = middle
  }
  if (edge === "top") return translatedPoint(layout, rows[low])
  const bottom = top + scrollbox.viewport.height
  let end = rows.length
  while (low < end) {
    const middle = (low + end) >>> 1
    if (rows[middle]!.screenY < bottom) low = middle + 1
    else end = middle
  }
  const point = rows[low - 1]
  return point && point.screenY >= top ? translatedPoint(layout, point) : undefined
}

export function topVisiblePoint(layout: TranscriptLayout, scrollbox: ScrollBoxRenderable): MeasuredPoint | undefined {
  return viewportEdgePoint(layout, scrollbox, "top")
}

/** First text cell on the lowest visible content row, excluding decorative padding. */
export function bottomVisiblePoint(layout: TranscriptLayout, scrollbox: ScrollBoxRenderable): MeasuredPoint | undefined {
  return viewportEdgePoint(layout, scrollbox, "bottom")
}
