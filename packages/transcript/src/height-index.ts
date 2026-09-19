import type { ItemId } from "@vimex/conversation"
import type { TranscriptBlock, TranscriptBlockProjection, TranscriptItemBlock } from "./window"
import { blockKey, isTranscriptBlockAppend, isTranscriptBlockReplacement } from "./window"

/** A measured height is usable only for the exact block revision it describes. */
export interface BlockHeightOverride {
  readonly blockKey: string
  readonly contentRevision: number
  readonly rows: number
}

/** Optional deterministic counters for tests and diagnostic benchmarks. */
export interface HeightIndexDiagnostics {
  nodeVisits: number
  nodesCopied: number
}

/** Global half-open row range occupied by a half-open block range. */
export interface HeightRowRange {
  readonly start: number
  readonly end: number
  readonly rows: number
}

/**
 * Immutable renderer-neutral row index. Implementations are deliberately
 * hidden so callers cannot depend on, or mutate, the persistent tree.
 */
export interface TranscriptHeightIndex {
  readonly blockCount: number
  readonly totalRows: number
  /** Rows occupied by blocks in [0, blockIndex). Accepts blockCount. */
  prefixRows(blockIndex: number, diagnostics?: HeightIndexDiagnostics): number
  /** Block ordinal containing the global row. */
  blockAtRow(row: number, diagnostics?: HeightIndexDiagnostics): number | undefined
  /** Global rows occupied by blocks in [fromBlockIndex, toBlockIndex). */
  rowRange(fromBlockIndex: number, toBlockIndex: number, diagnostics?: HeightIndexDiagnostics): HeightRowRange | undefined
  /** Stable block-key lookup. */
  blockIndex(blockKey: string): number | undefined
  /** Ordered block ordinals for one logically unambiguous item. */
  itemBlockIndexes(itemId: ItemId): readonly number[] | undefined
  /** Replace one compatible height, preserving every untouched subtree. */
  replaceHeight(override: BlockHeightOverride, diagnostics?: HeightIndexDiagnostics): TranscriptHeightIndex
  /** Rebind one stable-key block revision and invalidate its prior measured height. */
  replaceBlock(
    blocks: readonly TranscriptBlock[],
    previous: TranscriptBlock,
    next: TranscriptBlock,
    rows: number,
    diagnostics?: HeightIndexDiagnostics,
  ): TranscriptHeightIndex | undefined
  /** Extend the exact indexed plan by one block without rebuilding history. */
  appendBlock?(
    blocks: readonly TranscriptBlock[],
    next: TranscriptBlock,
    rows: number,
    diagnostics?: HeightIndexDiagnostics,
  ): TranscriptHeightIndex | undefined
  /** O(1) compatibility check for the exact complete-plan snapshot indexed at construction. */
  supports(blocks: readonly TranscriptBlock[]): boolean
}

interface HeightLeaf {
  readonly kind: "leaf"
  readonly count: 1
  readonly height: 1
  readonly totalRows: number
}

interface HeightBranch {
  readonly kind: "branch"
  readonly count: number
  readonly height: number
  readonly totalRows: number
  readonly left: HeightNode
  readonly right: HeightNode
}

type HeightNode = HeightLeaf | HeightBranch

interface ItemSpanRef {
  readonly index: number
  readonly from: number
  readonly to: number
  readonly sourceLength: number
  readonly projection: TranscriptBlockProjection
}

interface LookupLeaf<Value> {
  readonly kind: "leaf"
  readonly hash: number
  readonly entries: readonly (readonly [string, Value])[]
}

interface LookupBranch<Value> {
  readonly kind: "branch"
  readonly bitmap: number
  readonly children: readonly LookupNode<Value>[]
}

type LookupNode<Value> = LookupLeaf<Value> | LookupBranch<Value>

function lookupHash(key: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16_777_619)
  return hash >>> 0
}

function popcount(value: number): number {
  value >>>= 0
  value -= (value >>> 1) & 0x55555555
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333)
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

function lookupSlot(hash: number, shift: number): number {
  return (hash >>> shift) & 31
}

function lookupPosition(bitmap: number, bit: number): number {
  return popcount(bitmap & (bit - 1))
}

function mergeLookupLeaves<Value>(first: LookupLeaf<Value>, second: LookupLeaf<Value>, shift: number): LookupNode<Value> {
  const firstSlot = lookupSlot(first.hash, shift)
  const secondSlot = lookupSlot(second.hash, shift)
  const firstBit = 1 << firstSlot
  const secondBit = 1 << secondSlot
  if (firstBit === secondBit) {
    return Object.freeze({ kind: "branch" as const, bitmap: firstBit,
      children: Object.freeze([mergeLookupLeaves(first, second, shift + 5)]) })
  }
  return Object.freeze({ kind: "branch" as const, bitmap: firstBit | secondBit,
    children: Object.freeze(firstSlot < secondSlot ? [first, second] : [second, first]) })
}

function lookupSet<Value>(node: LookupNode<Value> | undefined, key: string, value: Value, hash: number, shift = 0): LookupNode<Value> {
  if (!node) return Object.freeze({ kind: "leaf" as const, hash, entries: Object.freeze([Object.freeze([key, value] as const)]) })
  if (node.kind === "leaf") {
    if (node.hash !== hash) return mergeLookupLeaves(node, lookupSet(undefined, key, value, hash) as LookupLeaf<Value>, shift)
    const position = node.entries.findIndex(entry => entry[0] === key)
    const entries = [...node.entries]
    if (position < 0) entries.push(Object.freeze([key, value] as const))
    else entries[position] = Object.freeze([key, value] as const)
    return Object.freeze({ kind: "leaf" as const, hash, entries: Object.freeze(entries) })
  }
  const bit = 1 << lookupSlot(hash, shift)
  const position = lookupPosition(node.bitmap, bit)
  const children = [...node.children]
  if ((node.bitmap & bit) === 0) {
    children.splice(position, 0, lookupSet(undefined, key, value, hash))
    return Object.freeze({ kind: "branch" as const, bitmap: node.bitmap | bit, children: Object.freeze(children) })
  }
  children[position] = lookupSet(children[position], key, value, hash, shift + 5)
  return Object.freeze({ kind: "branch" as const, bitmap: node.bitmap, children: Object.freeze(children) })
}

function lookupGet<Value>(node: LookupNode<Value> | undefined, key: string, hash: number, shift = 0): Value | undefined {
  if (!node) return undefined
  if (node.kind === "leaf") return node.hash === hash ? node.entries.find(entry => entry[0] === key)?.[1] : undefined
  const bit = 1 << lookupSlot(hash, shift)
  if ((node.bitmap & bit) === 0) return undefined
  return lookupGet(node.children[lookupPosition(node.bitmap, bit)], key, hash, shift + 5)
}

class PersistentLookup<Value> {
  constructor(
    private readonly base: Readonly<Record<string, Value>>,
    private readonly delta?: LookupNode<Value>,
  ) { Object.freeze(this) }

  get(key: string): Value | undefined {
    return lookupGet(this.delta, key, lookupHash(key))
      ?? (Object.prototype.hasOwnProperty.call(this.base, key) ? this.base[key] : undefined)
  }

  has(key: string): boolean {
    return lookupGet(this.delta, key, lookupHash(key)) !== undefined || Object.prototype.hasOwnProperty.call(this.base, key)
  }

  set(key: string, value: Value): PersistentLookup<Value> {
    return new PersistentLookup(this.base, lookupSet(this.delta, key, value, lookupHash(key)))
  }
}

function validRows(rows: number): boolean {
  return Number.isSafeInteger(rows) && rows >= 1
}

function itemSpanRef(block: TranscriptItemBlock, index: number): ItemSpanRef {
  return Object.freeze({
    index,
    from: block.sourceSpan.from,
    to: block.sourceSpan.to,
    sourceLength: block.projection.source.length,
    projection: block.projection,
  })
}

function validInitialItemSpan(ref: ItemSpanRef): boolean {
  return Number.isSafeInteger(ref.from) && Number.isSafeInteger(ref.to)
    && ref.from >= 0 && ref.to >= ref.from && ref.to <= ref.sourceLength
    && (ref.from !== ref.to || (ref.from === 0 && ref.sourceLength === 0))
}

function validFollowingItemSpan(prior: ItemSpanRef, ref: ItemSpanRef): boolean {
  return Number.isSafeInteger(ref.from) && Number.isSafeInteger(ref.to)
    && ref.from >= 0 && ref.to > ref.from && ref.to <= ref.sourceLength
    && ref.projection === prior.projection && ref.sourceLength === prior.sourceLength
    && ref.from >= prior.from && ref.from >= prior.to
}

function visit(diagnostics: HeightIndexDiagnostics | undefined): void {
  if (diagnostics) diagnostics.nodeVisits += 1
}

function copied(diagnostics: HeightIndexDiagnostics | undefined): void {
  if (diagnostics) diagnostics.nodesCopied += 1
}

function buildNode(rows: readonly number[], from: number, to: number): HeightNode {
  if (to - from === 1) return Object.freeze({ kind: "leaf" as const, count: 1 as const, height: 1 as const, totalRows: rows[from]! })
  const middle = from + ((to - from) >>> 1)
  const left = buildNode(rows, from, middle)
  const right = buildNode(rows, middle, to)
  return Object.freeze({ kind: "branch" as const, count: left.count + right.count, height: Math.max(left.height, right.height) + 1,
    totalRows: left.totalRows + right.totalRows, left, right })
}

function heightBranch(left: HeightNode, right: HeightNode, diagnostics?: HeightIndexDiagnostics): HeightBranch {
  copied(diagnostics)
  return Object.freeze({ kind: "branch" as const, count: left.count + right.count, height: Math.max(left.height, right.height) + 1,
    totalRows: left.totalRows + right.totalRows, left, right })
}

function appendNode(node: HeightNode | undefined, rows: number, diagnostics?: HeightIndexDiagnostics): HeightNode {
  if (!node) {
    copied(diagnostics)
    return Object.freeze({ kind: "leaf" as const, count: 1 as const, height: 1 as const, totalRows: rows })
  }
  visit(diagnostics)
  if (node.kind === "leaf") {
    copied(diagnostics)
    const right = Object.freeze({ kind: "leaf" as const, count: 1 as const, height: 1 as const, totalRows: rows })
    return heightBranch(node, right, diagnostics)
  }
  const right = appendNode(node.right, rows, diagnostics)
  if (right.height <= node.left.height + 1) return heightBranch(node.left, right, diagnostics)
  if (right.kind !== "branch") return heightBranch(node.left, right, diagnostics)
  if (right.right.height >= right.left.height) {
    return heightBranch(heightBranch(node.left, right.left, diagnostics), right.right, diagnostics)
  }
  if (right.left.kind !== "branch") return heightBranch(node.left, right, diagnostics)
  return heightBranch(
    heightBranch(node.left, right.left.left, diagnostics),
    heightBranch(right.left.right, right.right, diagnostics),
    diagnostics,
  )
}

function prefix(node: HeightNode, count: number, diagnostics: HeightIndexDiagnostics | undefined): number {
  visit(diagnostics)
  if (count <= 0) return 0
  if (count >= node.count) return node.totalRows
  if (node.kind === "leaf") return node.totalRows
  if (count <= node.left.count) return prefix(node.left, count, diagnostics)
  return node.left.totalRows + prefix(node.right, count - node.left.count, diagnostics)
}

function indexAtRow(node: HeightNode, row: number, offset: number, diagnostics: HeightIndexDiagnostics | undefined): number {
  visit(diagnostics)
  if (node.kind === "leaf") return offset
  if (row < node.left.totalRows) return indexAtRow(node.left, row, offset, diagnostics)
  return indexAtRow(node.right, row - node.left.totalRows, offset + node.left.count, diagnostics)
}

function replaceNode(
  node: HeightNode,
  index: number,
  rows: number,
  currentTotalRows: number,
  diagnostics: HeightIndexDiagnostics | undefined,
): HeightNode {
  visit(diagnostics)
  if (node.kind === "leaf") {
    if (node.totalRows === rows) return node
    if (!Number.isSafeInteger(currentTotalRows - node.totalRows + rows)) return node
    copied(diagnostics)
    return Object.freeze({ kind: "leaf" as const, count: 1 as const, height: 1 as const, totalRows: rows })
  }
  if (index < node.left.count) {
    const left = replaceNode(node.left, index, rows, currentTotalRows, diagnostics)
    if (left === node.left) return node
    copied(diagnostics)
    return Object.freeze({ kind: "branch" as const, count: node.count, height: node.height,
      totalRows: left.totalRows + node.right.totalRows, left, right: node.right })
  }
  const right = replaceNode(node.right, index - node.left.count, rows, currentTotalRows, diagnostics)
  if (right === node.right) return node
  copied(diagnostics)
  return Object.freeze({ kind: "branch" as const, count: node.count, height: node.height,
    totalRows: node.left.totalRows + right.totalRows, left: node.left, right })
}

class PersistentTranscriptHeightIndex implements TranscriptHeightIndex {
  readonly blockCount: number
  readonly totalRows: number

  constructor(
    private readonly root: HeightNode | undefined,
    private readonly sourceBlocks: readonly TranscriptBlock[],
    blockCount: number,
    private readonly indexByKey: PersistentLookup<number>,
    private readonly indexesByItem: PersistentLookup<readonly number[]>,
    private readonly lastSpanByItem: PersistentLookup<ItemSpanRef>,
    private readonly seenItems: PersistentLookup<boolean>,
  ) {
    this.blockCount = blockCount
    this.totalRows = root?.totalRows ?? 0
    Object.freeze(this)
  }

  prefixRows(blockIndex: number, diagnostics?: HeightIndexDiagnostics): number {
    if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex > this.blockCount) return Number.NaN
    if (!this.root || blockIndex === 0) return 0
    return prefix(this.root, blockIndex, diagnostics)
  }

  blockAtRow(row: number, diagnostics?: HeightIndexDiagnostics): number | undefined {
    if (!this.root || !Number.isInteger(row) || row < 0 || row >= this.totalRows) return undefined
    return indexAtRow(this.root, row, 0, diagnostics)
  }

  rowRange(fromBlockIndex: number, toBlockIndex: number, diagnostics?: HeightIndexDiagnostics): HeightRowRange | undefined {
    if (!Number.isInteger(fromBlockIndex) || !Number.isInteger(toBlockIndex)
      || fromBlockIndex < 0 || toBlockIndex < fromBlockIndex || toBlockIndex > this.blockCount) return undefined
    const start = this.prefixRows(fromBlockIndex, diagnostics)!
    const end = this.prefixRows(toBlockIndex, diagnostics)!
    return Object.freeze({ start, end, rows: end - start })
  }

  blockIndex(key: string): number | undefined {
    return this.indexByKey.get(key)
  }

  itemBlockIndexes(itemId: ItemId): readonly number[] | undefined {
    const indexes = this.indexesByItem.get(itemId)
    return indexes?.length ? indexes : undefined
  }

  replaceHeight(override: BlockHeightOverride, diagnostics?: HeightIndexDiagnostics): TranscriptHeightIndex {
    if (!this.root || !validRows(override.rows)) return this
    const index = this.blockIndex(override.blockKey)
    if (index === undefined || this.sourceBlocks[index]?.contentRevision !== override.contentRevision) return this
    const root = replaceNode(this.root, index, override.rows, this.totalRows, diagnostics)
    if (root === this.root) return this
    return new PersistentTranscriptHeightIndex(root, this.sourceBlocks, this.blockCount, this.indexByKey, this.indexesByItem,
      this.lastSpanByItem, this.seenItems)
  }

  replaceBlock(
    blocks: readonly TranscriptBlock[],
    previous: TranscriptBlock,
    next: TranscriptBlock,
    rows: number,
    diagnostics?: HeightIndexDiagnostics,
  ): TranscriptHeightIndex | undefined {
    if (!this.root || blocks.length !== this.blockCount || !validRows(rows) || blockKey(previous) !== blockKey(next)
      || previous.key.kind !== "item" || next.key.kind !== "item"
      || previous.key.blockId !== "root" || next.key.blockId !== "root"
      || previous.key.itemId !== next.key.itemId
      || !isTranscriptBlockReplacement(this.sourceBlocks, blocks, previous, next)) return undefined
    const index = this.blockIndex(blockKey(previous))
    const itemIndexes = this.itemBlockIndexes(previous.key.itemId)
    if (index === undefined || itemIndexes?.length !== 1 || itemIndexes[0] !== index) return undefined
    if (!("projection" in next)) return undefined
    const nextSpan = itemSpanRef(next, index)
    if (!validInitialItemSpan(nextSpan)) return undefined
    const root = replaceNode(this.root, index, rows, this.totalRows, diagnostics)
    return new PersistentTranscriptHeightIndex(root, blocks, this.blockCount, this.indexByKey, this.indexesByItem,
      this.lastSpanByItem.set(next.key.itemId, nextSpan), this.seenItems)
  }

  appendBlock(
    blocks: readonly TranscriptBlock[],
    next: TranscriptBlock,
    rows: number,
    diagnostics?: HeightIndexDiagnostics,
  ): TranscriptHeightIndex | undefined {
    if (!validRows(rows) || blocks.length !== this.blockCount + 1 || blocks[this.blockCount] !== next
      || !isTranscriptBlockAppend(this.sourceBlocks, blocks, next)) return undefined
    const key = blockKey(next)
    if (this.indexByKey.has(key) || !Number.isSafeInteger(this.totalRows + rows)) return undefined

    let indexesByItem = this.indexesByItem
    let lastSpanByItem = this.lastSpanByItem
    let seenItems = this.seenItems
    if ("projection" in next) {
      const itemKey = next.key.itemId
      const priorIndexes = indexesByItem.get(itemKey)
      const priorSpan = lastSpanByItem.get(itemKey)
      const span = itemSpanRef(next, this.blockCount)
      if (!seenItems.has(itemKey)) {
        if (validInitialItemSpan(span)) {
          indexesByItem = indexesByItem.set(itemKey, Object.freeze([this.blockCount]))
          lastSpanByItem = lastSpanByItem.set(itemKey, span)
        }
      } else if (priorIndexes?.length && priorSpan && validFollowingItemSpan(priorSpan, span)) {
        indexesByItem = indexesByItem.set(itemKey, Object.freeze([...priorIndexes, this.blockCount]))
        lastSpanByItem = lastSpanByItem.set(itemKey, span)
      } else {
        indexesByItem = indexesByItem.set(itemKey, Object.freeze([]))
      }
      seenItems = seenItems.set(itemKey, true)
    }

    return new PersistentTranscriptHeightIndex(
      appendNode(this.root, rows, diagnostics),
      blocks,
      this.blockCount + 1,
      this.indexByKey.set(key, this.blockCount),
      indexesByItem,
      lastSpanByItem,
      seenItems,
    )
  }

  supports(blocks: readonly TranscriptBlock[]): boolean {
    return blocks === this.sourceBlocks
  }
}

/**
 * Build an exact-order height index. Duplicate stable keys or an unrepresentable
 * total return undefined so a caller can select the full pass-through/rebuild
 * path. Unknown, stale, or invalid overrides fall back to the block estimate.
 */
export function createHeightIndex(
  blocks: readonly TranscriptBlock[],
  overrides: readonly BlockHeightOverride[] = [],
): TranscriptHeightIndex | undefined {
  const overridesByKey = new Map<string, BlockHeightOverride>()
  for (const override of overrides) if (validRows(override.rows)) overridesByKey.set(override.blockKey, override)

  const rows: number[] = []
  const indexByKey: Record<string, number> = Object.create(null) as Record<string, number>
  const spanRefsByItem: Record<string, ItemSpanRef[]> = Object.create(null) as Record<string, ItemSpanRef[]>
  const seenItems: Record<string, boolean> = Object.create(null) as Record<string, boolean>
  let totalRows = 0
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!
    const key = blockKey(block)
    if (indexByKey[key] !== undefined) return undefined
    indexByKey[key] = index
    if ("projection" in block) {
      seenItems[block.key.itemId] = true
      ;(spanRefsByItem[block.key.itemId] ??= []).push(itemSpanRef(block, index))
    }
    const estimated = validRows(block.estimatedRows) ? block.estimatedRows : 1
    const override = overridesByKey.get(key)
    let height = override?.contentRevision === block.contentRevision ? override.rows : estimated
    if (!Number.isSafeInteger(totalRows + height)) height = estimated
    if (!Number.isSafeInteger(totalRows + height)) height = 1
    if (!Number.isSafeInteger(totalRows + height)) return undefined
    totalRows += height
    rows.push(height)
  }
  const indexesByItem: Record<string, readonly number[]> = Object.create(null) as Record<string, readonly number[]>
  const lastSpanByItem: Record<string, ItemSpanRef> = Object.create(null) as Record<string, ItemSpanRef>
  for (const [itemId, refs] of Object.entries(spanRefsByItem)) {
    let supported = refs.length > 0
    for (let index = 0; supported && index < refs.length; index++) {
      const ref = refs[index]!
      const prior = refs[index - 1]
      supported = Number.isSafeInteger(ref.from) && Number.isSafeInteger(ref.to)
        && ref.from >= 0 && ref.to >= ref.from && ref.to <= ref.sourceLength
        && (!prior || (ref.projection === prior.projection && ref.sourceLength === prior.sourceLength
          && ref.from >= prior.from && ref.from >= prior.to))
        && (ref.from !== ref.to || (refs.length === 1 && ref.from === 0 && ref.sourceLength === 0))
    }
    if (supported) {
      indexesByItem[itemId] = Object.freeze(refs.map(ref => ref.index))
      lastSpanByItem[itemId] = refs.at(-1)!
    }
  }
  const root = rows.length ? buildNode(rows, 0, rows.length) : undefined
  return new PersistentTranscriptHeightIndex(
    root,
    blocks,
    blocks.length,
    new PersistentLookup(Object.freeze(indexByKey)),
    new PersistentLookup(Object.freeze(indexesByItem)),
    new PersistentLookup(Object.freeze(lastSpanByItem)),
    new PersistentLookup(Object.freeze(seenItems)),
  )
}
