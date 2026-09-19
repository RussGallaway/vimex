import type { ItemId } from "@vimex/conversation"
import { graphemes } from "../domain/markdown-source-map"
import { transcriptOrderIndex, type LogicalPoint, type TranscriptSelection, type TranscriptState } from "../domain/transcript-document"
import { selectedText } from "./transcript-operations"
import { indexedUrlTarget, indexedUrlTargets, type IndexedUrlTarget, type TranscriptUrlIndexDiagnostics } from "./transcript-url-index"

export type NavigationDirection = "forward" | "backward"

/** A half-open logical range. */
export interface LogicalRange {
  readonly from: LogicalPoint
  readonly to: LogicalPoint
}

export interface SemanticBlock extends LogicalRange {
  readonly itemId: ItemId
}

export interface UrlCandidate extends LogicalRange {
  readonly itemId: ItemId
  readonly url: string
  readonly text: string
}

export type UrlCandidateScope = "all" | "current-item" | "selection"

function orderedPoint(state: TranscriptState, point: LogicalPoint): readonly [number, number] {
  return [transcriptOrderIndex(state.order).get(point.itemId) ?? -1, point.graphemeOffset]
}

function comparePoint(state: TranscriptState, left: LogicalPoint, right: LogicalPoint): number {
  const [leftItem, leftOffset] = orderedPoint(state, left)
  const [rightItem, rightOffset] = orderedPoint(state, right)
  return leftItem === rightItem ? leftOffset - rightOffset : leftItem - rightItem
}

function orderedSelection(state: TranscriptState, selection: TranscriptSelection): readonly [LogicalPoint, LogicalPoint] {
  return comparePoint(state, selection.anchor, selection.head) <= 0
    ? [selection.anchor, selection.head]
    : [selection.head, selection.anchor]
}

function semanticBlocksForItem(state: TranscriptState, itemId: ItemId): readonly SemanticBlock[] {
  const blocks: SemanticBlock[] = []
  const projection = state.projectionById[itemId]
  if (!projection) return blocks
  const parts = graphemes(projection.plain)
  let blockFrom: number | undefined
  let blockTo = 0
  let lineFrom = 0
  for (let cursor = 0; cursor <= parts.length; cursor++) {
    if (cursor < parts.length && parts[cursor] !== "\n") continue
    const nonBlank = parts.slice(lineFrom, cursor).some((part) => !/^\s$/u.test(part))
    if (nonBlank) {
      blockFrom ??= lineFrom
      blockTo = cursor
    } else if (blockFrom !== undefined) {
      blocks.push({
        itemId,
        from: { itemId, graphemeOffset: blockFrom },
        to: { itemId, graphemeOffset: blockTo },
      })
      blockFrom = undefined
    }
    lineFrom = cursor + 1
  }
  if (blockFrom !== undefined) {
    blocks.push({
      itemId,
      from: { itemId, graphemeOffset: blockFrom },
      to: { itemId, graphemeOffset: blockTo },
    })
  }
  return blocks
}

export function semanticBlocks(state: TranscriptState): readonly SemanticBlock[] {
  return state.order.flatMap(itemId => semanticBlocksForItem(state, itemId))
}

/** Resolve an adjacent semantic item without consulting mounted presentation state. */
export function adjacentTranscriptItem(
  state: TranscriptState,
  itemId: ItemId,
  direction: NavigationDirection,
): ItemId | undefined {
  const current = transcriptOrderIndex(state.order).get(itemId)
  if (current === undefined) return undefined
  const delta = direction === "forward" ? 1 : -1
  for (let index = current + delta; index >= 0 && index < state.order.length; index += delta) {
    const candidate = state.order[index]!
    if (state.projectionById[candidate]) return candidate
  }
  return undefined
}

export function transcriptBoundaryItem(state: TranscriptState, direction: NavigationDirection): ItemId | undefined {
  const start = direction === "forward" ? 0 : state.order.length - 1
  const delta = direction === "forward" ? 1 : -1
  for (let index = start; index >= 0 && index < state.order.length; index += delta) {
    const candidate = state.order[index]!
    if (state.projectionById[candidate]) return candidate
  }
  return undefined
}

export function currentSemanticBlock(state: TranscriptState, point = state.cursor): SemanticBlock | undefined {
  if (!point) return undefined
  const inItem = semanticBlocksForItem(state, point.itemId)
  return inItem.find((block) => point.graphemeOffset >= block.from.graphemeOffset && point.graphemeOffset < block.to.graphemeOffset)
    ?? inItem.findLast((block) => block.from.graphemeOffset <= point.graphemeOffset)
    ?? inItem[0]
}

/** Implements Vim's `^` against a logical source line, independent of terminal wrapping. */
export function firstContentPoint(state: TranscriptState, point = state.cursor): LogicalPoint | undefined {
  if (!point) return undefined
  const projection = state.projectionById[point.itemId]
  if (!projection) return undefined
  const parts = graphemes(projection.plain)
  let cursor = Math.min(Math.max(0, point.graphemeOffset), parts.length)
  while (cursor > 0 && parts[cursor - 1] !== "\n") cursor--
  while (cursor < parts.length && parts[cursor] !== "\n" && /^[ \t]$/u.test(parts[cursor]!)) cursor++
  return { itemId: point.itemId, graphemeOffset: cursor }
}

export function moveBySemanticBlock(
  state: TranscriptState,
  direction: NavigationDirection,
  point = state.cursor,
  count = 1,
): LogicalPoint | undefined {
  if (!point) return undefined
  const blockCache = new Map<ItemId, readonly SemanticBlock[]>()
  const blocksIn = (itemId: ItemId) => {
    const cached = blockCache.get(itemId)
    if (cached) return cached
    const blocks = semanticBlocksForItem(state, itemId)
    blockCache.set(itemId, blocks)
    return blocks
  }
  let target: SemanticBlock | undefined
  let origin = point
  const repeat = Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : 1
  for (let step = 0; step < repeat; step++) {
    const local = blocksIn(origin.itemId)
    target = direction === "forward"
      ? local.find(block => block.from.graphemeOffset > origin.graphemeOffset)
      : local.findLast(block => block.from.graphemeOffset < origin.graphemeOffset)
    let itemId = origin.itemId
    while (!target) {
      const adjacent = adjacentTranscriptItem(state, itemId, direction)
      if (!adjacent) break
      itemId = adjacent
      const candidates = blocksIn(itemId)
      target = direction === "forward" ? candidates[0] : candidates.at(-1)
    }
    if (!target) return step === 0 ? undefined : origin
    origin = target.from
  }
  return target?.from
}

export function moveByMessage(
  state: TranscriptState,
  direction: NavigationDirection,
  point = state.cursor,
  count = 1,
): LogicalPoint | undefined {
  if (!point) return undefined
  const currentOrder = transcriptOrderIndex(state.order).get(point.itemId)
  if (currentOrder === undefined) return undefined
  let remaining = Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : 1
  const delta = direction === "forward" ? 1 : -1
  for (let index = currentOrder + delta; index >= 0 && index < state.order.length; index += delta) {
    const itemId = state.order[index]!
    if (state.projectionById[itemId]?.nodeKind !== "message") continue
    if (--remaining === 0) return { itemId, graphemeOffset: 0 }
  }
  return undefined
}

function candidateInSelection(state: TranscriptState, candidate: UrlCandidate, selection: TranscriptSelection): boolean {
  const [start, end] = orderedSelection(state, selection)
  return comparePoint(state, candidate.to, start) > 0 && comparePoint(state, candidate.from, end) <= 0
}

/** Validate one picker candidate against its current semantic scope without enumerating unrelated URLs. */
export function urlCandidateInScope(state: TranscriptState, candidate: UrlCandidate, scope: "selection" | "current-item"): boolean {
  if (!transcriptOrderIndex(state.order).has(candidate.itemId)) return false
  const projection = state.projectionById[candidate.itemId]
  if (!projection?.links.some(link => link.from === candidate.from.graphemeOffset
    && link.to === candidate.to.graphemeOffset && link.url === candidate.url)) return false
  if (scope === "current-item") return state.cursor?.itemId === candidate.itemId
  return Boolean(state.selection && candidateInSelection(state, candidate, state.selection))
}

export function urlCandidates(state: TranscriptState, scope: UrlCandidateScope = "all"): readonly UrlCandidate[] {
  const selection = scope === "selection" && state.selection ? orderedSelection(state, state.selection) : undefined
  const targets: readonly IndexedUrlTarget[] = scope === "current-item"
    ? state.cursor && transcriptOrderIndex(state.order).has(state.cursor.itemId)
      ? (state.projectionById[state.cursor.itemId]?.links ?? []).map(link => ({ itemId: state.cursor!.itemId, link })) : []
    : indexedUrlTargets(state, selection ? { from: selection[0], to: selection[1] } : undefined)
  const partsByItem = new Map<ItemId, readonly string[]>()
  return targets.map(({ itemId, link }) => {
    const projection = state.projectionById[itemId]
    let parts = partsByItem.get(itemId)
    if (!parts) { parts = graphemes(projection?.plain ?? ""); partsByItem.set(itemId, parts) }
    return {
      itemId,
      url: link.url,
      text: parts.slice(link.from, link.to).join(""),
      from: { itemId, graphemeOffset: link.from },
      to: { itemId, graphemeOffset: link.to },
    }
  })
}

/** Exhaustive pass-through oracle retained for indexed candidate equivalence. */
export function urlCandidatesReference(state: TranscriptState, scope: UrlCandidateScope = "all"): readonly UrlCandidate[] {
  const result: UrlCandidate[] = []
  for (const itemId of state.order) {
    if (scope === "current-item" && itemId !== state.cursor?.itemId) continue
    const projection = state.projectionById[itemId]
    if (!projection) continue
    const parts = graphemes(projection.plain)
    for (const link of projection.links) {
      const candidate = {
        itemId, url: link.url, text: parts.slice(link.from, link.to).join(""),
        from: { itemId, graphemeOffset: link.from }, to: { itemId, graphemeOffset: link.to },
      }
      if (scope !== "selection" || (state.selection && candidateInSelection(state, candidate, state.selection))) result.push(candidate)
    }
  }
  return result
}

export function moveByUrl(
  state: TranscriptState,
  direction: NavigationDirection,
  point = state.cursor,
  options: { readonly count?: number; readonly wrap?: boolean } = {},
  diagnostics?: TranscriptUrlIndexDiagnostics,
): LogicalPoint | undefined {
  if (!point) return undefined
  const target = indexedUrlTarget(state, direction, point, options, diagnostics)
  return target ? { itemId: target.itemId, graphemeOffset: target.link.from } : undefined
}

/** Exhaustive pass-through oracle retained for indexed URL-motion equivalence tests. */
export function moveByUrlReference(
  state: TranscriptState,
  direction: NavigationDirection,
  point = state.cursor,
  options: { readonly count?: number; readonly wrap?: boolean } = {},
): LogicalPoint | undefined {
  if (!point) return undefined
  const candidates = urlCandidatesReference(state)
  if (!candidates.length) return undefined
  const containing = candidates.findIndex(candidate => comparePoint(state, candidate.from, point) <= 0 && comparePoint(state, candidate.to, point) > 0)
  let index = containing >= 0 ? containing : direction === "forward"
    ? (() => { const next = candidates.findIndex(candidate => comparePoint(state, candidate.from, point) > 0); return next < 0 ? candidates.length - 1 : next - 1 })()
    : candidates.findLastIndex(candidate => comparePoint(state, candidate.from, point) < 0) + 1
  const count = Number.isFinite(options.count) ? Math.max(1, Math.trunc(options.count ?? 1)) : 1
  index += direction === "forward" ? count : -count
  if (options.wrap) index = ((index % candidates.length) + candidates.length) % candidates.length
  return candidates[index]?.from
}

/** Text inserted by `r`: an active selection wins, otherwise the cursor's semantic block. */
export function referenceText(
  state: TranscriptState,
  format: "plain" | "source" = "plain",
): string | undefined {
  if (state.selection) return selectedText(state, format)
  const block = currentSemanticBlock(state)
  if (!block || block.to.graphemeOffset <= block.from.graphemeOffset) return undefined
  return selectedText({
    ...state,
    selection: {
      anchor: block.from,
      head: { itemId: block.itemId, graphemeOffset: block.to.graphemeOffset - 1 },
      shape: "character",
    },
  }, format)
}

/** Vim word motions over rendered graphemes; item boundaries act as whitespace. */
export function moveByWord(
  state: TranscriptState,
  motion: "next" | "previous" | "end",
  point = state.cursor,
  count = 1,
  bigWord = false,
): LogicalPoint | undefined {
  if (!point || !transcriptOrderIndex(state.order).has(point.itemId)) return undefined
  const category = (part: string): number => /^\s+$/u.test(part) ? 0 : bigWord || /^[\p{L}\p{M}\p{N}_]+$/u.test(part) ? 1 : 2
  const cache = new Map<ItemId, { from: LogicalPoint; end: LogicalPoint }[]>()
  const wordsIn = (itemId: ItemId) => {
    const cached = cache.get(itemId)
    if (cached) return cached
    const words: { from: LogicalPoint; end: LogicalPoint }[] = []
    const projection = state.projectionById[itemId]
    if (!projection) { cache.set(itemId, words); return words }
    const parts = graphemes(projection.plain)
    let offset = 0
    while (offset < parts.length) {
      const kind = category(parts[offset]!)
      if (kind === 0) { offset++; continue }
      const from = offset++
      while (offset < parts.length && category(parts[offset]!) === kind) offset++
      words.push({ from: { itemId, graphemeOffset: from }, end: { itemId, graphemeOffset: offset - 1 } })
    }
    cache.set(itemId, words)
    return words
  }
  const order = transcriptOrderIndex(state.order)
  const firstWord = () => {
    for (const itemId of state.order) { const word = wordsIn(itemId)[0]; if (word) return word }
  }
  const lastWord = () => {
    for (let index = state.order.length - 1; index >= 0; index--) { const word = wordsIn(state.order[index]!).at(-1); if (word) return word }
  }
  const candidate = (origin: LogicalPoint) => {
    const itemIndex = order.get(origin.itemId)!
    if (motion === "previous") {
      for (let index = itemIndex; index >= 0; index--) {
        const words = wordsIn(state.order[index]!)
        const word = index === itemIndex ? words.findLast(entry => entry.from.graphemeOffset < origin.graphemeOffset) : words.at(-1)
        if (word) return word.from
      }
      return firstWord()?.from
    }
    for (let index = itemIndex; index < state.order.length; index++) {
      const words = wordsIn(state.order[index]!)
      const word = index === itemIndex
        ? motion === "end"
          ? words.find(entry => entry.end.graphemeOffset > origin.graphemeOffset)
          : words.find(entry => entry.from.graphemeOffset > origin.graphemeOffset)
        : words[0]
      if (word) return motion === "end" ? word.end : word.from
    }
    return lastWord()?.end
  }
  let target = point
  const repeat = Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : 1
  for (let index = 0; index < repeat; index++) {
    const next = candidate(target)
    if (!next) return point
    if (comparePoint(state, next, target) === 0) break
    target = next
  }
  return target
}
