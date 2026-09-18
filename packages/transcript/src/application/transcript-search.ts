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

function comparePoint(state: TranscriptState, left: LogicalPoint, right: LogicalPoint): number {
  const leftItem = state.order.indexOf(left.itemId)
  const rightItem = state.order.indexOf(right.itemId)
  return leftItem === rightItem ? left.graphemeOffset - right.graphemeOffset : leftItem - rightItem
}

function matches(candidate: string, query: string, caseSensitive: boolean): boolean {
  return caseSensitive ? candidate === query : candidate.toLowerCase() === query.toLowerCase()
}

/** Finds overlapping logical-grapheme matches without depending on rendered terminal cells. */
export function findSearchMatches(
  state: TranscriptState,
  query: string,
  options: TranscriptSearchOptions = {},
): readonly TranscriptSearchMatch[] {
  const needle = graphemes(query)
  if (needle.length === 0) return []
  const result: TranscriptSearchMatch[] = []
  for (const itemId of state.order) {
    const projection = state.projectionById[itemId]
    if (!projection) continue
    const parts = graphemes(projection.plain)
    for (let from = 0; from + needle.length <= parts.length; from++) {
      const text = parts.slice(from, from + needle.length).join("")
      if (!matches(text, query, options.caseSensitive ?? false)) continue
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
  const count = Math.max(1, options.count ?? 1)
  let index: number
  if (!point) {
    index = direction === "forward" ? -1 : matches.length
  } else if (direction === "forward") {
    const next = matches.findIndex((match) => comparePoint(state, match.from, point) > 0)
    index = next < 0 ? matches.length - 1 : next - 1
  } else {
    index = matches.findLastIndex((match) => comparePoint(state, match.from, point) < 0) + 1
  }
  index += direction === "forward" ? count : -count
  if (options.wrap ?? true) index = ((index % matches.length) + matches.length) % matches.length
  return matches[index]
}
