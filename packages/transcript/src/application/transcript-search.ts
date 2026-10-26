import type { ItemId } from "@vimex/conversation"
import { graphemes } from "../domain/markdown-source-map"
import {
  transcriptOrderIndex,
  type LogicalPoint,
  type TranscriptState,
} from "../domain/transcript-document"
import type { LogicalRange, NavigationDirection } from "./transcript-navigation"

export interface TranscriptSearchMatch extends LogicalRange {
  readonly itemId: ItemId
  readonly text: string
}

export interface TranscriptSearchOptions {
  readonly caseSensitive?: boolean
}

interface SearchCacheEntry {
  readonly projections: WeakRef<TranscriptState["projectionById"]>
  readonly order: WeakRef<TranscriptState["order"]>
  readonly query: string
  readonly caseSensitive: boolean
  readonly matches: readonly TranscriptSearchMatch[]
}

// Keep recent pane/query results without retaining their conversation histories.
// Cursor, selection, folds, and viewport changes do not change these inputs.
const searchCache: SearchCacheEntry[] = []
const searchCacheLimit = 4
const retainedMatchLimit = 10_000
const retainedTextLimit = 1_000_000

function comparePoint(
  order: ReadonlyMap<ItemId, number>,
  left: LogicalPoint,
  right: LogicalPoint,
): number {
  const leftItem = order.get(left.itemId) ?? -1
  const rightItem = order.get(right.itemId) ?? -1
  return leftItem === rightItem
    ? left.graphemeOffset - right.graphemeOffset
    : leftItem - rightItem
}

/** Finds overlapping logical-grapheme matches without depending on rendered terminal cells. */
export function findSearchMatches(
  state: TranscriptState,
  query: string,
  options: TranscriptSearchOptions = {},
): readonly TranscriptSearchMatch[] {
  const caseSensitive = options.caseSensitive ?? false
  for (let index = searchCache.length - 1; index >= 0; index--) {
    const entry = searchCache[index]!
    if (!entry.projections.deref() || !entry.order.deref())
      searchCache.splice(index, 1)
  }
  const cachedIndex = searchCache.findIndex(
    (entry) =>
      entry.projections.deref() === state.projectionById &&
      entry.order.deref() === state.order &&
      entry.query === query &&
      entry.caseSensitive === caseSensitive,
  )
  if (cachedIndex >= 0) {
    const entry = searchCache.splice(cachedIndex, 1)[0]!
    searchCache.push(entry)
    return entry.matches
  }
  const needle = graphemes(query)
  const comparableNeedle = caseSensitive
    ? needle
    : needle.map((part) => part.toLowerCase())
  if (needle.length === 0) return []
  const result: TranscriptSearchMatch[] = []
  let retainedTextLength = query.length
  for (const itemId of state.order) {
    const projection = state.projectionById[itemId]
    if (!projection) continue
    const parts = graphemes(projection.plain)
    const comparableParts = caseSensitive
      ? parts
      : parts.map((part) => part.toLowerCase())
    for (let from = 0; from + needle.length <= parts.length; from++) {
      let matched = true
      for (let offset = 0; offset < needle.length; offset++) {
        if (comparableParts[from + offset] !== comparableNeedle[offset]) {
          matched = false
          break
        }
      }
      if (!matched) continue
      const text = parts.slice(from, from + needle.length).join("")
      retainedTextLength += text.length
      result.push(
        Object.freeze({
          itemId,
          text,
          from: Object.freeze({ itemId, graphemeOffset: from }),
          to: Object.freeze({ itemId, graphemeOffset: from + needle.length }),
        }),
      )
    }
  }
  const matches = Object.freeze(result)
  // Dense or unusually long matches remain complete but disposable. A query
  // count alone would allow the cache to retain an unbounded amount of text.
  if (
    matches.length > retainedMatchLimit ||
    retainedTextLength > retainedTextLimit
  )
    return matches
  searchCache.push({
    projections: new WeakRef(state.projectionById),
    order: new WeakRef(state.order),
    query,
    caseSensitive,
    matches,
  })
  if (searchCache.length > searchCacheLimit) searchCache.shift()
  return matches
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
  const count = Number.isFinite(options.count)
    ? Math.max(1, Math.trunc(options.count ?? 1))
    : 1
  const order = transcriptOrderIndex(state.order)
  let index: number
  if (!point) {
    index = direction === "forward" ? -1 : matches.length
  } else if (direction === "forward") {
    let low = 0,
      high = matches.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (comparePoint(order, matches[middle]!.from, point) <= 0)
        low = middle + 1
      else high = middle
    }
    index = low - 1
  } else {
    let low = 0,
      high = matches.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (comparePoint(order, matches[middle]!.from, point) < 0)
        low = middle + 1
      else high = middle
    }
    index = low
  }
  index += direction === "forward" ? count : -count
  if (options.wrap ?? true)
    index = ((index % matches.length) + matches.length) % matches.length
  return matches[index]
}
