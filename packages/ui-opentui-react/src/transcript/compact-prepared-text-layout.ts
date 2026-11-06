import {
  prepareTextLayout,
  type PrepareTextLayoutInput,
  type PreparedTextLayout,
  type PreparedTextPoint,
  type PreparedTextRow,
} from "./prepared-text-layout"

type LayoutMetadata = Pick<
  PreparedTextLayout,
  | "width"
  | "widthMethod"
  | "wrapMode"
  | "tabWidth"
  | "firstLineOffset"
  | "rowCount"
  | "graphemeCount"
>

export interface CompactPreparedTextLayout extends LayoutMetadata {
  readonly runCount: number
  /** Exact retained typed-array bytes, excluding JS object/runtime overhead.
   * No source text, native resources, or verbose points are retained. */
  readonly payloadBytes: number
  /** Constant-time row lookup. Invalid/noninteger indices return undefined. */
  row(index: number): PreparedTextRow | undefined
  /** Binary-search lookup, including the EOF insertion point. */
  point(graphemeOffset: number): PreparedTextPoint | undefined
}

export type CompactPreparedTextResult =
  | { readonly status: "ready"; readonly layout: CompactPreparedTextLayout }
  | { readonly status: "unsupported"; readonly reason: string }

const kinds = ["text", "tab", "newline", "end"] as const
const stride = 5

// Keep this factory separate from compaction: retained closures cannot capture
// the original layout or the temporary growing arrays used to encode it.
function createLayout(
  metadata: LayoutMetadata,
  rows: Float64Array,
  runs: Float64Array,
): CompactPreparedTextLayout {
  const runCount = runs.length / stride
  return Object.freeze({
    ...metadata,
    runCount,
    payloadBytes: rows.byteLength + runs.byteLength,
    row(index: number): PreparedTextRow | undefined {
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= metadata.rowCount
      )
        return undefined
      const start = index * stride
      return Object.freeze({
        row: index,
        sourceLine: rows[start]!,
        startColumn: rows[start + 1]!,
        width: rows[start + 2]!,
        from: rows[start + 3]!,
        to: rows[start + 4]!,
      })
    },
    point(graphemeOffset: number): PreparedTextPoint | undefined {
      if (
        !Number.isSafeInteger(graphemeOffset) ||
        graphemeOffset < 0 ||
        graphemeOffset > metadata.graphemeCount
      )
        return undefined
      let low = 0
      let high = runCount
      while (low + 1 < high) {
        const middle = low + Math.floor((high - low) / 2)
        if (runs[middle * stride]! <= graphemeOffset) low = middle
        else high = middle
      }
      const start = low * stride
      const width = runs[start + 3]!
      const flags = runs[start + 4]!
      return Object.freeze({
        graphemeOffset,
        row: runs[start + 1]!,
        column: runs[start + 2]! + (graphemeOffset - runs[start]!) * width,
        width,
        kind: kinds[flags >> 1]!,
        visible: (flags & 1) === 1,
      })
    },
  })
}

/** Lossless storage adapter for layouts returned by prepareTextLayout.
 * Same-width sequential points share a run only within the same visual row,
 * kind, and visibility. Irregular text can still require one run per point.
 * Float64 records preserve the producer's safe-integer offsets without uint32
 * truncation if callers raise its input limits. Arrays never escape this API. */
export function compactPreparedTextLayout(
  layout: PreparedTextLayout,
): CompactPreparedTextLayout {
  const rows = new Float64Array(layout.rowCount * stride)
  for (const row of layout.rows)
    rows.set(
      [row.sourceLine, row.startColumn, row.width, row.from, row.to],
      row.row * stride,
    )
  const encoded: number[] = []
  let previous: PreparedTextPoint | undefined
  for (const point of layout.points) {
    if (
      !previous ||
      point.graphemeOffset !== previous.graphemeOffset + 1 ||
      point.row !== previous.row ||
      point.column !== previous.column + previous.width ||
      point.width !== previous.width ||
      point.kind !== previous.kind ||
      point.visible !== previous.visible
    )
      encoded.push(
        point.graphemeOffset,
        point.row,
        point.column,
        point.width,
        kinds.indexOf(point.kind) * 2 + Number(point.visible),
      )
    previous = point
  }
  return createLayout(
    {
      width: layout.width,
      widthMethod: layout.widthMethod,
      wrapMode: layout.wrapMode,
      tabWidth: layout.tabWidth,
      firstLineOffset: layout.firstLineOffset,
      rowCount: layout.rowCount,
      graphemeCount: layout.graphemeCount,
    },
    rows,
    Float64Array.from(encoded),
  )
}

/** Standalone prototype: reduces retained data, not native preparation work.
 * The verbose producer and compaction allocations still exist transiently. */
export function prepareCompactTextLayout(
  input: PrepareTextLayoutInput,
): CompactPreparedTextResult {
  const result = prepareTextLayout(input)
  if (result.status === "unsupported") return result
  return Object.freeze({
    status: "ready",
    layout: compactPreparedTextLayout(result.layout),
  })
}
