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
  foldDefaults: Readonly<{ reasoning: boolean; tools: boolean }>
  viewport: ViewportAnchor
  unseenEntries: number
  /** Item ids whose changed output has already contributed to unseenEntries. */
  unseenItemIds: readonly ItemId[]
  jumps: { back: readonly JumpLocation[]; forward: readonly JumpLocation[] }
  marks: Readonly<Record<string, JumpLocation>>
}

interface ProjectionNode {
  readonly key: string
  readonly value: TextProjection
  readonly height: number
  readonly left?: ProjectionNode
  readonly right?: ProjectionNode
}

interface ProjectionRecordData { readonly root?: ProjectionNode; readonly size: number }

export interface TranscriptProjectionRecordDiagnostics {
  projectionRecordUpdates: number
  projectionRecordNodeVisits: number
  projectionRecordNodesCopied: number
}

const projectionRecordData = new WeakMap<object, ProjectionRecordData>()
const normalizedProjectionRecords = new WeakMap<object, Readonly<Record<string, TextProjection>>>()

const projectionHeight = (value: ProjectionNode | undefined) => value?.height ?? 0
function projectionNode(key: string, value: TextProjection, left?: ProjectionNode, right?: ProjectionNode): ProjectionNode {
  return Object.freeze({ key, value, height: Math.max(projectionHeight(left), projectionHeight(right)) + 1,
    ...(left ? { left } : {}), ...(right ? { right } : {}) })
}
function copiedProjectionNode(key: string, value: TextProjection, left: ProjectionNode | undefined, right: ProjectionNode | undefined,
  diagnostics: TranscriptProjectionRecordDiagnostics | undefined): ProjectionNode {
  if (diagnostics) diagnostics.projectionRecordNodesCopied += 1
  return projectionNode(key, value, left, right)
}
function rotateProjectionLeft(root: ProjectionNode, diagnostics?: TranscriptProjectionRecordDiagnostics): ProjectionNode {
  const right = root.right!
  return copiedProjectionNode(right.key, right.value,
    copiedProjectionNode(root.key, root.value, root.left, right.left, diagnostics), right.right, diagnostics)
}
function rotateProjectionRight(root: ProjectionNode, diagnostics?: TranscriptProjectionRecordDiagnostics): ProjectionNode {
  const left = root.left!
  return copiedProjectionNode(left.key, left.value, left.left,
    copiedProjectionNode(root.key, root.value, left.right, root.right, diagnostics), diagnostics)
}
function balanceProjection(root: ProjectionNode, diagnostics?: TranscriptProjectionRecordDiagnostics): ProjectionNode {
  const delta = projectionHeight(root.left) - projectionHeight(root.right)
  if (delta > 1) {
    const left = root.left!
    return rotateProjectionRight(projectionHeight(left.left) < projectionHeight(left.right)
      ? copiedProjectionNode(root.key, root.value, rotateProjectionLeft(left, diagnostics), root.right, diagnostics) : root, diagnostics)
  }
  if (delta < -1) {
    const right = root.right!
    return rotateProjectionLeft(projectionHeight(right.right) < projectionHeight(right.left)
      ? copiedProjectionNode(root.key, root.value, root.left, rotateProjectionRight(right, diagnostics), diagnostics) : root, diagnostics)
  }
  return root
}
function projectionValue(root: ProjectionNode | undefined, key: string): TextProjection | undefined {
  while (root) {
    if (key === root.key) return root.value
    root = key < root.key ? root.left : root.right
  }
  return undefined
}
function setProjectionNode(
  root: ProjectionNode | undefined,
  key: string,
  value: TextProjection,
  diagnostics?: TranscriptProjectionRecordDiagnostics,
): { readonly root: ProjectionNode; readonly added: boolean; readonly changed: boolean } {
  if (diagnostics) diagnostics.projectionRecordNodeVisits += 1
  if (!root) {
    return { root: copiedProjectionNode(key, value, undefined, undefined, diagnostics), added: true, changed: true }
  }
  if (key === root.key) {
    if (root.value === value) return { root, added: false, changed: false }
    return { root: copiedProjectionNode(key, value, root.left, root.right, diagnostics), added: false, changed: true }
  }
  if (key < root.key) {
    const next = setProjectionNode(root.left, key, value, diagnostics)
    if (!next.changed) return { root, added: false, changed: false }
    return { root: balanceProjection(copiedProjectionNode(root.key, root.value, next.root, root.right, diagnostics), diagnostics), added: next.added, changed: true }
  }
  const next = setProjectionNode(root.right, key, value, diagnostics)
  if (!next.changed) return { root, added: false, changed: false }
  return { root: balanceProjection(copiedProjectionNode(root.key, root.value, root.left, next.root, diagnostics), diagnostics), added: next.added, changed: true }
}
function projectionEntries(root: ProjectionNode | undefined, result: [string, TextProjection][]): void {
  if (!root) return
  projectionEntries(root.left, result)
  result.push([root.key, root.value])
  projectionEntries(root.right, result)
}
function ordinaryRecordKeys(entries: readonly [string, unknown][]): string[] {
  const indexed: number[] = []
  const named: string[] = []
  for (const [key] of entries) {
    const value = Number(key)
    if (Number.isInteger(value) && value >= 0 && value < 0xffff_ffff && String(value) === key) indexed.push(value)
    else named.push(key)
  }
  indexed.sort((left, right) => left - right)
  return [...indexed.map(String), ...named]
}
function projectionRecord(data: ProjectionRecordData): Readonly<Record<string, TextProjection>> {
  const target = Object.create(null) as Record<string, TextProjection>
  const proxy = new Proxy(target, {
    get: (_target, property) => typeof property === "string" ? projectionValue(data.root, property) : Reflect.get(target, property),
    has: (_target, property) => typeof property === "string" ? projectionValue(data.root, property) !== undefined : false,
    ownKeys: () => { const entries: [string, TextProjection][] = []; projectionEntries(data.root, entries); return ordinaryRecordKeys(entries) },
    getOwnPropertyDescriptor: (_target, property) => typeof property === "string" && projectionValue(data.root, property) !== undefined
      ? { configurable: true, enumerable: true, writable: false, value: projectionValue(data.root, property) } : undefined,
    set: () => false,
    deleteProperty: () => false,
    defineProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  })
  projectionRecordData.set(proxy, data)
  return proxy
}

/** Normalize persisted/plain projections into an immutable path-copying record. */
export function persistentTranscriptProjections(
  value: Readonly<Record<string, TextProjection>> = {},
): Readonly<Record<string, TextProjection>> {
  if (projectionRecordData.has(value)) return value
  const cached = normalizedProjectionRecords.get(value)
  if (cached) return cached
  const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  const build = (from: number, to: number): ProjectionNode | undefined => {
    if (from >= to) return undefined
    const middle = (from + to) >>> 1
    const [key, projection] = entries[middle]!
    return projectionNode(key, projection, build(from, middle), build(middle + 1, to))
  }
  const record = projectionRecord({ root: build(0, entries.length), size: entries.length })
  normalizedProjectionRecords.set(value, record)
  return record
}

export function setTranscriptProjection(
  value: Readonly<Record<string, TextProjection>>,
  itemId: ItemId,
  projection: TextProjection,
  diagnostics?: TranscriptProjectionRecordDiagnostics,
): Readonly<Record<string, TextProjection>> {
  const record = persistentTranscriptProjections(value)
  const data = projectionRecordData.get(record)!
  const next = setProjectionNode(data.root, itemId, projection, diagnostics)
  if (!next.changed) return record
  if (diagnostics) diagnostics.projectionRecordUpdates += 1
  return projectionRecord({ root: next.root, size: data.size + (next.added ? 1 : 0) })
}

interface FoldNode {
  readonly key: string
  readonly value: boolean
  readonly height: number
  readonly left?: FoldNode
  readonly right?: FoldNode
}

interface FoldRecordData { readonly root?: FoldNode; readonly size: number }

const foldRecordData = new WeakMap<object, FoldRecordData>()
const normalizedFoldRecords = new WeakMap<object, Readonly<Record<string, boolean>>>()

function compareFoldKey(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

const height = (value: FoldNode | undefined) => value?.height ?? 0
function foldNode(key: string, value: boolean, left?: FoldNode, right?: FoldNode): FoldNode {
  return Object.freeze({ key, value, height: Math.max(height(left), height(right)) + 1, ...(left ? { left } : {}), ...(right ? { right } : {}) })
}
function rotateFoldLeft(root: FoldNode): FoldNode {
  const right = root.right!
  return foldNode(right.key, right.value, foldNode(root.key, root.value, root.left, right.left), right.right)
}
function rotateFoldRight(root: FoldNode): FoldNode {
  const left = root.left!
  return foldNode(left.key, left.value, left.left, foldNode(root.key, root.value, left.right, root.right))
}
function balanceFold(root: FoldNode): FoldNode {
  const delta = height(root.left) - height(root.right)
  if (delta > 1) {
    const left = root.left!
    return rotateFoldRight(height(left.left) < height(left.right)
      ? foldNode(root.key, root.value, rotateFoldLeft(left), root.right) : root)
  }
  if (delta < -1) {
    const right = root.right!
    return rotateFoldLeft(height(right.right) < height(right.left)
      ? foldNode(root.key, root.value, root.left, rotateFoldRight(right)) : root)
  }
  return root
}
function foldValue(root: FoldNode | undefined, key: string): boolean | undefined {
  while (root) {
    if (key === root.key) return root.value
    root = compareFoldKey(key, root.key) < 0 ? root.left : root.right
  }
  return undefined
}
function setFoldNode(root: FoldNode | undefined, key: string, value: boolean): { readonly root: FoldNode; readonly added: boolean; readonly changed: boolean } {
  if (!root) return { root: foldNode(key, value), added: true, changed: true }
  if (key === root.key) return root.value === value
    ? { root, added: false, changed: false }
    : { root: foldNode(key, value, root.left, root.right), added: false, changed: true }
  if (compareFoldKey(key, root.key) < 0) {
    const next = setFoldNode(root.left, key, value)
    return next.changed ? { root: balanceFold(foldNode(root.key, root.value, next.root, root.right)), added: next.added, changed: true }
      : { root, added: false, changed: false }
  }
  const next = setFoldNode(root.right, key, value)
  return next.changed ? { root: balanceFold(foldNode(root.key, root.value, root.left, next.root)), added: next.added, changed: true }
    : { root, added: false, changed: false }
}
function foldEntries(root: FoldNode | undefined, result: [string, boolean][]): void {
  if (!root) return
  foldEntries(root.left, result)
  result.push([root.key, root.value])
  foldEntries(root.right, result)
}
function foldRecord(data: FoldRecordData): Readonly<Record<string, boolean>> {
  const target = Object.create(null) as Record<string, boolean>
  const proxy = new Proxy(target, {
    get: (_target, property) => typeof property === "string" ? foldValue(data.root, property) : Reflect.get(target, property),
    has: (_target, property) => typeof property === "string" ? foldValue(data.root, property) !== undefined : false,
    ownKeys: () => { const entries: [string, boolean][] = []; foldEntries(data.root, entries); return entries.map(([key]) => key) },
    getOwnPropertyDescriptor: (_target, property) => typeof property === "string" && foldValue(data.root, property) !== undefined
      ? { configurable: true, enumerable: true, writable: false, value: foldValue(data.root, property) } : undefined,
    set: () => false,
    deleteProperty: () => false,
    defineProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  })
  foldRecordData.set(proxy, data)
  return proxy
}

/** Normalize persisted/plain fold metadata into an immutable persistent record. */
export function persistentTranscriptFolds(value: Readonly<Record<string, boolean>> = {}): Readonly<Record<string, boolean>> {
  if (foldRecordData.has(value)) return value
  const cached = normalizedFoldRecords.get(value)
  if (cached) return cached
  const entries = Object.entries(value).sort(([left], [right]) => compareFoldKey(left, right))
  const build = (from: number, to: number): FoldNode | undefined => {
    if (from >= to) return undefined
    const middle = (from + to) >>> 1
    const [key, folded] = entries[middle]!
    return foldNode(key, folded, build(from, middle), build(middle + 1, to))
  }
  const record = foldRecord({ root: build(0, entries.length), size: entries.length })
  normalizedFoldRecords.set(value, record)
  return record
}

export function setTranscriptFoldValue(value: Readonly<Record<string, boolean>>, itemId: ItemId, folded: boolean): Readonly<Record<string, boolean>> {
  const record = persistentTranscriptFolds(value)
  const data = foldRecordData.get(record)!
  const next = setFoldNode(data.root, itemId, folded)
  return next.changed ? foldRecord({ root: next.root, size: data.size + (next.added ? 1 : 0) }) : record
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
  | { type: "cursor.reveal"; point: LogicalPoint; preferredScreenRow?: number }
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
  order: [], projectionById: persistentTranscriptProjections(), folded: persistentTranscriptFolds(), foldDefaults: Object.freeze({ reasoning: false, tools: false }), viewport: { kind: "tail" }, unseenEntries: 0, unseenItemIds: [], jumps: { back: [], forward: [] }, marks: {},
})
