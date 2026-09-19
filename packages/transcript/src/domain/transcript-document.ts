import type { ItemId } from "@vimex/conversation"

export interface LinkTarget { readonly from: number; readonly to: number; readonly url: string }
export interface SourceSpan { readonly from: number; readonly to: number }
export interface TextProjection {
  /** Semantic node class used by message-wise navigation. */
  readonly nodeKind?: "message" | "reasoning" | "tool" | "edit" | "unknown"
  readonly plain: string
  readonly source: string
  /** One exact source span for each rendered grapheme. */
  readonly sourceSpans: readonly SourceSpan[]
  readonly links: readonly LinkTarget[]
  /** Syntax envelopes included when their entire rendered content is selected. */
  readonly sourceRegions?: readonly { readonly from: number; readonly to: number; readonly sourceFrom: number; readonly sourceTo: number }[]
  readonly revision: number
}
export interface LogicalPoint { itemId: ItemId; graphemeOffset: number }
export interface JumpLocation { point: LogicalPoint; preferredScreenRow: number }
export type ViewportAnchor =
  | { kind: "tail" }
  | { kind: "point"; point: LogicalPoint; preferredScreenRow: number }
export interface TranscriptSelection {
  anchor: LogicalPoint
  head: LogicalPoint
  shape: "character" | "line"
}
export interface TranscriptState {
  search?: { query: string; direction: "forward" | "backward" }
  order: readonly ItemId[]
  projectionById: Readonly<Record<string, TextProjection>>
  cursor?: LogicalPoint
  selection?: TranscriptSelection
  folded: Readonly<Record<string, boolean>>
  viewport: ViewportAnchor
  unseenEntries: number
  /** Item ids whose changed output has already contributed to unseenEntries. */
  unseenItemIds: readonly ItemId[]
  jumps: { back: readonly JumpLocation[]; forward: readonly JumpLocation[] }
  marks: Readonly<Record<string, JumpLocation>>
}

const orderIndexes = new WeakMap<readonly ItemId[], ReadonlyMap<ItemId, number>>()

interface TextLengthNode {
  readonly sum: number
  readonly left?: TextLengthNode
  readonly right?: TextLengthNode
}

interface TranscriptTextLengthIndex {
  readonly order: readonly ItemId[]
  readonly root?: TextLengthNode
  readonly size: number
  readonly capacity: number
}

const textLengthIndexes = new WeakMap<object, TranscriptTextLengthIndex>()

export interface TranscriptTextLengthIndexDiagnostics {
  textLengthIndexBuilds: number
  textLengthItemVisits: number
  textLengthIndexCacheHits: number
  textLengthIndexUpdates: number
  textLengthNodeVisits: number
}

function buildTextLengthNode(lengths: readonly number[], from: number, to: number): TextLengthNode | undefined {
  if (from >= lengths.length || from >= to) return undefined
  if (to - from === 1) return Object.freeze({ sum: lengths[from] ?? 0 })
  const middle = (from + to) >>> 1
  const left = buildTextLengthNode(lengths, from, middle)
  const right = buildTextLengthNode(lengths, middle, to)
  return Object.freeze({ sum: (left?.sum ?? 0) + (right?.sum ?? 0), left, right })
}

function buildTextLengthIndex(state: TranscriptState, diagnostics?: TranscriptTextLengthIndexDiagnostics): TranscriptTextLengthIndex {
  if (diagnostics) diagnostics.textLengthIndexBuilds += 1
  let capacity = 1
  while (capacity < state.order.length) capacity *= 2
  const lengths = state.order.map(id => {
    if (diagnostics) diagnostics.textLengthItemVisits += 1
    return state.projectionById[id]?.sourceSpans.length ?? 0
  })
  return Object.freeze({ order: state.order, root: buildTextLengthNode(lengths, 0, capacity), size: lengths.length, capacity })
}

function textLengthIndex(state: TranscriptState, diagnostics?: TranscriptTextLengthIndexDiagnostics): TranscriptTextLengthIndex {
  const cached = textLengthIndexes.get(state.projectionById)
  if (cached?.order === state.order) {
    if (diagnostics) diagnostics.textLengthIndexCacheHits += 1
    return cached
  }
  const built = buildTextLengthIndex(state, diagnostics)
  textLengthIndexes.set(state.projectionById, built)
  return built
}

function updateTextLengthNode(
  node: TextLengthNode | undefined,
  from: number,
  to: number,
  index: number,
  value: number,
): TextLengthNode {
  if (to - from === 1) return Object.freeze({ sum: value })
  const middle = (from + to) >>> 1
  const left = index < middle ? updateTextLengthNode(node?.left, from, middle, index, value) : node?.left
  const right = index >= middle ? updateTextLengthNode(node?.right, middle, to, index, value) : node?.right
  return Object.freeze({ sum: (left?.sum ?? 0) + (right?.sum ?? 0), left, right })
}

/** Inherit the disposable length index through one known item projection update. */
export function inheritTranscriptTextLengthIndex(
  previous: TranscriptState,
  next: TranscriptState,
  changedItemId: ItemId,
  appended: boolean,
): void {
  const prior = textLengthIndex(previous)
  let root = prior.root
  let capacity = prior.capacity
  const position = appended ? prior.size : transcriptOrderIndex(previous.order).get(changedItemId)
  if (position === undefined) return
  if (appended && prior.size === capacity) {
    root = Object.freeze({ sum: root?.sum ?? 0, left: root })
    capacity *= 2
  }
  root = updateTextLengthNode(root, 0, capacity, position, next.projectionById[changedItemId]?.sourceSpans.length ?? 0)
  textLengthIndexes.set(next.projectionById, Object.freeze({ order: next.order, root, size: next.order.length, capacity }))
}

/** Inherit the disposable length index through bounded existing-item changes. */
export function inheritTranscriptTextLengthIndexChanges(
  previous: TranscriptState,
  next: TranscriptState,
  changedItemIds: readonly ItemId[],
  diagnostics?: TranscriptTextLengthIndexDiagnostics,
): void {
  const prior = textLengthIndex(previous, diagnostics)
  if (previous.order !== next.order && (previous.order.length !== next.order.length
    || previous.order.some((id, index) => next.order[index] !== id))) return
  const order = transcriptOrderIndex(previous.order)
  let root = prior.root
  for (const itemId of new Set(changedItemIds)) {
    const position = order.get(itemId)
    if (position === undefined) continue
    root = updateTextLengthNode(root, 0, prior.capacity, position, next.projectionById[itemId]?.sourceSpans.length ?? 0)
    if (diagnostics) diagnostics.textLengthIndexUpdates += 1
  }
  textLengthIndexes.set(next.projectionById, Object.freeze({ order: next.order, root, size: next.order.length, capacity: prior.capacity }))
}

function textLengthRange(
  node: TextLengthNode | undefined,
  from: number,
  to: number,
  queryFrom: number,
  queryTo: number,
  diagnostics?: TranscriptTextLengthIndexDiagnostics,
): number {
  if (!node || queryTo <= from || queryFrom >= to) return 0
  if (diagnostics) diagnostics.textLengthNodeVisits += 1
  if (queryFrom <= from && to <= queryTo) return node.sum
  const middle = (from + to) >>> 1
  return textLengthRange(node.left, from, middle, queryFrom, queryTo, diagnostics)
    + textLengthRange(node.right, middle, to, queryFrom, queryTo, diagnostics)
}

/** Sum rendered grapheme lengths in [from, to) without materializing text. */
export function transcriptTextLengthRange(
  state: TranscriptState,
  from: number,
  to: number,
  diagnostics?: TranscriptTextLengthIndexDiagnostics,
): number {
  const index = textLengthIndex(state, diagnostics)
  const start = Math.max(0, Math.min(index.size, Math.trunc(from)))
  const end = Math.max(start, Math.min(index.size, Math.trunc(to)))
  return textLengthRange(index.root, 0, index.capacity, start, end, diagnostics)
}

/** Optional deterministic counters for derived-order index construction. */
export interface TranscriptOrderIndexDiagnostics {
  orderIndexBuilds: number
  orderIndexItemVisits: number
  orderIndexCacheHits: number
}

/**
 * Disposable derived index for logical item order. Runtime-created transcript
 * states prime this before React publication, so mounted selection checks stay
 * independent of total transcript length without adding semantic authority.
 */
export function transcriptOrderIndex(
  order: readonly ItemId[],
  diagnostics?: TranscriptOrderIndexDiagnostics,
): ReadonlyMap<ItemId, number> {
  const cached = orderIndexes.get(order)
  if (cached) {
    if (diagnostics) diagnostics.orderIndexCacheHits += 1
    return cached
  }
  if (diagnostics) diagnostics.orderIndexBuilds += 1
  const index = new Map<ItemId, number>()
  for (let position = 0; position < order.length; position++) {
    if (diagnostics) diagnostics.orderIndexItemVisits += 1
    index.set(order[position]!, position)
  }
  orderIndexes.set(order, index)
  return index
}
export type TranscriptCommand =
  | { type: "search.set"; query: string; direction: "forward" | "backward" }
  | { type: "search.jump"; target: JumpLocation; search?: { query: string; direction: "forward" | "backward" } }
  | { type: "cursor.move"; point: LogicalPoint; preferredScreenRow?: number }
  | { type: "jump.to"; target: JumpLocation; origin?: JumpLocation; clearSelection?: boolean }
  | { type: "jump.back"; origin?: JumpLocation }
  | { type: "jump.forward"; origin?: JumpLocation }
  | { type: "mark.set"; name: string; target: JumpLocation }
  | { type: "mark.jump"; name: string; origin?: JumpLocation }
  | { type: "viewport.anchor"; point: LogicalPoint; preferredScreenRow: number }
  | { type: "tail.attach" }
  | { type: "selection.begin"; shape: TranscriptSelection["shape"] }
  | { type: "selection.swap" }
  | { type: "selection.clear" }
  | { type: "fold.set"; itemId: ItemId; folded: boolean }
  | { type: "fold.toggle"; itemId: ItemId }
  | { type: "fold.all"; folded: boolean }
  | { type: "fold.defaults"; reasoning: boolean; tools: boolean }

export const initialTranscript = (): TranscriptState => ({
  order: [], projectionById: {}, folded: {}, viewport: { kind: "tail" }, unseenEntries: 0, unseenItemIds: [], jumps: { back: [], forward: [] }, marks: {},
})
