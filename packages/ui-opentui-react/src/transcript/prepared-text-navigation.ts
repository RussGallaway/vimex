import { graphemes } from "@vimex/transcript"
import { graphemeCellWidth } from "./layout"
import type { PreparedTextPoint } from "./prepared-text-layout"

/** Same-source, single unconcealed Text/Code root, with no padding or height
 * clipping. The caller owns the content/layout identity contract. */
export interface PreparedNavigationSource {
  readonly width: number
  readonly rowCount: number
  readonly graphemeCount: number
  readonly firstLineOffset: number
  pointAt(offset: number): PreparedTextPoint | undefined
}
export interface PreparedNavigationPoint {
  readonly graphemeOffset: number
  readonly row: number
  readonly column: number
}
export interface PreparedTextNavigation {
  readonly rowCount: number
  readonly graphemeCount: number
  /** Additional numeric boundary payload; excludes the shared source layout,
   * JS objects, closures and temporary preparation allocations. */
  readonly boundaryPayloadBytes: number
  pointAt(offset: number): PreparedNavigationPoint | undefined
}
export type PreparedNavigationResult =
  | { readonly status: "ready"; readonly navigation: PreparedTextNavigation }
  | { readonly status: "unsupported"; readonly reason: string }

/** Compatibility experiment for the existing measureRaw/fillPointGaps policy.
 * This deliberately preserves insertion/clamping semantics rather than
 * substituting native insertion boundaries for current cursor addresses.
 * Not a BlockGeometry publisher or a certification of selection painting. */
export function prepareTextNavigation(
  text: string,
  layout: PreparedNavigationSource,
): PreparedNavigationResult {
  const unsupported = (reason: string): PreparedNavigationResult => ({
    status: "unsupported",
    reason,
  })
  if (layout.firstLineOffset !== 0)
    return unsupported("first-line-offset-policy")
  const parts = graphemes(text)
  if (parts.length !== layout.graphemeCount)
    return unsupported("source-length-mismatch")
  const cells: PreparedNavigationPoint[] = []
  for (let offset = 0; offset < parts.length; offset++) {
    const point = layout.pointAt(offset)
    if (!point) return unsupported("missing-source-point")
    const part = parts[offset]!
    if (part === "\n") {
      if (point.kind !== "newline") return unsupported("source-kind-mismatch")
      continue
    }
    if (point.kind !== (part === "\t" ? "tab" : "text"))
      return unsupported("source-kind-mismatch")
    // cellsIn currently advances by Bun.stringWidth. Refuse disagreements
    // instead of quietly moving legacy cursor/selection coordinates.
    if (point.width !== graphemeCellWidth(part))
      return unsupported("legacy-cell-width-mismatch")
    cells.push({
      graphemeOffset: offset,
      row: point.row,
      column: Math.max(0, Math.min(point.column, layout.width - 1)),
    })
  }
  const known = new Map<number, PreparedNavigationPoint>()
  let cursor = 0
  let last: PreparedNavigationPoint | undefined
  for (
    let offset = 0;
    offset < parts.length && cursor < cells.length;
    offset++
  ) {
    if (parts[offset] === "\n") {
      // Upper bound by row, starting at the next unconsumed source cell.
      let low = cursor,
        high = cells.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (last && cells[middle]!.row <= last.row) low = middle + 1
        else high = middle
      }
      const next = cells[low]
      if (next) {
        known.set(offset, { ...next, graphemeOffset: offset })
        last = next
      }
    } else {
      last = cells[cursor++]!
      known.set(offset, last)
    }
  }
  if (last)
    known.set(parts.length, {
      graphemeOffset: parts.length,
      row: last.row,
      column: last.column + 1,
    })
  else if (parts.length === 0)
    known.set(0, { graphemeOffset: 0, row: 0, column: 0 })

  // Only newline/EOF exceptions survive preparation. Other addresses are
  // looked up from shared compact source data and clamped on demand.
  const offsets = [...known.keys()].sort((a, b) => a - b)
  const boundaries: PreparedNavigationPoint[] = []
  let nextIndex = 0
  for (let offset = 0; offset <= parts.length; offset++) {
    if (offset < parts.length && parts[offset] !== "\n") continue
    let point = known.get(offset)
    if (!point) {
      while (nextIndex < offsets.length && offsets[nextIndex]! < offset)
        nextIndex++
      const previousOffset = offsets[nextIndex - 1]
      const nextOffset = offsets[nextIndex]
      const previous =
        previousOffset === undefined ? undefined : known.get(previousOffset)
      const next = nextOffset === undefined ? undefined : known.get(nextOffset)
      let basis = previous ?? next
      if (previous && next) {
        if (previous.row === next.row) {
          const ratio =
            (offset - previousOffset!) / (nextOffset! - previousOffset!)
          point = {
            graphemeOffset: offset,
            row: previous.row,
            column: Math.round(
              previous.column + (next.column - previous.column) * ratio,
            ),
          }
        } else
          basis =
            offset - previousOffset! <= nextOffset! - offset ? previous : next
      }
      point ??= basis ? { ...basis, graphemeOffset: offset } : undefined
    }
    if (point) boundaries.push(point)
  }
  const boundaryData = new Float64Array(boundaries.length * 3)
  boundaries.forEach((point, index) => {
    boundaryData.set([point.graphemeOffset, point.row, point.column], index * 3)
  })
  return Object.freeze({
    status: "ready",
    navigation: createNavigation(layout, boundaryData),
  })
}

// Separate closure scope: retain only the shared source and compact exceptions,
// never source text or preparation's temporary cells/points/maps.
function createNavigation(
  layout: PreparedNavigationSource,
  boundaryData: Float64Array,
): PreparedTextNavigation {
  const pointAt = (offset: number): PreparedNavigationPoint | undefined => {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > layout.graphemeCount
    )
      return undefined
    const point = layout.pointAt(offset)
    if (!point) return undefined
    if (point.kind !== "newline" && point.kind !== "end")
      return Object.freeze({
        graphemeOffset: offset,
        row: point.row,
        column: Math.max(0, Math.min(point.column, layout.width - 1)),
      })
    let low = 0,
      high = boundaryData.length / 3
    while (low < high) {
      const middle = (low + high) >>> 1
      if (boundaryData[middle * 3]! < offset) low = middle + 1
      else high = middle
    }
    if (boundaryData[low * 3] !== offset) return undefined
    return Object.freeze({
      graphemeOffset: offset,
      row: boundaryData[low * 3 + 1]!,
      column: boundaryData[low * 3 + 2]!,
    })
  }
  return Object.freeze({
    rowCount: layout.rowCount,
    graphemeCount: layout.graphemeCount,
    boundaryPayloadBytes: boundaryData.byteLength,
    pointAt,
  })
}
