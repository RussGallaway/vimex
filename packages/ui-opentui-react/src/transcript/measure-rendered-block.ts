import {
  DiffRenderable,
  MarkdownRenderable,
  TextBufferRenderable,
  TextTableRenderable,
  type BlockState,
  type CliRenderer,
  type Renderable,
  type TextBufferView,
} from "@opentui/core"
import {
  blockKey,
  blockGraphemeRange,
  freezeBlockGeometry,
  graphemes,
  projectMarkdown,
  type BlockGeometry,
  type GeometryStyleRevision,
  type TranscriptBlock,
  type TranscriptBlockPresentation,
} from "@vimex/transcript"
import { graphemeCellWidth } from "./layout"

interface NativePoint {
  readonly graphemeOffset: number
  readonly x: number
  readonly y: number
  readonly hidden?: boolean
}

interface ScreenCell {
  readonly char: string
  readonly x: number
  readonly y: number
}
interface TableLayout {
  readonly columnOffsets: readonly number[]
  readonly rowOffsets: readonly number[]
}
interface TableCell {
  readonly textBufferView: TextBufferView
}
interface TableRuntime {
  readonly _layout?: TableLayout
  readonly _cells?: readonly (readonly TableCell[])[]
}
interface DiffRuntime {
  readonly diff: string
  readonly leftCodeRenderable?: TextBufferRenderable | null
  readonly rightCodeRenderable?: TextBufferRenderable | null
}

export interface MeasureRenderedBlockInput {
  readonly renderer: CliRenderer
  /** The native root mounted for this block. */
  readonly renderable: Renderable
  readonly block: TranscriptBlock
  readonly width: number
  readonly styleRevision: GeometryStyleRevision
  readonly folded: boolean
  readonly presentation?: TranscriptBlockPresentation
}

export interface DirtyRenderedBlock {
  readonly renderable: Renderable
  /** Last measured key, absent until the root has been measured once. */
  readonly blockKey?: string
  /** Monotonic invalidation signal; it may advance without changing geometry. */
  readonly signalRevision: number
}

interface RenderedBlockState {
  readonly renderable: Renderable
  readonly observedRenderables: WeakSet<Renderable>
  readonly observedText: WeakSet<TextBufferRenderable>
  blockKey?: string
  signalRevision: number
  dirty: boolean
  destroyed: boolean
  geometry?: BlockGeometry
}

const states = new WeakMap<Renderable, RenderedBlockState>()
const dirtyStates = new Set<RenderedBlockState>()
const blockProjectionCache = new WeakMap<
  object,
  { raw: string; plain: string }
>()
let nextNativeRevision = 1

function stateFor(renderable: Renderable): RenderedBlockState {
  const existing = states.get(renderable)
  if (existing) return existing
  const state: RenderedBlockState = {
    renderable,
    observedRenderables: new WeakSet(),
    observedText: new WeakSet(),
    signalRevision: 0,
    dirty: true,
    destroyed: false,
  }
  renderable.on("destroyed", () => {
    state.destroyed = true
    dirtyStates.delete(state)
  })
  renderable.on("resized", () => markDirty(state))
  renderable.on("layout-changed", () => markDirty(state))
  states.set(renderable, state)
  return state
}

function markDirty(state: RenderedBlockState): void {
  if (state.destroyed) return
  state.signalRevision += 1
  state.dirty = true
  dirtyStates.add(state)
}

/** Explicit fallback for renderer changes that do not expose a native event. */
export function invalidateRenderedBlock(renderable: Renderable): void {
  markDirty(stateFor(renderable))
}

/** The revision of the last geometry-changing native observation. */
export function blockNativeRevision(renderable: Renderable): number {
  return states.get(renderable)?.geometry?.nativeRevision ?? 0
}

/**
 * Consume roots dirtied by native events. The returned roots retain their dirty
 * bit until measured, so a caller may safely discard a stale measurement batch.
 */
export function takeDirtyRenderedBlocks(): readonly DirtyRenderedBlock[] {
  const dirty = [...dirtyStates]
    .filter((state) => !state.destroyed)
    .map((state) =>
      Object.freeze({
        renderable: state.renderable,
        ...(state.blockKey === undefined ? {} : { blockKey: state.blockKey }),
        signalRevision: state.signalRevision,
      }),
    )
  return Object.freeze(dirty)
}

function observeText(
  state: RenderedBlockState,
  view: TextBufferRenderable,
): void {
  if (state.observedText.has(view)) return
  state.observedText.add(view)
  view.on("line-info-change", () => markDirty(state))
}

function observeRenderable(
  state: RenderedBlockState,
  renderable: Renderable,
): void {
  if (
    renderable === state.renderable ||
    state.observedRenderables.has(renderable)
  )
    return
  state.observedRenderables.add(renderable)
  // React and native Markdown parsers may replace a same-size child without
  // resizing the block root. Destruction is the narrow structural signal that
  // lets the next frame inspect only this owning block.
  renderable.on("destroyed", () => markDirty(state))
}

function observeNativeTree(state: RenderedBlockState, root: Renderable): void {
  const visit = (current: Renderable) => {
    observeRenderable(state, current)
    if (current instanceof TextBufferRenderable) observeText(state, current)
    if (current instanceof MarkdownRenderable) {
      for (const block of markdownBlocks(current)) visit(block.renderable)
    }
    for (const child of current.getChildren())
      if ("screenX" in child) visit(child as Renderable)
  }
  visit(root)
}

function cellsIn(renderer: CliRenderer, renderable: Renderable): ScreenCell[] {
  const measured: ScreenCell[] = []
  const visit = (current: Renderable) => {
    if (current.id.startsWith("decoration:")) return
    if (current instanceof TextBufferRenderable) {
      const lines = current.plainText.split("\n")
      const info = current.lineInfo
      const visualsBySource = new Map<number, number[]>()
      info.lineSources.forEach((source, index) => {
        const candidates = visualsBySource.get(source)
        if (candidates) candidates.push(index)
        else visualsBySource.set(source, [index])
      })
      for (let sourceRow = 0; sourceRow < lines.length; sourceRow += 1) {
        let column = 0
        const candidates = visualsBySource.get(sourceRow) ?? []
        let candidateIndex = 0
        for (const part of graphemes(lines[sourceRow] ?? "")) {
          while (
            candidateIndex + 1 < candidates.length &&
            (info.lineStartCols[candidates[candidateIndex + 1]!] ?? 0) <= column
          )
            candidateIndex += 1
          const visual = candidates[candidateIndex] ?? sourceRow
          const start = info.lineStartCols[visual] ?? 0
          if (current.width > 0 && current.height > 0)
            measured.push({
              char: [...part][0] ?? part,
              x:
                current.screenX +
                Math.max(0, Math.min(column - start, current.width - 1)),
              y:
                current.screenY +
                Math.max(0, Math.min(visual, current.height - 1)),
            })
          column += graphemeCellWidth(part)
        }
      }
    }
    for (const child of current.getChildren())
      if ("screenX" in child) visit(child as Renderable)
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
        if (cellX >= left && cellX < right)
          cells.push({ char: [...part][0] ?? part, x: cellX, y })
        localX += graphemeCellWidth(part)
      }
      x = spanStart + span.width
    }
  }
  return cells
}

function sameCell(grapheme: string, cell: Pick<ScreenCell, "char">): boolean {
  if (/\s/u.test(grapheme)) return /\s/u.test(cell.char)
  if (grapheme === "|" && cell.char === "│") return true
  return [...grapheme][0] === cell.char
}

function measureRaw(
  renderer: CliRenderer,
  renderable: Renderable,
  text: string,
): Record<number, NativePoint> {
  const cells = cellsIn(renderer, renderable)
  const parts = graphemes(text)
  const result: Record<number, NativePoint> = {}
  let cellIndex = 0
  let last: ScreenCell | undefined
  if (parts.length === 0 && cells[0])
    result[0] = { graphemeOffset: 0, x: cells[0].x, y: cells[0].y }
  for (
    let offset = 0;
    offset < parts.length && cellIndex < cells.length;
    offset += 1
  ) {
    const part = parts[offset] ?? ""
    if (part === "\n") {
      let next: ScreenCell | undefined
      for (let index = cellIndex; index < cells.length; index += 1) {
        if (!last || cells[index]!.y > last.y) {
          next = cells[index]
          break
        }
      }
      if (next) {
        result[offset] = { graphemeOffset: offset, x: next.x, y: next.y }
        last = next
      }
      continue
    }
    let found = -1
    for (let index = cellIndex; index < cells.length; index += 1) {
      if (sameCell(part, cells[index]!)) {
        found = index
        break
      }
    }
    if (found < 0) continue
    const cell = cells[found]!
    result[offset] = { graphemeOffset: offset, x: cell.x, y: cell.y }
    cellIndex = found + 1
    last = cell
  }
  if (last)
    result[parts.length] = {
      graphemeOffset: parts.length,
      x: last.x + 1,
      y: last.y,
    }
  return result
}

function fillPointGaps(
  text: string,
  points: Record<number, NativePoint>,
): Record<number, NativePoint> {
  const length = graphemes(text).length
  const known = Object.keys(points)
    .map(Number)
    .sort((a, b) => a - b)
  if (known.length === 0) return points
  let nextIndex = 0
  for (let offset = 0; offset <= length; offset += 1) {
    if (points[offset]) continue
    while (nextIndex < known.length && known[nextIndex]! < offset)
      nextIndex += 1
    const previousOffset = nextIndex > 0 ? known[nextIndex - 1] : undefined
    const nextOffset = known[nextIndex]
    const previous =
      previousOffset === undefined ? undefined : points[previousOffset]
    const next = nextOffset === undefined ? undefined : points[nextOffset]
    let basis = previous ?? next
    if (previous && next) {
      if (previous.y === next.y) {
        const ratio =
          (offset - previousOffset!) / (nextOffset! - previousOffset!)
        const x = Math.round(previous.x + (next.x - previous.x) * ratio)
        points[offset] = { graphemeOffset: offset, x, y: previous.y }
        continue
      }
      basis = offset - previousOffset! <= nextOffset! - offset ? previous : next
    }
    if (basis) points[offset] = { ...basis, graphemeOffset: offset }
  }
  return points
}

function foldedPointFallback(
  textLength: number,
  points: Record<number, NativePoint>,
): Record<number, NativePoint> {
  const visible = Object.values(points).sort(
    (a, b) => a.graphemeOffset - b.graphemeOffset,
  )
  const fallback = visible[0]
  if (!fallback) return points
  // A collapsed block needs boundary anchors, not one allocation per hidden
  // grapheme. Geometry accessors can resolve interior offsets to this sentinel.
  points[0] ??= { ...fallback, graphemeOffset: 0, hidden: true }
  if (textLength > 0)
    points[textLength] = {
      ...fallback,
      graphemeOffset: textLength,
      hidden: true,
    }
  return points
}

function markdownBlocks(markdown: MarkdownRenderable): readonly BlockState[] {
  return (
    (markdown as unknown as { _blockStates?: readonly BlockState[] })
      ._blockStates ?? []
  )
}

function cellPoints(
  view: TextBufferView,
  originX: number,
  originY: number,
): readonly { x: number; y: number }[] {
  const parts = graphemes(view.getPlainText())
  const info = view.lineInfo
  const candidates: number[] = []
  info.lineSources.forEach((source, index) => {
    if (source === 0) candidates.push(index)
  })
  let visualIndex = 0
  let column = 0
  const points: { x: number; y: number }[] = []
  for (let offset = 0; offset <= parts.length; offset += 1) {
    while (
      visualIndex + 1 < candidates.length &&
      (info.lineStartCols[candidates[visualIndex + 1]!] ?? 0) <= column
    )
      visualIndex += 1
    const visual = candidates[visualIndex] ?? 0
    points.push({
      x: originX + column - (info.lineStartCols[visual] ?? 0),
      y: originY + visual,
    })
    column += graphemeCellWidth(parts[offset] ?? "")
  }
  return points
}

function measureTable(
  table: TextTableRenderable,
  text: string,
  fillGaps: boolean,
): Record<number, NativePoint> {
  const runtime = table as unknown as TableRuntime
  const layout = runtime._layout
  const cells = runtime._cells
  if (!layout || !cells) return {}
  const result: Record<number, NativePoint> = {}
  const outer = table.outerBorder ? 1 : 0
  let logicalLineStart = 0
  const logicalLines = text.split("\n")
  for (
    let row = 0;
    row < Math.min(logicalLines.length, cells.length);
    row += 1
  ) {
    const line = graphemes(logicalLines[row] ?? "")
    const pipes: number[] = []
    line.forEach((part, index) => {
      if (part === "|") pipes.push(index)
    })
    const rowY =
      table.screenY +
      outer +
      (layout.rowOffsets[row] ?? row) +
      table.cellPaddingY
    for (let boundary = 0; boundary < pipes.length; boundary += 1) {
      const graphemeOffset = logicalLineStart + pipes[boundary]!
      const x =
        table.screenX +
        (layout.columnOffsets[
          Math.min(boundary, layout.columnOffsets.length - 1)
        ] ?? 0)
      result[graphemeOffset] = { graphemeOffset, x, y: rowY }
    }
    for (
      let columnIndex = 0;
      columnIndex < Math.min(cells[row]!.length, Math.max(0, pipes.length - 1));
      columnIndex += 1
    ) {
      const from = pipes[columnIndex]! + 1
      const to = pipes[columnIndex + 1]!
      const segment = line.slice(from, to)
      const leading = segment.findIndex((part) => !/^\s$/u.test(part))
      if (leading < 0) continue
      const trailing = segment.findLastIndex((part) => !/^\s$/u.test(part))
      const logical = segment.slice(leading, trailing + 1)
      const view = cells[row]![columnIndex]!.textBufferView
      const source = graphemes(view.getPlainText())
      const originX =
        table.screenX +
        outer +
        (layout.columnOffsets[columnIndex] ?? 0) +
        table.cellPaddingX
      const coordinates = cellPoints(view, originX, rowY)
      let sourceOffset = 0
      for (let local = 0; local < logical.length; local += 1) {
        while (
          sourceOffset < source.length &&
          !sameCell(logical[local]!, {
            char: [...source[sourceOffset]!][0] ?? source[sourceOffset]!,
          })
        )
          sourceOffset += 1
        if (sourceOffset >= source.length) break
        const point = coordinates[sourceOffset]!
        const graphemeOffset = logicalLineStart + from + leading + local
        result[graphemeOffset] = { graphemeOffset, x: point.x, y: point.y }
        sourceOffset += 1
      }
    }
    logicalLineStart += line.length + 1
  }
  return fillGaps ? fillPointGaps(text, result) : result
}

function measureMarkdown(
  renderer: CliRenderer,
  markdown: MarkdownRenderable,
  text: string,
  fillGaps: boolean,
): Record<number, NativePoint> {
  const result: Record<number, NativePoint> = {}
  let sourceCursor = 0
  let logicalCursor = 0
  for (const block of markdownBlocks(markdown)) {
    const cached = blockProjectionCache.get(block as object)
    const projected =
      cached?.raw === block.tokenRaw
        ? cached.plain
        : projectMarkdown(block.tokenRaw).plain
    if (!cached || cached.raw !== block.tokenRaw)
      blockProjectionCache.set(block as object, {
        raw: block.tokenRaw,
        plain: projected,
      })
    const core = projected.replace(/\n+$/u, "")
    if (!core) continue
    const start = text.indexOf(core, sourceCursor)
    if (start < 0) continue
    logicalCursor += graphemes(text.slice(sourceCursor, start)).length
    const logicalStart = logicalCursor
    const measured =
      block.renderable instanceof TextTableRenderable
        ? measureTable(block.renderable, core, fillGaps)
        : measureRaw(renderer, block.renderable, core)
    for (const localOffset in measured) {
      const graphemeOffset = logicalStart + Number(localOffset)
      result[graphemeOffset] = { ...measured[localOffset]!, graphemeOffset }
    }
    sourceCursor = start + core.length
    logicalCursor += graphemes(core).length
  }
  return fillGaps ? fillPointGaps(text, result) : result
}

function measureDiff(
  renderer: CliRenderer,
  diff: DiffRenderable,
): Record<number, NativePoint> {
  const runtime = diff as unknown as DiffRuntime
  const sides = {
    left: runtime.leftCodeRenderable ?? undefined,
    right: runtime.rightCodeRenderable ?? undefined,
  }
  const sideState = Object.fromEntries(
    Object.entries(sides).map(([name, side]) => {
      const lines = side?.plainText.split("\n") ?? []
      const starts: number[] = []
      let offset = 0
      for (const line of lines) {
        starts.push(offset)
        offset += graphemes(line).length + 1
      }
      return [
        name,
        {
          side,
          lines,
          starts,
          cursor: 0,
          points: side ? measureRaw(renderer, side, side.plainText) : {},
        },
      ]
    }),
  ) as Record<
    "left" | "right",
    {
      side?: TextBufferRenderable
      lines: string[]
      starts: number[]
      cursor: number
      points: Record<number, NativePoint>
    }
  >
  const result: Record<number, NativePoint> = {}
  const sourceLines = runtime.diff.split("\n")
  const sourceOffsets: number[] = []
  let sourceOffset = 0
  for (const line of sourceLines) {
    sourceOffsets.push(sourceOffset)
    sourceOffset += graphemes(line).length + 1
  }
  let inHunk = false
  let oldRemaining = 0
  let newRemaining = 0
  const consume = (
    sideName: "left" | "right",
    content: string,
    at: number,
    map: boolean,
  ) => {
    const side = sideState[sideName].side ? sideState[sideName] : sideState.left
    let row = -1
    for (let index = side.cursor; index < side.lines.length; index += 1)
      if (side.lines[index] === content) {
        row = index
        break
      }
    if (row < 0) return
    side.cursor = row + 1
    if (!map) return
    const base = side.starts[row]!
    const contentLength = graphemes(content).length
    const visualRow =
      side.side?.lineInfo.lineSources.findIndex((source) => source === row) ??
      -1
    const first =
      side.points[base] ??
      (side.side && visualRow >= 0
        ? {
            graphemeOffset: base,
            x: side.side.screenX,
            y: side.side.screenY + visualRow,
          }
        : undefined)
    if (first) result[at] = { ...first, graphemeOffset: at }
    for (let local = 0; local < contentLength; local += 1) {
      const point = side.points[base + local]
      if (point)
        result[at + 1 + local] = { ...point, graphemeOffset: at + 1 + local }
    }
  }
  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
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
      if (sideState.right.side)
        consume("right", content, sourceOffsets[lineIndex]!, false)
      oldRemaining -= 1
      newRemaining -= 1
    } else if (marker === "+" || marker === "-") {
      if (!sideState.right.side) {
        consume("left", line.slice(1), sourceOffsets[lineIndex]!, true)
        if (marker === "+") newRemaining -= 1
        else oldRemaining -= 1
      } else {
        while (
          lineIndex < sourceLines.length &&
          (oldRemaining > 0 || newRemaining > 0)
        ) {
          const changed = sourceLines[lineIndex]!
          const changedMarker = changed[0]
          if (changedMarker !== "+" && changedMarker !== "-") break
          consume(
            changedMarker === "+" ? "right" : "left",
            changed.slice(1),
            sourceOffsets[lineIndex]!,
            true,
          )
          if (changedMarker === "+") newRemaining -= 1
          else oldRemaining -= 1
          lineIndex += 1
        }
        lineIndex -= 1
        const aligned = Math.max(sideState.left.cursor, sideState.right.cursor)
        sideState.left.cursor = aligned
        sideState.right.cursor = aligned
      }
    }
    if (oldRemaining <= 0 && newRemaining <= 0) inHunk = false
  }
  return result
}

function diffRenderables(renderable: Renderable): readonly DiffRenderable[] {
  const result: DiffRenderable[] = []
  const visit = (current: Renderable) => {
    if (current instanceof DiffRenderable) result.push(current)
    else
      for (const child of current.getChildren())
        if ("screenX" in child) visit(child as Renderable)
  }
  visit(renderable)
  return result
}

function measureItem(
  renderer: CliRenderer,
  renderable: Renderable,
  itemId: string,
  blockId: string,
  text: string,
  fillGaps: boolean,
): Record<number, NativePoint> {
  const suffix = blockId === "root" ? "" : `:${blockId}`
  const markdown = renderable.findDescendantById(`markdown:${itemId}${suffix}`)
  if (markdown instanceof MarkdownRenderable)
    return measureMarkdown(renderer, markdown, text, fillGaps)
  const diffs = diffRenderables(renderable)
  if (diffs.length) {
    const result: Record<number, NativePoint> = {}
    let sourceCursor = 0
    let logicalCursor = 0
    for (const diff of diffs) {
      const source = (diff as unknown as DiffRuntime).diff
      const start = text.indexOf(source, sourceCursor)
      if (start < 0) continue
      logicalCursor += graphemes(text.slice(sourceCursor, start)).length
      for (const [offset, point] of Object.entries(
        measureDiff(renderer, diff),
      )) {
        const graphemeOffset = logicalCursor + Number(offset)
        result[graphemeOffset] = { ...point, graphemeOffset }
      }
      sourceCursor = start + source.length
      logicalCursor += graphemes(source).length
    }
    return fillGaps ? fillPointGaps(text, result) : result
  }
  const measured = measureRaw(renderer, renderable, text)
  return fillGaps ? fillPointGaps(text, measured) : measured
}

function sameKey(
  left: BlockGeometry["key"],
  right: BlockGeometry["key"],
): boolean {
  return (
    left.blockKey === right.blockKey &&
    left.contentRevision === right.contentRevision &&
    left.width === right.width &&
    left.styleRevision === right.styleRevision &&
    left.folded === right.folded &&
    (left.presentation ?? "item") === (right.presentation ?? "item")
  )
}

function sameGeometryShape(left: BlockGeometry, right: BlockGeometry): boolean {
  if (left.rows !== right.rows || left.lines.length !== right.lines.length)
    return false
  const leftOffsets = Object.keys(left.points)
  const rightOffsets = Object.keys(right.points)
  if (leftOffsets.length !== rightOffsets.length) return false
  for (const offset of leftOffsets) {
    const a = left.points[Number(offset)]
    const b = right.points[Number(offset)]
    if (
      !a ||
      !b ||
      a.graphemeOffset !== b.graphemeOffset ||
      a.row !== b.row ||
      a.column !== b.column ||
      a.hidden !== b.hidden
    )
      return false
  }
  return left.lines.every((line, index) => {
    const other = right.lines[index]
    return Boolean(
      other &&
      line.from === other.from &&
      line.to === other.to &&
      line.row === other.row,
    )
  })
}

/** Measure one mounted render block into immutable, renderer-neutral local geometry. */
export function measureRenderedBlock(
  input: MeasureRenderedBlockInput,
): BlockGeometry {
  const state = stateFor(input.renderable)
  const key = Object.freeze({
    blockKey: blockKey(input.block),
    contentRevision: input.block.contentRevision,
    width: Math.max(1, Math.floor(input.width)),
    styleRevision: input.styleRevision,
    folded: input.folded,
    ...((input.presentation ?? "item") === "item"
      ? {}
      : { presentation: input.presentation }),
  })
  state.blockKey = key.blockKey
  if (!state.dirty && state.geometry && sameKey(state.geometry.key, key))
    return state.geometry

  observeNativeTree(state, input.renderable)
  const hidden = input.presentation === "activity-hidden"
  const activityLead = input.presentation === "activity-lead"
  const range =
    "item" in input.block ? blockGraphemeRange(input.block) : { from: 0, to: 0 }
  const text =
    "item" in input.block
      ? graphemes(input.block.projection.plain)
          .slice(range.from, range.to)
          .join("")
      : ""
  const textLength = range.to - range.from
  let nativePoints =
    "item" in input.block && !hidden && !activityLead
      ? measureItem(
          input.renderer,
          input.renderable,
          input.block.key.itemId,
          input.block.key.blockId,
          text,
          !input.folded,
        )
      : {}
  // Empty semantic items still own logical offset zero. Native Markdown has no
  // child cell to discover, so anchor it to the mounted block root.
  if ("item" in input.block && textLength === 0 && !hidden && !activityLead)
    nativePoints[0] ??= {
      graphemeOffset: 0,
      x: input.renderable.screenX,
      y: input.renderable.screenY,
    }
  if (input.folded && !hidden) {
    if (!Object.keys(nativePoints).length)
      nativePoints[0] = {
        graphemeOffset: 0,
        x: input.renderable.screenX,
        y: input.renderable.screenY,
      }
    nativePoints = foldedPointFallback(textLength, nativePoints)
  }
  // Adjacent item sub-blocks share a logical boundary. Only the final block
  // owns the document-end cursor; a non-final block must not duplicate the
  // next block's first address or trap left/right motion at that boundary.
  if (
    "item" in input.block &&
    range.to < input.block.projection.sourceSpans.length
  )
    delete nativePoints[textLength]

  const points: Record<
    number,
    {
      graphemeOffset: number
      x: number
      y: number
      row: number
      column: number
      hidden?: boolean
    }
  > = {}
  for (const [offset, point] of Object.entries(nativePoints)) {
    const graphemeOffset = range.from + Number(offset)
    const x = Math.max(0, point.x - input.renderable.screenX)
    const y = Math.max(0, point.y - input.renderable.screenY)
    points[graphemeOffset] = {
      graphemeOffset,
      x,
      y,
      row: y,
      column: x,
      ...(point.hidden ? { hidden: true } : {}),
    }
  }
  const byRow = new Map<number, number[]>()
  for (const point of Object.values(points)) {
    const offsets = byRow.get(point.row)
    if (offsets) offsets.push(point.graphemeOffset)
    else byRow.set(point.row, [point.graphemeOffset])
  }
  const lines = [...byRow.entries()]
    .sort(([left], [right]) => left - right)
    .map(([row, offsets]) => ({
      from: Math.min(...offsets),
      to: Math.max(...offsets),
      row,
    }))
  const measured = freezeBlockGeometry({
    key,
    // Revisions are process-monotonic rather than renderable-local so a native
    // remount of the same logical block cannot look older than runtime cache.
    nativeRevision: nextNativeRevision++,
    rows: hidden
      ? 0
      : Math.max(
          1,
          input.renderable.height,
          ...lines.map((line) => line.row + 1),
        ),
    points,
    lines,
  })

  state.dirty = false
  dirtyStates.delete(state)
  if (
    state.geometry &&
    sameKey(state.geometry.key, key) &&
    sameGeometryShape(state.geometry, measured)
  )
    return state.geometry
  state.geometry = measured
  return measured
}
