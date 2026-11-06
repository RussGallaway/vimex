import { TextBuffer, TextBufferView, type WidthMethod } from "@opentui/core"
import { graphemes } from "@vimex/transcript"

export interface PrepareTextLayoutInput {
  readonly text: string
  readonly width: number
  readonly widthMethod: WidthMethod
  readonly wrapMode: "none" | "word" | "char"
  readonly tabWidth?: number
  readonly firstLineOffset?: number
  readonly kind?: "plain" | "code"
  readonly conceal?: boolean
  readonly limits?: {
    readonly maxCodeUnits?: number
    readonly maxGraphemes?: number
    readonly maxRows?: number
  }
}
export interface PreparedTextPoint {
  readonly graphemeOffset: number
  readonly row: number
  readonly column: number
  readonly width: number
  readonly kind: "text" | "tab" | "newline" | "end"
  /** The complete grapheme span fits within the native row and viewport.
   * False does not assert that a partially clipped glyph paints no cells. */
  readonly visible: boolean
}
export interface PreparedTextRow {
  readonly row: number
  readonly sourceLine: number
  /** Native absolute display-column source offset, including newline units. */
  readonly startColumn: number
  readonly width: number
  /** Half-open canonical grapheme range, excluding the end sentinel. */
  readonly from: number
  readonly to: number
}
export interface PreparedTextLayout {
  readonly width: number
  readonly widthMethod: WidthMethod
  readonly wrapMode: PrepareTextLayoutInput["wrapMode"]
  readonly tabWidth: number
  readonly firstLineOffset: number
  readonly rowCount: number
  readonly graphemeCount: number
  readonly rows: readonly PreparedTextRow[]
  /** Canonical grapheme offsets plus the final insertion boundary. */
  readonly points: readonly PreparedTextPoint[]
}
export type PreparedTextResult =
  | { readonly status: "ready"; readonly layout: PreparedTextLayout }
  | { readonly status: "unsupported"; readonly reason: string }

const unsupported = (reason: string): PreparedTextResult => ({
  status: "unsupported",
  reason,
})
const positive = (value: number) => Number.isSafeInteger(value) && value > 0

/** Experimental native wrapping adapter. No renderables, Yoga, React, worker,
 * native cache or retained native resources; intentionally not wired to UI. */
export function prepareTextLayout(
  input: PrepareTextLayoutInput,
): PreparedTextResult {
  const { text, width, widthMethod, wrapMode } = input
  const tabWidth = input.tabWidth ?? 2
  const firstLineOffset = input.firstLineOffset ?? 0
  const maxCodeUnits = input.limits?.maxCodeUnits ?? 65_536
  const maxGraphemes = input.limits?.maxGraphemes ?? 16_384
  const maxRows = input.limits?.maxRows ?? 16_384
  if (![maxCodeUnits, maxGraphemes, maxRows].every(positive))
    return unsupported("invalid-limits")
  if (
    !positive(width) ||
    width > 65_536 ||
    !positive(tabWidth) ||
    tabWidth > 256 ||
    !Number.isSafeInteger(firstLineOffset) ||
    firstLineOffset < 0 ||
    firstLineOffset >= width
  )
    return unsupported("invalid-dimensions")
  if (
    !["wcwidth", "unicode", "unicode-wide"].includes(widthMethod) ||
    !["none", "word", "char"].includes(wrapMode)
  )
    return unsupported("unsupported-native-mode")
  if (
    input.conceal ||
    (input.kind !== undefined && !["plain", "code"].includes(input.kind))
  )
    return unsupported("transformed-content")
  if (text.length > maxCodeUnits) return unsupported("code-unit-limit")
  if (
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u.test(text) ||
    /\p{Cs}/u.test(text)
  )
    return unsupported("unsupported-control-or-surrogate")
  const parts = graphemes(text)
  if (parts.length > maxGraphemes) return unsupported("grapheme-limit")
  let buffer: TextBuffer | undefined
  let view: TextBufferView | undefined
  let widthsBuffer: TextBuffer | undefined
  let widthsView: TextBufferView | undefined
  try {
    buffer = TextBuffer.create(widthMethod)
    buffer.setTabWidth(tabWidth)
    buffer.setText(text)
    view = TextBufferView.create(buffer)
    view.setWrapMode(wrapMode)
    view.setWrapWidth(wrapMode === "none" ? null : width)
    view.setFirstLineOffset(firstLineOffset)
    const info = view.logicalLineInfo
    const count = info.lineSources.length
    if (count > maxRows) return unsupported("row-limit")
    if (
      !count ||
      info.lineStartCols.length !== count ||
      info.lineWidthCols.length !== count
    )
      return unsupported("invalid-native-lines")

    // Encoding glyphs is not a width oracle for TextBuffer's wcwidth mode.
    // Measure all canonical clusters in one native unwrapped auxiliary buffer.
    // Newline-separated clusters retain context within each grapheme and avoid
    // one FFI allocation/measurement per point. Tabs have native fixed width.
    const printable = parts.filter((part) => part !== "\n")
    let widths: readonly number[] = []
    if (printable.length) {
      widthsBuffer = TextBuffer.create(widthMethod)
      widthsBuffer.setTabWidth(tabWidth)
      widthsBuffer.setText(printable.join("\n"))
      widthsView = TextBufferView.create(widthsBuffer)
      widthsView.setWrapMode("none")
      widthsView.setWrapWidth(null)
      widths = widthsView.logicalLineInfo.lineWidthCols
      if (
        widths.length !== printable.length ||
        widths.some((value) => !positive(value))
      )
        return unsupported("unsupported-native-grapheme-width")
    }
    // Check cluster decomposition against the original text in the same native
    // engine. A context-sensitive disagreement is unsupported, never silently
    // converted into an allegedly exact source map.
    view.setWrapMode("none")
    view.setWrapWidth(null)
    const unwrapped = view.logicalLineInfo
    const sourceWidths = [0]
    let nativeWidthIndex = 0
    for (const part of parts) {
      if (part === "\n") sourceWidths.push(0)
      else sourceWidths[sourceWidths.length - 1]! += widths[nativeWidthIndex++]!
    }
    // Native soft-wrap starts must also respect canonical grapheme boundaries.
    // Equal total line widths alone cannot certify a split cluster's mapping.
    const boundaries = new Set<number>([0])
    let boundaryColumn = 0
    let boundaryWidthIndex = 0
    for (const part of parts) {
      boundaryColumn += part === "\n" ? 1 : widths[boundaryWidthIndex++]!
      boundaries.add(boundaryColumn)
    }
    if (info.lineStartCols.some((start) => !boundaries.has(start)))
      return unsupported("native-grapheme-wrap-mismatch")
    let nativeStart = 0
    if (unwrapped.lineSources.length !== sourceWidths.length)
      return unsupported("native-source-line-mismatch")
    for (let line = 0; line < sourceWidths.length; line++) {
      if (
        unwrapped.lineSources[line] !== line ||
        unwrapped.lineStartCols[line] !== nativeStart ||
        unwrapped.lineWidthCols[line] !== sourceWidths[line]
      )
        return unsupported("native-grapheme-context-mismatch")
      nativeStart += sourceWidths[line]! + 1
    }

    const rows = info.lineSources.map((sourceLine, row) => ({
      row,
      sourceLine,
      startColumn: info.lineStartCols[row]!,
      width: info.lineWidthCols[row]!,
      from: -1,
      to: -1,
    }))
    const bySource = new Map<number, number[]>()
    for (const row of rows) {
      if (
        !Number.isSafeInteger(row.startColumn) ||
        row.startColumn < 0 ||
        !Number.isSafeInteger(row.width) ||
        row.width < 0
      )
        return unsupported("invalid-native-lines")
      const list = bySource.get(row.sourceLine) ?? []
      list.push(row.row)
      bySource.set(row.sourceLine, list)
    }
    const points: PreparedTextPoint[] = []
    let sourceLine = 0,
      column = 0,
      widthIndex = 0,
      candidate = 0
    for (let offset = 0; offset <= parts.length; offset++) {
      const part = parts[offset]
      const visuals = bySource.get(sourceLine)
      if (!visuals?.length) return unsupported("missing-native-source-line")
      const base = rows[visuals[0]!]!.startColumn
      while (
        candidate + 1 < visuals.length &&
        rows[visuals[candidate + 1]!]!.startColumn - base <= column
      )
        candidate++
      const row = rows[visuals[candidate]!]!
      const cellColumn =
        column -
        (row.startColumn - base) +
        (row.row === 0 ? firstLineOffset : 0)
      const kind =
        part === undefined
          ? "end"
          : part === "\n"
            ? "newline"
            : part === "\t"
              ? "tab"
              : "text"
      const cellWidth =
        kind === "end" || kind === "newline" ? 0 : widths[widthIndex++]!
      points.push(
        Object.freeze({
          graphemeOffset: offset,
          row: row.row,
          column: cellColumn,
          width: cellWidth,
          kind,
          visible:
            kind !== "end" &&
            kind !== "newline" &&
            cellColumn >= 0 &&
            cellColumn + cellWidth <= width &&
            column - (row.startColumn - base) + cellWidth <= row.width,
        }),
      )
      if (part !== undefined) {
        if (row.from < 0) row.from = offset
        row.to = offset + 1
      }
      if (kind === "newline") {
        sourceLine++
        column = 0
        candidate = 0
      } else column += cellWidth
    }
    let boundary = 0
    for (const row of rows) {
      if (row.from < 0) row.from = row.to = boundary
      else boundary = row.to
      Object.freeze(row)
    }
    return Object.freeze({
      status: "ready",
      layout: Object.freeze({
        width,
        widthMethod,
        wrapMode,
        tabWidth,
        firstLineOffset,
        rowCount: count,
        graphemeCount: parts.length,
        rows: Object.freeze(rows),
        points: Object.freeze(points),
      }),
    })
  } finally {
    widthsView?.destroy()
    widthsBuffer?.destroy()
    view?.destroy()
    buffer?.destroy()
  }
}
