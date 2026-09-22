import type { ItemId } from "@vimex/conversation"
import {
  transcriptOrderIndex,
  type LinkTarget,
  type LogicalPoint,
  type TranscriptOrderIndexDiagnostics,
  type TranscriptState,
} from "../domain/transcript-document"

interface UrlCountNode {
  readonly count: number
  readonly left?: UrlCountNode
  readonly right?: UrlCountNode
}

interface TranscriptUrlIndex {
  readonly order: readonly ItemId[]
  readonly root?: UrlCountNode
  readonly size: number
  readonly capacity: number
}

export interface TranscriptUrlIndexDiagnostics {
  urlIndexBuilds: number
  urlIndexItemVisits: number
  urlIndexCacheHits: number
  urlIndexUpdates: number
  urlIndexNodeVisits: number
}

export interface IndexedUrlTarget {
  readonly itemId: ItemId
  readonly link: LinkTarget
}

function lowerBound(
  links: readonly LinkTarget[],
  offset: number,
  field: "from" | "to",
  inclusive: boolean,
): number {
  let low = 0,
    high = links.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const value = links[middle]![field]
    if (value < offset || (inclusive && value === offset)) low = middle + 1
    else high = middle
  }
  return low
}

const urlIndexes = new WeakMap<object, TranscriptUrlIndex>()

function node(
  count: number,
  left?: UrlCountNode,
  right?: UrlCountNode,
): UrlCountNode {
  return Object.freeze({
    count,
    ...(left ? { left } : {}),
    ...(right ? { right } : {}),
  })
}

function buildNode(
  counts: readonly number[],
  from: number,
  to: number,
): UrlCountNode | undefined {
  if (from >= counts.length || from >= to) return undefined
  if (to - from === 1) return node(counts[from] ?? 0)
  const middle = (from + to) >>> 1
  const left = buildNode(counts, from, middle)
  const right = buildNode(counts, middle, to)
  return node((left?.count ?? 0) + (right?.count ?? 0), left, right)
}

function buildIndex(
  state: TranscriptState,
  diagnostics?: TranscriptUrlIndexDiagnostics,
): TranscriptUrlIndex {
  if (diagnostics) diagnostics.urlIndexBuilds += 1
  let capacity = 1
  while (capacity < state.order.length) capacity *= 2
  const counts = state.order.map((itemId) => {
    if (diagnostics) diagnostics.urlIndexItemVisits += 1
    return state.projectionById[itemId]?.links.length ?? 0
  })
  return Object.freeze({
    order: state.order,
    root: buildNode(counts, 0, capacity),
    size: counts.length,
    capacity,
  })
}

function indexFor(
  state: TranscriptState,
  diagnostics?: TranscriptUrlIndexDiagnostics,
): TranscriptUrlIndex {
  const cached = urlIndexes.get(state.projectionById)
  if (cached?.order === state.order) {
    if (diagnostics) diagnostics.urlIndexCacheHits += 1
    return cached
  }
  const built = buildIndex(state, diagnostics)
  urlIndexes.set(state.projectionById, built)
  return built
}

/** Prime a restored or directly constructed semantic snapshot outside input handling. */
export function primeTranscriptUrlIndex(
  state: TranscriptState,
  diagnostics?: TranscriptUrlIndexDiagnostics,
): void {
  indexFor(state, diagnostics)
}

function updateNode(
  current: UrlCountNode | undefined,
  from: number,
  to: number,
  index: number,
  count: number,
  diagnostics?: TranscriptUrlIndexDiagnostics,
): UrlCountNode {
  if (diagnostics) diagnostics.urlIndexNodeVisits += 1
  if (to - from === 1) return node(count)
  const middle = (from + to) >>> 1
  const left =
    index < middle
      ? updateNode(current?.left, from, middle, index, count, diagnostics)
      : current?.left
  const right =
    index >= middle
      ? updateNode(current?.right, middle, to, index, count, diagnostics)
      : current?.right
  return node((left?.count ?? 0) + (right?.count ?? 0), left, right)
}

function prefix(
  nodeValue: UrlCountNode | undefined,
  from: number,
  to: number,
  end: number,
  diagnostics?: TranscriptUrlIndexDiagnostics,
): number {
  if (!nodeValue || end <= from) return 0
  if (diagnostics) diagnostics.urlIndexNodeVisits += 1
  if (to <= end) return nodeValue.count
  const middle = (from + to) >>> 1
  return (
    prefix(nodeValue.left, from, middle, end, diagnostics) +
    prefix(nodeValue.right, middle, to, end, diagnostics)
  )
}

function itemAtOrdinal(
  nodeValue: UrlCountNode | undefined,
  from: number,
  to: number,
  ordinal: number,
  diagnostics?: TranscriptUrlIndexDiagnostics,
): number | undefined {
  if (!nodeValue || ordinal < 0 || ordinal >= nodeValue.count) return undefined
  if (diagnostics) diagnostics.urlIndexNodeVisits += 1
  if (to - from === 1) return from
  const middle = (from + to) >>> 1
  const leftCount = nodeValue.left?.count ?? 0
  return ordinal < leftCount
    ? itemAtOrdinal(nodeValue.left, from, middle, ordinal, diagnostics)
    : itemAtOrdinal(
        nodeValue.right,
        middle,
        to,
        ordinal - leftCount,
        diagnostics,
      )
}

/** Inherit the disposable URL-count index through one semantic projection update. */
export function inheritTranscriptUrlIndex(
  previous: TranscriptState,
  next: TranscriptState,
  changedItemId: ItemId,
  appended: boolean,
  diagnostics?: TranscriptUrlIndexDiagnostics & TranscriptOrderIndexDiagnostics,
): void {
  const prior = indexFor(previous, diagnostics)
  let root = prior.root
  let capacity = prior.capacity
  const position = appended
    ? prior.size
    : transcriptOrderIndex(previous.order, diagnostics).get(changedItemId)
  if (position === undefined) return
  if (appended && prior.size === capacity) {
    root = node(root?.count ?? 0, root)
    capacity *= 2
  }
  root = updateNode(
    root,
    0,
    capacity,
    position,
    next.projectionById[changedItemId]?.links.length ?? 0,
    diagnostics,
  )
  if (diagnostics) diagnostics.urlIndexUpdates += 1
  urlIndexes.set(
    next.projectionById,
    Object.freeze({
      order: next.order,
      root,
      size: next.order.length,
      capacity,
    }),
  )
}

/** Inherit the URL-count index through bounded existing-item changes. */
export function inheritTranscriptUrlIndexChanges(
  previous: TranscriptState,
  next: TranscriptState,
  changedItemIds: readonly ItemId[],
  diagnostics?: TranscriptUrlIndexDiagnostics,
): void {
  const prior = indexFor(previous, diagnostics)
  if (
    previous.order !== next.order &&
    (previous.order.length !== next.order.length ||
      previous.order.some(
        (itemId, position) => next.order[position] !== itemId,
      ))
  )
    return
  const order = transcriptOrderIndex(previous.order)
  let root = prior.root
  for (const itemId of new Set(changedItemIds)) {
    const position = order.get(itemId)
    if (position === undefined) continue
    root = updateNode(
      root,
      0,
      prior.capacity,
      position,
      next.projectionById[itemId]?.links.length ?? 0,
    )
    if (diagnostics) diagnostics.urlIndexUpdates += 1
  }
  urlIndexes.set(
    next.projectionById,
    Object.freeze({
      order: next.order,
      root,
      size: next.order.length,
      capacity: prior.capacity,
    }),
  )
}

/** Resolve counted URL motion without enumerating candidates from unrelated items. */
export function indexedUrlTarget(
  state: TranscriptState,
  direction: "forward" | "backward",
  point: LogicalPoint,
  options: { readonly count?: number; readonly wrap?: boolean } = {},
  diagnostics?: TranscriptUrlIndexDiagnostics,
): IndexedUrlTarget | undefined {
  const index = indexFor(state, diagnostics)
  const itemPosition = transcriptOrderIndex(state.order).get(point.itemId)
  const projection = state.projectionById[point.itemId]
  const total = index.root?.count ?? 0
  if (itemPosition === undefined || !projection || total === 0) return undefined
  const before = prefix(
    index.root,
    0,
    index.capacity,
    itemPosition,
    diagnostics,
  )
  const insertion = lowerBound(
    projection.links,
    point.graphemeOffset,
    "from",
    true,
  )
  const preceding = insertion - 1
  const containing =
    preceding >= 0 && point.graphemeOffset < projection.links[preceding]!.to
      ? preceding
      : -1
  let base: number
  if (containing >= 0) base = before + containing
  else if (direction === "forward") {
    base = before + insertion - 1
  } else {
    const previous =
      lowerBound(projection.links, point.graphemeOffset, "from", false) - 1
    base = before + previous + 1
  }
  const count = Number.isFinite(options.count)
    ? Math.max(1, Math.trunc(options.count ?? 1))
    : 1
  let ordinal = base + (direction === "forward" ? count : -count)
  if (options.wrap) ordinal = ((ordinal % total) + total) % total
  if (ordinal < 0 || ordinal >= total) return undefined
  const targetPosition = itemAtOrdinal(
    index.root,
    0,
    index.capacity,
    ordinal,
    diagnostics,
  )
  if (targetPosition === undefined) return undefined
  const itemId = state.order[targetPosition]
  if (!itemId) return undefined
  const localOrdinal =
    ordinal - prefix(index.root, 0, index.capacity, targetPosition, diagnostics)
  const link = state.projectionById[itemId]?.links[localOrdinal]
  return link ? { itemId, link } : undefined
}

/** Enumerate only URL targets intersecting the requested logical range. */
export function indexedUrlTargets(
  state: TranscriptState,
  range?: Readonly<{ from: LogicalPoint; to: LogicalPoint }>,
  diagnostics?: TranscriptUrlIndexDiagnostics,
): readonly IndexedUrlTarget[] {
  const index = indexFor(state, diagnostics)
  const total = index.root?.count ?? 0
  if (!total) return []
  let fromOrdinal = 0,
    toOrdinal = total
  if (range) {
    const order = transcriptOrderIndex(state.order)
    const fromItem = order.get(range.from.itemId),
      toItem = order.get(range.to.itemId)
    if (fromItem === undefined || toItem === undefined || fromItem > toItem)
      return []
    const fromLinks = state.projectionById[range.from.itemId]?.links ?? []
    const toLinks = state.projectionById[range.to.itemId]?.links ?? []
    fromOrdinal =
      prefix(index.root, 0, index.capacity, fromItem, diagnostics) +
      lowerBound(fromLinks, range.from.graphemeOffset, "to", true)
    toOrdinal =
      prefix(index.root, 0, index.capacity, toItem, diagnostics) +
      lowerBound(toLinks, range.to.graphemeOffset, "from", true)
  }
  const result: IndexedUrlTarget[] = []
  for (let ordinal = fromOrdinal; ordinal < toOrdinal; ordinal++) {
    const itemPosition = itemAtOrdinal(
      index.root,
      0,
      index.capacity,
      ordinal,
      diagnostics,
    )
    if (itemPosition === undefined) break
    const itemId = state.order[itemPosition]
    if (!itemId) continue
    const local =
      ordinal - prefix(index.root, 0, index.capacity, itemPosition, diagnostics)
    const link = state.projectionById[itemId]?.links[local]
    if (link) result.push({ itemId, link })
  }
  return result
}
