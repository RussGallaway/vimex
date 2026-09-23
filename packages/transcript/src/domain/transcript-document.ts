import type { ItemId } from "@vimex/conversation"

export interface LinkTarget {
  readonly from: number
  readonly to: number
  readonly url: string
}
export interface SourceSpan {
  readonly from: number
  readonly to: number
}
export interface TextProjection {
  /** Semantic node class used by message-wise navigation. */
  readonly nodeKind?: "message" | "reasoning" | "tool" | "edit" | "unknown"
  readonly plain: string
  readonly source: string
  /** One exact source span for each rendered grapheme. */
  readonly sourceSpans: readonly SourceSpan[]
  readonly links: readonly LinkTarget[]
  /** Syntax envelopes included when their entire rendered content is selected. */
  readonly sourceRegions?: readonly {
    readonly from: number
    readonly to: number
    readonly sourceFrom: number
    readonly sourceTo: number
  }[]
  readonly revision: number
}
export interface LogicalPoint {
  itemId: ItemId
  graphemeOffset: number
}
export interface JumpLocation {
  point: LogicalPoint
  preferredScreenRow: number
}
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
  /** Last bulk tool fold choice also applies to tools arriving later. */
  bulkToolFolded?: boolean
  viewport: ViewportAnchor
  unseenEntries: number
  /** Item ids whose changed output has already contributed to unseenEntries. */
  unseenItemIds: readonly ItemId[]
  jumps: { back: readonly JumpLocation[]; forward: readonly JumpLocation[] }
  marks: Readonly<Record<string, JumpLocation>>
}

export interface TranscriptUnseenItemDiagnostics {
  unseenItemSequenceNormalizations: number
  unseenItemSequenceNormalizationItemVisits: number
  unseenItemMembershipChecks: number
  unseenItemMembershipNodeVisits: number
  unseenItemAppends: number
  unseenItemAppendNodeVisits: number
  unseenItemIndexUpdateNodeVisits: number
  unseenItemIndexUpdateNodesCopied: number
}

interface ProjectionNode {
  readonly key: string
  readonly value: TextProjection
  readonly height: number
  readonly left?: ProjectionNode
  readonly right?: ProjectionNode
}

interface ProjectionRecordData {
  readonly token: object
  readonly root?: ProjectionNode
  readonly size: number
  readonly lineage?: {
    readonly previousRoot?: ProjectionNode
    readonly previousSize: number
    readonly previousToken: object
    readonly updatedKey: string
    readonly previousValue?: TextProjection
    readonly updatedValue: TextProjection
  }
}

export interface TranscriptProjectionRecordDiagnostics {
  projectionRecordUpdates: number
  projectionRecordNodeVisits: number
  projectionRecordNodesCopied: number
}

const projectionRecordData = new WeakMap<object, ProjectionRecordData>()
const normalizedProjectionRecords = new WeakMap<
  object,
  Readonly<Record<string, TextProjection>>
>()

const projectionHeight = (value: ProjectionNode | undefined) =>
  value?.height ?? 0
function projectionNode(
  key: string,
  value: TextProjection,
  left?: ProjectionNode,
  right?: ProjectionNode,
): ProjectionNode {
  return Object.freeze({
    key,
    value,
    height: Math.max(projectionHeight(left), projectionHeight(right)) + 1,
    ...(left ? { left } : {}),
    ...(right ? { right } : {}),
  })
}
function copiedProjectionNode(
  key: string,
  value: TextProjection,
  left: ProjectionNode | undefined,
  right: ProjectionNode | undefined,
  diagnostics: TranscriptProjectionRecordDiagnostics | undefined,
): ProjectionNode {
  if (diagnostics) diagnostics.projectionRecordNodesCopied += 1
  return projectionNode(key, value, left, right)
}
function rotateProjectionLeft(
  root: ProjectionNode,
  diagnostics?: TranscriptProjectionRecordDiagnostics,
): ProjectionNode {
  const right = root.right!
  return copiedProjectionNode(
    right.key,
    right.value,
    copiedProjectionNode(
      root.key,
      root.value,
      root.left,
      right.left,
      diagnostics,
    ),
    right.right,
    diagnostics,
  )
}
function rotateProjectionRight(
  root: ProjectionNode,
  diagnostics?: TranscriptProjectionRecordDiagnostics,
): ProjectionNode {
  const left = root.left!
  return copiedProjectionNode(
    left.key,
    left.value,
    left.left,
    copiedProjectionNode(
      root.key,
      root.value,
      left.right,
      root.right,
      diagnostics,
    ),
    diagnostics,
  )
}
function balanceProjection(
  root: ProjectionNode,
  diagnostics?: TranscriptProjectionRecordDiagnostics,
): ProjectionNode {
  const delta = projectionHeight(root.left) - projectionHeight(root.right)
  if (delta > 1) {
    const left = root.left!
    return rotateProjectionRight(
      projectionHeight(left.left) < projectionHeight(left.right)
        ? copiedProjectionNode(
            root.key,
            root.value,
            rotateProjectionLeft(left, diagnostics),
            root.right,
            diagnostics,
          )
        : root,
      diagnostics,
    )
  }
  if (delta < -1) {
    const right = root.right!
    return rotateProjectionLeft(
      projectionHeight(right.right) < projectionHeight(right.left)
        ? copiedProjectionNode(
            root.key,
            root.value,
            root.left,
            rotateProjectionRight(right, diagnostics),
            diagnostics,
          )
        : root,
      diagnostics,
    )
  }
  return root
}
function projectionValue(
  root: ProjectionNode | undefined,
  key: string,
): TextProjection | undefined {
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
): {
  readonly root: ProjectionNode
  readonly added: boolean
  readonly changed: boolean
  readonly previousValue?: TextProjection
} {
  if (diagnostics) diagnostics.projectionRecordNodeVisits += 1
  if (!root) {
    return {
      root: copiedProjectionNode(key, value, undefined, undefined, diagnostics),
      added: true,
      changed: true,
    }
  }
  if (key === root.key) {
    if (root.value === value)
      return { root, added: false, changed: false, previousValue: root.value }
    return {
      root: copiedProjectionNode(
        key,
        value,
        root.left,
        root.right,
        diagnostics,
      ),
      added: false,
      changed: true,
      previousValue: root.value,
    }
  }
  if (key < root.key) {
    const next = setProjectionNode(root.left, key, value, diagnostics)
    if (!next.changed)
      return {
        root,
        added: false,
        changed: false,
        previousValue: next.previousValue,
      }
    return {
      root: balanceProjection(
        copiedProjectionNode(
          root.key,
          root.value,
          next.root,
          root.right,
          diagnostics,
        ),
        diagnostics,
      ),
      added: next.added,
      changed: true,
      previousValue: next.previousValue,
    }
  }
  const next = setProjectionNode(root.right, key, value, diagnostics)
  if (!next.changed)
    return {
      root,
      added: false,
      changed: false,
      previousValue: next.previousValue,
    }
  return {
    root: balanceProjection(
      copiedProjectionNode(
        root.key,
        root.value,
        root.left,
        next.root,
        diagnostics,
      ),
      diagnostics,
    ),
    added: next.added,
    changed: true,
    previousValue: next.previousValue,
  }
}
function projectionEntries(
  root: ProjectionNode | undefined,
  result: [string, TextProjection][],
): void {
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
    if (
      Number.isInteger(value) &&
      value >= 0 &&
      value < 0xffff_ffff &&
      String(value) === key
    )
      indexed.push(value)
    else named.push(key)
  }
  indexed.sort((left, right) => left - right)
  return [...indexed.map(String), ...named]
}
function projectionRecord(
  data: ProjectionRecordData,
): Readonly<Record<string, TextProjection>> {
  const target = Object.create(null) as Record<string, TextProjection>
  const proxy = new Proxy(target, {
    get: (_target, property) =>
      typeof property === "string"
        ? projectionValue(data.root, property)
        : Reflect.get(target, property),
    has: (_target, property) =>
      typeof property === "string"
        ? projectionValue(data.root, property) !== undefined
        : false,
    ownKeys: () => {
      const entries: [string, TextProjection][] = []
      projectionEntries(data.root, entries)
      return ordinaryRecordKeys(entries)
    },
    getOwnPropertyDescriptor: (_target, property) =>
      typeof property === "string" &&
      projectionValue(data.root, property) !== undefined
        ? {
            configurable: true,
            enumerable: true,
            writable: false,
            value: projectionValue(data.root, property),
          }
        : undefined,
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
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
  const build = (from: number, to: number): ProjectionNode | undefined => {
    if (from >= to) return undefined
    const middle = (from + to) >>> 1
    const [key, projection] = entries[middle]!
    return projectionNode(
      key,
      projection,
      build(from, middle),
      build(middle + 1, to),
    )
  }
  const record = projectionRecord({
    token: Object.freeze({}),
    root: build(0, entries.length),
    size: entries.length,
  })
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
  return projectionRecord({
    token: Object.freeze({}),
    root: next.root,
    size: data.size + (next.added ? 1 : 0),
    lineage: {
      previousRoot: data.root,
      previousSize: data.size,
      previousToken: data.token,
      updatedKey: itemId,
      previousValue: next.previousValue,
      updatedValue: projection,
    },
  })
}

/** Prove one exact projection addition without scanning the projection record. */
export function isTranscriptProjectionAddition(
  previous: Readonly<Record<string, TextProjection>>,
  next: Readonly<Record<string, TextProjection>>,
  itemId: ItemId,
  projection: TextProjection,
): boolean {
  const previousData = projectionRecordData.get(previous)
  const data = projectionRecordData.get(next)
  return (
    previousData !== undefined &&
    data?.lineage !== undefined &&
    data.lineage.previousRoot === previousData.root &&
    data.lineage.previousSize === previousData.size &&
    data.lineage.previousToken === previousData.token &&
    data.lineage.updatedKey === itemId &&
    data.lineage.previousValue === undefined &&
    data.lineage.updatedValue === projection &&
    data.size === previousData.size + 1
  )
}

interface FoldNode {
  readonly key: string
  readonly value: boolean
  readonly height: number
  readonly left?: FoldNode
  readonly right?: FoldNode
}

interface FoldRecordData {
  readonly token: object
  readonly root?: FoldNode
  readonly size: number
  readonly lineage?: {
    readonly previousRoot?: FoldNode
    readonly previousSize: number
    readonly previousToken: object
    readonly updatedKey: string
    readonly previousValue?: boolean
    readonly updatedValue: boolean
  }
}

const foldRecordData = new WeakMap<object, FoldRecordData>()
const normalizedFoldRecords = new WeakMap<
  object,
  Readonly<Record<string, boolean>>
>()

function compareFoldKey(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

const height = (value: FoldNode | undefined) => value?.height ?? 0
function foldNode(
  key: string,
  value: boolean,
  left?: FoldNode,
  right?: FoldNode,
): FoldNode {
  return Object.freeze({
    key,
    value,
    height: Math.max(height(left), height(right)) + 1,
    ...(left ? { left } : {}),
    ...(right ? { right } : {}),
  })
}
function rotateFoldLeft(root: FoldNode): FoldNode {
  const right = root.right!
  return foldNode(
    right.key,
    right.value,
    foldNode(root.key, root.value, root.left, right.left),
    right.right,
  )
}
function rotateFoldRight(root: FoldNode): FoldNode {
  const left = root.left!
  return foldNode(
    left.key,
    left.value,
    left.left,
    foldNode(root.key, root.value, left.right, root.right),
  )
}
function balanceFold(root: FoldNode): FoldNode {
  const delta = height(root.left) - height(root.right)
  if (delta > 1) {
    const left = root.left!
    return rotateFoldRight(
      height(left.left) < height(left.right)
        ? foldNode(root.key, root.value, rotateFoldLeft(left), root.right)
        : root,
    )
  }
  if (delta < -1) {
    const right = root.right!
    return rotateFoldLeft(
      height(right.right) < height(right.left)
        ? foldNode(root.key, root.value, root.left, rotateFoldRight(right))
        : root,
    )
  }
  return root
}
function foldValue(
  root: FoldNode | undefined,
  key: string,
): boolean | undefined {
  while (root) {
    if (key === root.key) return root.value
    root = compareFoldKey(key, root.key) < 0 ? root.left : root.right
  }
  return undefined
}
function setFoldNode(
  root: FoldNode | undefined,
  key: string,
  value: boolean,
): {
  readonly root: FoldNode
  readonly added: boolean
  readonly changed: boolean
  readonly previousValue?: boolean
} {
  if (!root) return { root: foldNode(key, value), added: true, changed: true }
  if (key === root.key)
    return root.value === value
      ? { root, added: false, changed: false, previousValue: root.value }
      : {
          root: foldNode(key, value, root.left, root.right),
          added: false,
          changed: true,
          previousValue: root.value,
        }
  if (compareFoldKey(key, root.key) < 0) {
    const next = setFoldNode(root.left, key, value)
    return next.changed
      ? {
          root: balanceFold(
            foldNode(root.key, root.value, next.root, root.right),
          ),
          added: next.added,
          changed: true,
          previousValue: next.previousValue,
        }
      : {
          root,
          added: false,
          changed: false,
          previousValue: next.previousValue,
        }
  }
  const next = setFoldNode(root.right, key, value)
  return next.changed
    ? {
        root: balanceFold(foldNode(root.key, root.value, root.left, next.root)),
        added: next.added,
        changed: true,
        previousValue: next.previousValue,
      }
    : { root, added: false, changed: false, previousValue: next.previousValue }
}
function foldEntries(
  root: FoldNode | undefined,
  result: [string, boolean][],
): void {
  if (!root) return
  foldEntries(root.left, result)
  result.push([root.key, root.value])
  foldEntries(root.right, result)
}
function foldRecord(data: FoldRecordData): Readonly<Record<string, boolean>> {
  const target = Object.create(null) as Record<string, boolean>
  const proxy = new Proxy(target, {
    get: (_target, property) =>
      typeof property === "string"
        ? foldValue(data.root, property)
        : Reflect.get(target, property),
    has: (_target, property) =>
      typeof property === "string"
        ? foldValue(data.root, property) !== undefined
        : false,
    ownKeys: () => {
      const entries: [string, boolean][] = []
      foldEntries(data.root, entries)
      return entries.map(([key]) => key)
    },
    getOwnPropertyDescriptor: (_target, property) =>
      typeof property === "string" &&
      foldValue(data.root, property) !== undefined
        ? {
            configurable: true,
            enumerable: true,
            writable: false,
            value: foldValue(data.root, property),
          }
        : undefined,
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
export function persistentTranscriptFolds(
  value: Readonly<Record<string, boolean>> = {},
): Readonly<Record<string, boolean>> {
  if (foldRecordData.has(value)) return value
  const cached = normalizedFoldRecords.get(value)
  if (cached) return cached
  const entries = Object.entries(value).sort(([left], [right]) =>
    compareFoldKey(left, right),
  )
  const build = (from: number, to: number): FoldNode | undefined => {
    if (from >= to) return undefined
    const middle = (from + to) >>> 1
    const [key, folded] = entries[middle]!
    return foldNode(key, folded, build(from, middle), build(middle + 1, to))
  }
  const record = foldRecord({
    token: Object.freeze({}),
    root: build(0, entries.length),
    size: entries.length,
  })
  normalizedFoldRecords.set(value, record)
  return record
}

export function setTranscriptFoldValue(
  value: Readonly<Record<string, boolean>>,
  itemId: ItemId,
  folded: boolean,
): Readonly<Record<string, boolean>> {
  const record = persistentTranscriptFolds(value)
  const data = foldRecordData.get(record)!
  const next = setFoldNode(data.root, itemId, folded)
  return next.changed
    ? foldRecord({
        token: Object.freeze({}),
        root: next.root,
        size: data.size + (next.added ? 1 : 0),
        lineage: {
          previousRoot: data.root,
          previousSize: data.size,
          previousToken: data.token,
          updatedKey: itemId,
          previousValue: next.previousValue,
          updatedValue: folded,
        },
      })
    : record
}

/** Prove one exact new-item fold entry without enumerating fold metadata. */
export function isTranscriptFoldAddition(
  previous: Readonly<Record<string, boolean>>,
  next: Readonly<Record<string, boolean>>,
  itemId: ItemId,
  folded: boolean,
): boolean {
  const previousData = foldRecordData.get(previous)
  const data = foldRecordData.get(next)
  return (
    previousData !== undefined &&
    data?.lineage !== undefined &&
    data.lineage.previousRoot === previousData.root &&
    data.lineage.previousSize === previousData.size &&
    data.lineage.previousToken === previousData.token &&
    data.lineage.updatedKey === itemId &&
    data.lineage.previousValue === undefined &&
    data.lineage.updatedValue === folded &&
    data.size === previousData.size + 1
  )
}

const ORDER_LEAF_SIZE = 32

interface TranscriptOrderLeaf {
  readonly kind: "leaf"
  readonly items: readonly ItemId[]
  readonly size: number
  readonly height: 1
}

interface TranscriptOrderBranch {
  readonly kind: "branch"
  readonly left: TranscriptOrderNode
  readonly right: TranscriptOrderNode
  readonly size: number
  readonly height: number
}

type TranscriptOrderNode = TranscriptOrderLeaf | TranscriptOrderBranch

interface TranscriptOrderData {
  readonly root?: TranscriptOrderNode
  readonly size: number
}

export interface TranscriptOrderAppend {
  readonly previous: readonly ItemId[]
  readonly itemId: ItemId
  readonly position: number
}

interface TranscriptOrderAppendData {
  readonly previous: WeakRef<readonly ItemId[]>
  readonly itemId: ItemId
  readonly position: number
}

interface OrderIndexNode {
  readonly key: ItemId
  readonly position: number
  readonly height: number
  readonly left?: OrderIndexNode
  readonly right?: OrderIndexNode
}

const transcriptOrderData = new WeakMap<object, TranscriptOrderData>()
const normalizedTranscriptOrders = new WeakMap<object, readonly ItemId[]>()
const transcriptOrderAppends = new WeakMap<object, TranscriptOrderAppendData>()
const orderIndexes = new WeakMap<
  readonly ItemId[],
  ReadonlyMap<ItemId, number>
>()

const orderNodeHeight = (node: TranscriptOrderNode | undefined): number =>
  node?.height ?? 0
function transcriptOrderLeaf(items: readonly ItemId[]): TranscriptOrderLeaf {
  return Object.freeze({
    kind: "leaf",
    items: Object.freeze(items),
    size: items.length,
    height: 1,
  })
}
function transcriptOrderBranch(
  left: TranscriptOrderNode,
  right: TranscriptOrderNode,
): TranscriptOrderBranch {
  return Object.freeze({
    kind: "branch",
    left,
    right,
    size: left.size + right.size,
    height: Math.max(left.height, right.height) + 1,
  })
}
function balanceTranscriptOrder(
  node: TranscriptOrderBranch,
): TranscriptOrderNode {
  const delta = orderNodeHeight(node.left) - orderNodeHeight(node.right)
  if (delta > 1 && node.left.kind === "branch") {
    const left = node.left
    if (
      orderNodeHeight(left.left) < orderNodeHeight(left.right) &&
      left.right.kind === "branch"
    ) {
      const promoted = left.right
      return transcriptOrderBranch(
        transcriptOrderBranch(left.left, promoted.left),
        transcriptOrderBranch(promoted.right, node.right),
      )
    }
    return transcriptOrderBranch(
      left.left,
      transcriptOrderBranch(left.right, node.right),
    )
  }
  if (delta < -1 && node.right.kind === "branch") {
    const right = node.right
    if (
      orderNodeHeight(right.right) < orderNodeHeight(right.left) &&
      right.left.kind === "branch"
    ) {
      const promoted = right.left
      return transcriptOrderBranch(
        transcriptOrderBranch(node.left, promoted.left),
        transcriptOrderBranch(promoted.right, right.right),
      )
    }
    return transcriptOrderBranch(
      transcriptOrderBranch(node.left, right.left),
      right.right,
    )
  }
  return node
}
function appendTranscriptOrderNode(
  node: TranscriptOrderNode | undefined,
  itemId: ItemId,
  visit?: () => void,
): TranscriptOrderNode {
  visit?.()
  if (!node) return transcriptOrderLeaf([itemId])
  if (node.kind === "leaf")
    return node.items.length < ORDER_LEAF_SIZE
      ? transcriptOrderLeaf([...node.items, itemId])
      : transcriptOrderBranch(node, transcriptOrderLeaf([itemId]))
  return balanceTranscriptOrder(
    transcriptOrderBranch(
      node.left,
      appendTranscriptOrderNode(node.right, itemId, visit),
    ),
  )
}
function transcriptOrderItem(
  node: TranscriptOrderNode,
  position: number,
): ItemId {
  while (node.kind === "branch") {
    if (position < node.left.size) node = node.left
    else {
      position -= node.left.size
      node = node.right
    }
  }
  return node.items[position]!
}
function* transcriptOrderItems(
  node: TranscriptOrderNode | undefined,
): IterableIterator<ItemId> {
  if (!node) return
  if (node.kind === "leaf") {
    yield* node.items
    return
  }
  yield* transcriptOrderItems(node.left)
  yield* transcriptOrderItems(node.right)
}
function buildTranscriptOrder(
  items: readonly ItemId[],
  from = 0,
  to = items.length,
): TranscriptOrderNode | undefined {
  if (from >= to) return undefined
  if (to - from <= ORDER_LEAF_SIZE)
    return transcriptOrderLeaf(items.slice(from, to))
  const leafCount = Math.ceil((to - from) / ORDER_LEAF_SIZE)
  const leftLeafCount = 2 ** Math.floor(Math.log2(leafCount - 1))
  const middle = Math.min(to, from + leftLeafCount * ORDER_LEAF_SIZE)
  return transcriptOrderBranch(
    buildTranscriptOrder(items, from, middle)!,
    buildTranscriptOrder(items, middle, to)!,
  )
}
function transcriptOrderPosition(
  property: PropertyKey,
  size: number,
): number | undefined {
  if (
    typeof property !== "string" ||
    property === "" ||
    !/^\d+$/.test(property)
  )
    return undefined
  const position = Number(property)
  return Number.isSafeInteger(position) &&
    position < size &&
    String(position) === property
    ? position
    : undefined
}
function persistentOrderArray(data: TranscriptOrderData): readonly ItemId[] {
  const target = new Array<ItemId>(data.size)
  const proxy = new Proxy(target, {
    get: (_target, property, receiver) => {
      if (property === Symbol.iterator)
        return () => transcriptOrderItems(data.root)
      if (property === "entries")
        return function* () {
          let position = 0
          for (const itemId of transcriptOrderItems(data.root))
            yield [position++, itemId] as [number, ItemId]
        }
      if (property === "keys")
        return function* () {
          for (let position = 0; position < data.size; position++)
            yield position
        }
      if (property === "values") return () => transcriptOrderItems(data.root)
      const position = transcriptOrderPosition(property, data.size)
      return position === undefined
        ? Reflect.get(target, property, receiver)
        : transcriptOrderItem(data.root!, position)
    },
    has: (_target, property) =>
      transcriptOrderPosition(property, data.size) !== undefined ||
      Reflect.has(target, property),
    ownKeys: () => [
      ...Array.from({ length: data.size }, (_, position) => String(position)),
      "length",
    ],
    getOwnPropertyDescriptor: (_target, property) => {
      const position = transcriptOrderPosition(property, data.size)
      return position === undefined
        ? Reflect.getOwnPropertyDescriptor(target, property)
        : {
            configurable: true,
            enumerable: true,
            writable: false,
            value: transcriptOrderItem(data.root!, position),
          }
    },
    set: () => false,
    deleteProperty: () => false,
    defineProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  })
  transcriptOrderData.set(proxy, data)
  return proxy
}

const orderIndexHeight = (node: OrderIndexNode | undefined): number =>
  node?.height ?? 0
interface OrderIndexUpdateObserver {
  readonly visit: () => void
  readonly copy: () => void
}
function orderIndexNode(
  key: ItemId,
  position: number,
  left?: OrderIndexNode,
  right?: OrderIndexNode,
  observer?: OrderIndexUpdateObserver,
): OrderIndexNode {
  observer?.copy()
  return Object.freeze({
    key,
    position,
    height: Math.max(orderIndexHeight(left), orderIndexHeight(right)) + 1,
    ...(left ? { left } : {}),
    ...(right ? { right } : {}),
  })
}
function rotateOrderIndexLeft(
  root: OrderIndexNode,
  observer?: OrderIndexUpdateObserver,
): OrderIndexNode {
  const right = root.right!
  return orderIndexNode(
    right.key,
    right.position,
    orderIndexNode(root.key, root.position, root.left, right.left, observer),
    right.right,
    observer,
  )
}
function rotateOrderIndexRight(
  root: OrderIndexNode,
  observer?: OrderIndexUpdateObserver,
): OrderIndexNode {
  const left = root.left!
  return orderIndexNode(
    left.key,
    left.position,
    left.left,
    orderIndexNode(root.key, root.position, left.right, root.right, observer),
    observer,
  )
}
function balanceOrderIndex(
  root: OrderIndexNode,
  observer?: OrderIndexUpdateObserver,
): OrderIndexNode {
  const delta = orderIndexHeight(root.left) - orderIndexHeight(root.right)
  if (delta > 1) {
    const left = root.left!
    return rotateOrderIndexRight(
      orderIndexHeight(left.left) < orderIndexHeight(left.right)
        ? orderIndexNode(
            root.key,
            root.position,
            rotateOrderIndexLeft(left, observer),
            root.right,
            observer,
          )
        : root,
      observer,
    )
  }
  if (delta < -1) {
    const right = root.right!
    return rotateOrderIndexLeft(
      orderIndexHeight(right.right) < orderIndexHeight(right.left)
        ? orderIndexNode(
            root.key,
            root.position,
            root.left,
            rotateOrderIndexRight(right, observer),
            observer,
          )
        : root,
      observer,
    )
  }
  return root
}
function setOrderIndexNode(
  root: OrderIndexNode | undefined,
  key: ItemId,
  position: number,
  observer?: OrderIndexUpdateObserver,
): { readonly root: OrderIndexNode; readonly added: boolean } {
  observer?.visit()
  if (!root)
    return {
      root: orderIndexNode(key, position, undefined, undefined, observer),
      added: true,
    }
  if (key === root.key)
    return {
      root: orderIndexNode(key, position, root.left, root.right, observer),
      added: false,
    }
  if (key < root.key) {
    const next = setOrderIndexNode(root.left, key, position, observer)
    return {
      root: balanceOrderIndex(
        orderIndexNode(
          root.key,
          root.position,
          next.root,
          root.right,
          observer,
        ),
        observer,
      ),
      added: next.added,
    }
  }
  const next = setOrderIndexNode(root.right, key, position, observer)
  return {
    root: balanceOrderIndex(
      orderIndexNode(root.key, root.position, root.left, next.root, observer),
      observer,
    ),
    added: next.added,
  }
}
function orderIndexPosition(
  root: OrderIndexNode | undefined,
  key: ItemId,
  visit?: () => void,
): number | undefined {
  while (root) {
    visit?.()
    if (key === root.key) return root.position
    root = key < root.key ? root.left : root.right
  }
  return undefined
}
class PersistentTranscriptOrderIndex implements ReadonlyMap<ItemId, number> {
  constructor(
    readonly order: readonly ItemId[],
    readonly root: OrderIndexNode | undefined,
    readonly size: number,
  ) {}
  get(key: ItemId): number | undefined {
    return orderIndexPosition(this.root, key)
  }
  has(key: ItemId): boolean {
    return orderIndexPosition(this.root, key) !== undefined
  }
  *entries(): MapIterator<[ItemId, number]> {
    const yielded = new Set<ItemId>()
    for (const itemId of this.order)
      if (!yielded.has(itemId)) {
        yielded.add(itemId)
        yield [itemId, this.get(itemId)!]
      }
  }
  *keys(): MapIterator<ItemId> {
    for (const [itemId] of this.entries()) yield itemId
  }
  *values(): MapIterator<number> {
    for (const [, position] of this.entries()) yield position
  }
  [Symbol.iterator](): MapIterator<[ItemId, number]> {
    return this.entries()
  }
  forEach(
    callbackfn: (
      value: number,
      key: ItemId,
      map: ReadonlyMap<ItemId, number>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [itemId, position] of this.entries())
      callbackfn.call(thisArg, position, itemId, this)
  }
  get [Symbol.toStringTag](): string {
    return "Map"
  }
}

function buildPersistentOrderIndex(
  order: readonly ItemId[],
  diagnostics?: TranscriptOrderIndexDiagnostics,
): ReadonlyMap<ItemId, number> {
  if (diagnostics) diagnostics.orderIndexBuilds += 1
  let root: OrderIndexNode | undefined
  let size = 0
  for (let position = 0; position < order.length; position++) {
    if (diagnostics) diagnostics.orderIndexItemVisits += 1
    const next = setOrderIndexNode(root, order[position]!, position)
    root = next.root
    if (next.added) size += 1
  }
  return new PersistentTranscriptOrderIndex(order, root, size)
}

/** Normalize persisted/plain logical order into an immutable appendable array. */
export function persistentTranscriptOrder(
  value: readonly ItemId[] = [],
): readonly ItemId[] {
  if (transcriptOrderData.has(value)) return value
  const cached = normalizedTranscriptOrders.get(value)
  if (cached) return cached
  const items = Array.from(value)
  const order = persistentOrderArray({
    root: buildTranscriptOrder(items),
    size: items.length,
  })
  normalizedTranscriptOrders.set(value, order)
  orderIndexes.set(order, buildPersistentOrderIndex(order))
  return order
}

/** Append one logical item without copying the preceding transcript order. */
export function appendTranscriptOrder(
  value: readonly ItemId[],
  itemId: ItemId,
): readonly ItemId[] {
  const previous = persistentTranscriptOrder(value)
  const previousData = transcriptOrderData.get(previous)!
  const order = persistentOrderArray({
    root: appendTranscriptOrderNode(previousData.root, itemId),
    size: previousData.size + 1,
  })
  const previousIndex = orderIndexes.get(
    previous,
  ) as PersistentTranscriptOrderIndex
  const nextIndexNode = setOrderIndexNode(
    previousIndex.root,
    itemId,
    previousData.size,
  )
  orderIndexes.set(
    order,
    new PersistentTranscriptOrderIndex(
      order,
      nextIndexNode.root,
      previousIndex.size + (nextIndexNode.added ? 1 : 0),
    ),
  )
  transcriptOrderAppends.set(
    order,
    Object.freeze({
      previous: new WeakRef(value),
      itemId,
      position: previousData.size,
    }),
  )
  return order
}

const emptyTranscriptUnseenItemIds = persistentTranscriptOrder(
  Object.freeze([] as ItemId[]),
)

/** Normalize semantic unseen membership into the immutable appendable sequence representation. */
export function persistentTranscriptUnseenItemIds(
  value: readonly ItemId[] = emptyTranscriptUnseenItemIds,
  diagnostics?: TranscriptUnseenItemDiagnostics,
): readonly ItemId[] {
  if (
    !transcriptOrderData.has(value) &&
    !normalizedTranscriptOrders.has(value) &&
    diagnostics
  ) {
    diagnostics.unseenItemSequenceNormalizations += 1
    diagnostics.unseenItemSequenceNormalizationItemVisits += value.length
  }
  return persistentTranscriptOrder(value)
}

/** Test unseen membership without scanning the ordered semantic list. */
export function hasTranscriptUnseenItemId(
  value: readonly ItemId[],
  itemId: ItemId,
  diagnostics?: TranscriptUnseenItemDiagnostics,
): boolean {
  const sequence = persistentTranscriptUnseenItemIds(value, diagnostics)
  const index = orderIndexes.get(sequence) as PersistentTranscriptOrderIndex
  if (diagnostics) diagnostics.unseenItemMembershipChecks += 1
  return (
    orderIndexPosition(index.root, itemId, () => {
      if (diagnostics) diagnostics.unseenItemMembershipNodeVisits += 1
    }) !== undefined
  )
}

/** Append one newly unseen item without copying the preceding semantic backlog. */
export function appendTranscriptUnseenItemId(
  value: readonly ItemId[],
  itemId: ItemId,
  diagnostics?: TranscriptUnseenItemDiagnostics,
): readonly ItemId[] {
  const previous = persistentTranscriptUnseenItemIds(value, diagnostics)
  const previousData = transcriptOrderData.get(previous)!
  if (diagnostics) diagnostics.unseenItemAppends += 1
  const order = persistentOrderArray({
    root: appendTranscriptOrderNode(previousData.root, itemId, () => {
      if (diagnostics) diagnostics.unseenItemAppendNodeVisits += 1
    }),
    size: previousData.size + 1,
  })
  const previousIndex = orderIndexes.get(
    previous,
  ) as PersistentTranscriptOrderIndex
  const nextIndexNode = setOrderIndexNode(
    previousIndex.root,
    itemId,
    previousData.size,
    {
      visit: () => {
        if (diagnostics) diagnostics.unseenItemIndexUpdateNodeVisits += 1
      },
      copy: () => {
        if (diagnostics) diagnostics.unseenItemIndexUpdateNodesCopied += 1
      },
    },
  )
  orderIndexes.set(
    order,
    new PersistentTranscriptOrderIndex(
      order,
      nextIndexNode.root,
      previousIndex.size + (nextIndexNode.added ? 1 : 0),
    ),
  )
  return order
}

/** Return the exact single-append lineage when `next` directly extends `previous`. */
export function transcriptOrderAppend(
  previous: readonly ItemId[],
  next: readonly ItemId[],
): TranscriptOrderAppend | undefined {
  const append = transcriptOrderAppends.get(next)
  return append?.previous.deref() === previous
    ? Object.freeze({
        previous,
        itemId: append.itemId,
        position: append.position,
      })
    : undefined
}

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

function buildTextLengthNode(
  lengths: readonly number[],
  from: number,
  to: number,
): TextLengthNode | undefined {
  if (from >= lengths.length || from >= to) return undefined
  if (to - from === 1) return Object.freeze({ sum: lengths[from] ?? 0 })
  const middle = (from + to) >>> 1
  const left = buildTextLengthNode(lengths, from, middle)
  const right = buildTextLengthNode(lengths, middle, to)
  return Object.freeze({
    sum: (left?.sum ?? 0) + (right?.sum ?? 0),
    left,
    right,
  })
}

function buildTextLengthIndex(
  state: TranscriptState,
  diagnostics?: TranscriptTextLengthIndexDiagnostics,
): TranscriptTextLengthIndex {
  if (diagnostics) diagnostics.textLengthIndexBuilds += 1
  let capacity = 1
  while (capacity < state.order.length) capacity *= 2
  const lengths = state.order.map((id) => {
    if (diagnostics) diagnostics.textLengthItemVisits += 1
    return state.projectionById[id]?.sourceSpans.length ?? 0
  })
  return Object.freeze({
    order: state.order,
    root: buildTextLengthNode(lengths, 0, capacity),
    size: lengths.length,
    capacity,
  })
}

function textLengthIndex(
  state: TranscriptState,
  diagnostics?: TranscriptTextLengthIndexDiagnostics,
): TranscriptTextLengthIndex {
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
  diagnostics?: TranscriptTextLengthIndexDiagnostics,
): TextLengthNode {
  if (diagnostics) diagnostics.textLengthNodeVisits += 1
  if (to - from === 1) return Object.freeze({ sum: value })
  const middle = (from + to) >>> 1
  const left =
    index < middle
      ? updateTextLengthNode(
          node?.left,
          from,
          middle,
          index,
          value,
          diagnostics,
        )
      : node?.left
  const right =
    index >= middle
      ? updateTextLengthNode(node?.right, middle, to, index, value, diagnostics)
      : node?.right
  return Object.freeze({
    sum: (left?.sum ?? 0) + (right?.sum ?? 0),
    left,
    right,
  })
}

/** Inherit the disposable length index through one known item projection update. */
export function inheritTranscriptTextLengthIndex(
  previous: TranscriptState,
  next: TranscriptState,
  changedItemId: ItemId,
  appended: boolean,
  diagnostics?: TranscriptTextLengthIndexDiagnostics &
    TranscriptOrderIndexDiagnostics,
): void {
  const prior = textLengthIndex(previous, diagnostics)
  let root = prior.root
  let capacity = prior.capacity
  const position = appended
    ? prior.size
    : transcriptOrderIndex(previous.order, diagnostics).get(changedItemId)
  if (position === undefined) return
  if (appended && prior.size === capacity) {
    root = Object.freeze({ sum: root?.sum ?? 0, left: root })
    capacity *= 2
  }
  root = updateTextLengthNode(
    root,
    0,
    capacity,
    position,
    next.projectionById[changedItemId]?.sourceSpans.length ?? 0,
    diagnostics,
  )
  if (diagnostics) diagnostics.textLengthIndexUpdates += 1
  textLengthIndexes.set(
    next.projectionById,
    Object.freeze({
      order: next.order,
      root,
      size: next.order.length,
      capacity,
    }),
  )
}

/** Inherit the disposable length index through bounded existing-item changes. */
export function inheritTranscriptTextLengthIndexChanges(
  previous: TranscriptState,
  next: TranscriptState,
  changedItemIds: readonly ItemId[],
  diagnostics?: TranscriptTextLengthIndexDiagnostics,
): void {
  const prior = textLengthIndex(previous, diagnostics)
  if (
    previous.order !== next.order &&
    (previous.order.length !== next.order.length ||
      previous.order.some((id, index) => next.order[index] !== id))
  )
    return
  const order = transcriptOrderIndex(previous.order)
  let root = prior.root
  for (const itemId of new Set(changedItemIds)) {
    const position = order.get(itemId)
    if (position === undefined) continue
    root = updateTextLengthNode(
      root,
      0,
      prior.capacity,
      position,
      next.projectionById[itemId]?.sourceSpans.length ?? 0,
    )
    if (diagnostics) diagnostics.textLengthIndexUpdates += 1
  }
  textLengthIndexes.set(
    next.projectionById,
    Object.freeze({
      order: next.order,
      root,
      size: next.order.length,
      capacity: prior.capacity,
    }),
  )
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
  return (
    textLengthRange(node.left, from, middle, queryFrom, queryTo, diagnostics) +
    textLengthRange(node.right, middle, to, queryFrom, queryTo, diagnostics)
  )
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
  const index = buildPersistentOrderIndex(order, diagnostics)
  orderIndexes.set(order, index)
  return index
}
export type TranscriptCommand =
  | { type: "search.set"; query: string; direction: "forward" | "backward" }
  | {
      type: "search.jump"
      target: JumpLocation
      search?: { query: string; direction: "forward" | "backward" }
    }
  | { type: "cursor.move"; point: LogicalPoint; preferredScreenRow?: number }
  | { type: "cursor.reveal"; point: LogicalPoint; preferredScreenRow?: number }
  | {
      type: "jump.to"
      target: JumpLocation
      origin?: JumpLocation
      clearSelection?: boolean
      /** Browse a visible row without changing its explicit fold state. */
      preserveFolds?: boolean
    }
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
  | { type: "fold.all"; folded: boolean; scope?: "all" | "tools" }
  | { type: "fold.defaults"; reasoning: boolean; tools: boolean }

export const initialTranscript = (): TranscriptState => ({
  order: persistentTranscriptOrder(),
  projectionById: persistentTranscriptProjections(),
  folded: persistentTranscriptFolds(),
  foldDefaults: Object.freeze({ reasoning: false, tools: false }),
  viewport: { kind: "tail" },
  unseenEntries: 0,
  unseenItemIds: persistentTranscriptUnseenItemIds(),
  jumps: { back: [], forward: [] },
  marks: {},
})
