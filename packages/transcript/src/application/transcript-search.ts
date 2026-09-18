import type { ItemId } from "@vimex/conversation"
import { graphemes } from "../domain/markdown-source-map"
import type { LogicalPoint, TranscriptState } from "../domain/transcript-document"
import type { LogicalRange, NavigationDirection } from "./transcript-navigation"

export interface TranscriptSearchMatch extends LogicalRange {
  readonly itemId: ItemId
  readonly text: string
}

export interface TranscriptSearchOptions {
  readonly caseSensitive?: boolean
}

function comparePoint(order: ReadonlyMap<ItemId, number>, left: LogicalPoint, right: LogicalPoint): number {
  const leftItem = order.get(left.itemId) ?? -1
  const rightItem = order.get(right.itemId) ?? -1
  return leftItem === rightItem ? left.graphemeOffset - right.graphemeOffset : leftItem - rightItem
}

/** Finds overlapping logical-grapheme matches without depending on rendered terminal cells. */
export function findSearchMatches(
  state: TranscriptState,
  query: string,
  options: TranscriptSearchOptions = {},
): readonly TranscriptSearchMatch[] {
  const caseSensitive = options.caseSensitive ?? false
  const needle = graphemes(query)
  const comparableNeedle = caseSensitive ? needle : needle.map(part => part.toLowerCase())
  if (needle.length === 0) return []
  const result: TranscriptSearchMatch[] = []
  for (const itemId of state.order) {
    const projection = state.projectionById[itemId]
    if (!projection) continue
    const parts = graphemes(projection.plain)
    const comparableParts = caseSensitive ? parts : parts.map(part => part.toLowerCase())
    for (let from = 0; from + needle.length <= parts.length; from++) {
      let matched = true
      for (let offset = 0; offset < needle.length; offset++) {
        if (comparableParts[from + offset] !== comparableNeedle[offset]) { matched = false; break }
      }
      if (!matched) continue
      const text = parts.slice(from, from + needle.length).join("")
      result.push({
        itemId,
        text,
        from: { itemId, graphemeOffset: from },
        to: { itemId, graphemeOffset: from + needle.length },
      })
    }
  }
  return result
}

/** Implements `/`, `?`, `n`, and `N` over a previously calculated match set. */
export function adjacentSearchMatch(
  state: TranscriptState,
  matches: readonly TranscriptSearchMatch[],
  direction: NavigationDirection,
  point = state.cursor,
  options: { readonly count?: number; readonly wrap?: boolean } = {},
): TranscriptSearchMatch | undefined {
  if (matches.length === 0) return undefined
  const count = Number.isFinite(options.count) ? Math.max(1, Math.trunc(options.count ?? 1)) : 1
  const order = new Map(state.order.map((id, index) => [id, index]))
  let index: number
  if (!point) {
    index = direction === "forward" ? -1 : matches.length
  } else if (direction === "forward") {
    let low = 0, high = matches.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (comparePoint(order, matches[middle]!.from, point) <= 0) low = middle + 1
      else high = middle
    }
    index = low - 1
  } else {
    let low = 0, high = matches.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (comparePoint(order, matches[middle]!.from, point) < 0) low = middle + 1
      else high = middle
    }
    index = low
  }
  index += direction === "forward" ? count : -count
  if (options.wrap ?? true) index = ((index % matches.length) + matches.length) % matches.length
  return matches[index]
}
