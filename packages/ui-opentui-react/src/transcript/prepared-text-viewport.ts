import { graphemes } from "@vimex/transcript"
import type { CompactPreparedTextLayout } from "./compact-prepared-text-layout"

export interface PreparedViewportRow {
  readonly row: number
  /** Already wrapped visible text. Paint with wrapMode="none" at layout.width. */
  readonly text: string
}
export interface PreparedTextViewport {
  readonly width: number
  readonly rowCount: number
  /** Additional typed-array payload, excluding the shared compact layout. */
  readonly sourceIndexBytes: number
  /** This object retains a canonical string reference; account it if cached. */
  readonly sourceCodeUnits: number
  rows(start: number, count: number): readonly PreparedViewportRow[]
}
export type PreparedViewportResult =
  | { readonly status: "ready"; readonly viewport: PreparedTextViewport }
  | { readonly status: "unsupported"; readonly reason: string }

// Separate factory avoids retaining the temporary segmented source array.
function createViewport(
  text: string,
  layout: CompactPreparedTextLayout,
  sourceOffsets: Float64Array,
): PreparedTextViewport {
  return Object.freeze({
    width: layout.width,
    rowCount: layout.rowCount,
    sourceIndexBytes: sourceOffsets.byteLength,
    sourceCodeUnits: text.length,
    rows(start: number, count: number) {
      if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        !Number.isSafeInteger(count) ||
        count < 0
      )
        throw new Error("Invalid prepared viewport range")
      const result: PreparedViewportRow[] = []
      for (
        let rowIndex = start;
        rowIndex < Math.min(layout.rowCount, start + count);
        rowIndex++
      ) {
        const row = layout.row(rowIndex)!
        let column = 0
        let visible = ""
        for (let offset = row.from; offset < row.to; offset++) {
          const point = layout.point(offset)!
          if (point.kind === "newline" || point.kind === "end") continue
          if (point.column >= layout.width) break
          if (!point.visible) continue // Native consumed wrap separators/clipped cells.
          visible += " ".repeat(point.column - column)
          visible += text.slice(
            sourceOffsets[offset],
            sourceOffsets[offset + 1],
          )
          column = point.column + point.width
        }
        result.push(Object.freeze({ row: rowIndex, text: visible }))
      }
      return Object.freeze(result)
    },
  })
}

/** Standalone plain/unconcealed-code painter preparation. Content and layout
 * must share identity; this is not a source revision validator. It indexes
 * graphemes once, then reads only requested rows without native layout work.
 * No control strings, tabs, first-line indent, or partial wide-cell clipping.
 */
export function prepareTextViewport(
  text: string,
  layout: CompactPreparedTextLayout,
): PreparedViewportResult {
  if (layout.firstLineOffset !== 0)
    return { status: "unsupported", reason: "first-line-offset-policy" }
  if (text.includes("\t"))
    return { status: "unsupported", reason: "tab-paint-policy" }
  const parts = graphemes(text)
  if (parts.length !== layout.graphemeCount)
    return { status: "unsupported", reason: "source-length-mismatch" }
  const offsets = new Float64Array(parts.length + 1)
  let sourceOffset = 0
  for (let index = 0; index < parts.length; index++) {
    offsets[index] = sourceOffset
    sourceOffset += parts[index]!.length
    const point = layout.point(index)!
    const row = layout.row(point.row)!
    const edge = Math.min(layout.width, row.width)
    if (
      point.width > 0 &&
      point.column < edge &&
      point.column + point.width > edge
    )
      return { status: "unsupported", reason: "partial-cell-clipping" }
  }
  offsets[parts.length] = sourceOffset
  return Object.freeze({
    status: "ready",
    viewport: createViewport(text, layout, offsets),
  })
}
