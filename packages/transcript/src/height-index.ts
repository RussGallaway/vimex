import type { ItemId } from "@vimex/conversation"
import type {
  TranscriptBlock,
  TranscriptBlockProjection,
  TranscriptItemBlock,
} from "./window"
import {
  appendTranscriptBlock,
  blockKey,
  isTranscriptBlockAppend,
  isTranscriptBlockReplacement,
  isTranscriptBlockSplice,
  persistentTranscriptBlockPlan,
  replaceTranscriptBlock,
} from "./window"

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
  blockAtRow(
    row: number,
    diagnostics?: HeightIndexDiagnostics,
  ): number | undefined
  /** Global rows occupied by blocks in [fromBlockIndex, toBlockIndex). */
  rowRange(
    fromBlockIndex: number,
    toBlockIndex: number,
    diagnostics?: HeightIndexDiagnostics,
  ): HeightRowRange | undefined
  /** Stable block-key lookup. */
  blockIndex(blockKey: string): number | undefined
  /** Ordered block ordinals for one logically unambiguous item. */
  itemBlockIndexes(itemId: ItemId): readonly number[] | undefined
  /** Replace one compatible height, preserving every untouched subtree. */
  replaceHeight(
    override: BlockHeightOverride,
    diagnostics?: HeightIndexDiagnostics,
  ): TranscriptHeightIndex
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
  /** Rebind one exact item span without reindexing unaffected history. */
  spliceItemBlocks?(
    blocks: readonly TranscriptBlock[],
    index: number,
    previous: readonly TranscriptBlock[],
    next: readonly TranscriptBlock[],
    rows: readonly number[],
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
  for (let index = 0; index < key.length; index++)
    hash = Math.imul(hash ^ key.charCodeAt(index), 16_777_619)
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

function mergeLookupLeaves<Value>(
  first: LookupLeaf<Value>,
  second: LookupLeaf<Value>,
  shift: number,
): LookupNode<Value> {
  const firstSlot = lookupSlot(first.hash, shift)
  const secondSlot = lookupSlot(second.hash, shift)
  const firstBit = 1 << firstSlot
  const secondBit = 1 << secondSlot
  if (firstBit === secondBit) {
    return Object.freeze({
      kind: "branch" as const,
      bitmap: firstBit,
      children: Object.freeze([mergeLookupLeaves(first, second, shift + 5)]),
    })
  }
  return Object.freeze({
    kind: "branch" as const,
    bitmap: firstBit | secondBit,
    children: Object.freeze(
      firstSlot < secondSlot ? [first, second] : [second, first],
    ),
  })
}

function lookupSet<Value>(
  node: LookupNode<Value> | undefined,
  key: string,
  value: Value,
  hash: number,
  shift = 0,
): LookupNode<Value> {
  if (!node)
    return Object.freeze({
      kind: "leaf" as const,
      hash,
      entries: Object.freeze([Object.freeze([key, value] as const)]),
    })
  if (node.kind === "leaf") {
    if (node.hash !== hash)
      return mergeLookupLeaves(
        node,
        lookupSet(undefined, key, value, hash) as LookupLeaf<Value>,
        shift,
      )
    const position = node.entries.findIndex((entry) => entry[0] === key)
    const entries = [...node.entries]
    if (position < 0) entries.push(Object.freeze([key, value] as const))
    else entries[position] = Object.freeze([key, value] as const)
    return Object.freeze({
      kind: "leaf" as const,
      hash,
      entries: Object.freeze(entries),
    })
  }
  const bit = 1 << lookupSlot(hash, shift)
  const position = lookupPosition(node.bitmap, bit)
  const children = [...node.children]
  if ((node.bitmap & bit) === 0) {
    children.splice(position, 0, lookupSet(undefined, key, value, hash))
    return Object.freeze({
      kind: "branch" as const,
      bitmap: node.bitmap | bit,
      children: Object.freeze(children),
    })
  }
  children[position] = lookupSet(
    children[position],
    key,
    value,
    hash,
    shift + 5,
  )
  return Object.freeze({
    kind: "branch" as const,
    bitmap: node.bitmap,
    children: Object.freeze(children),
  })
}

function lookupGet<Value>(
  node: LookupNode<Value> | undefined,
  key: string,
  hash: number,
  shift = 0,
): Value | undefined {
  if (!node) return undefined
  if (node.kind === "leaf")
    return node.hash === hash
      ? node.entries.find((entry) => entry[0] === key)?.[1]
      : undefined
  const bit = 1 << lookupSlot(hash, shift)
  if ((node.bitmap & bit) === 0) return undefined
  return lookupGet(
    node.children[lookupPosition(node.bitmap, bit)],
    key,
    hash,
    shift + 5,
  )
}

class PersistentLookup<Value> {
  constructor(
    private readonly base: Readonly<Record<string, Value>>,
    private readonly delta?: LookupNode<Value>,
  ) {
    Object.freeze(this)
  }

  get(key: string): Value | undefined {
    return (
      lookupGet(this.delta, key, lookupHash(key)) ??
      (Object.prototype.hasOwnProperty.call(this.base, key)
        ? this.base[key]
        : undefined)
    )
  }

  has(key: string): boolean {
    return (
      lookupGet(this.delta, key, lookupHash(key)) !== undefined ||
      Object.prototype.hasOwnProperty.call(this.base, key)
    )
  }

  set(key: string, value: Value): PersistentLookup<Value> {
    return new PersistentLookup(
      this.base,
      lookupSet(this.delta, key, value, lookupHash(key)),
    )
  }
}

function validRows(rows: number): boolean {
  return Number.isSafeInteger(rows) && rows >= 0
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
  return (
    Number.isSafeInteger(ref.from) &&
    Number.isSafeInteger(ref.to) &&
    ref.from >= 0 &&
    ref.to >= ref.from &&
    ref.to <= ref.sourceLength &&
    (ref.from !== ref.to || (ref.from === 0 && ref.sourceLength === 0))
  )
}

function validFollowingItemSpan(prior: ItemSpanRef, ref: ItemSpanRef): boolean {
  return (
    Number.isSafeInteger(ref.from) &&
    Number.isSafeInteger(ref.to) &&
    ref.from >= 0 &&
    ref.to > ref.from &&
    ref.to <= ref.sourceLength &&
    ref.projection === prior.projection &&
    ref.sourceLength === prior.sourceLength &&
    ref.from >= prior.from &&
    ref.from >= prior.to
  )
}

function visit(diagnostics: HeightIndexDiagnostics | undefined): void {
  if (diagnostics) diagnostics.nodeVisits += 1
}

function copied(diagnostics: HeightIndexDiagnostics | undefined): void {
  if (diagnostics) diagnostics.nodesCopied += 1
}

function buildNode(
  rows: readonly number[],
  from: number,
  to: number,
): HeightNode {
  if (to - from === 1)
    return Object.freeze({
      kind: "leaf" as const,
      count: 1 as const,
      height: 1 as const,
      totalRows: rows[from]!,
    })
  const middle = from + ((to - from) >>> 1)
  const left = buildNode(rows, from, middle)
  const right = buildNode(rows, middle, to)
  return Object.freeze({
    kind: "branch" as const,
    count: left.count + right.count,
    height: Math.max(left.height, right.height) + 1,
    totalRows: left.totalRows + right.totalRows,
    left,
    right,
  })
}

function heightBranch(
  left: HeightNode,
  right: HeightNode,
  diagnostics?: HeightIndexDiagnostics,
): HeightBranch {
  copied(diagnostics)
  return Object.freeze({
    kind: "branch" as const,
    count: left.count + right.count,
    height: Math.max(left.height, right.height) + 1,
    totalRows: left.totalRows + right.totalRows,
    left,
    right,
  })
}

function appendNode(
  node: HeightNode | undefined,
  rows: number,
  diagnostics?: HeightIndexDiagnostics,
): HeightNode {
  if (!node) {
    copied(diagnostics)
    return Object.freeze({
      kind: "leaf" as const,
      count: 1 as const,
      height: 1 as const,
      totalRows: rows,
    })
  }
  visit(diagnostics)
  if (node.kind === "leaf") {
    copied(diagnostics)
    const right = Object.freeze({
      kind: "leaf" as const,
      count: 1 as const,
      height: 1 as const,
      totalRows: rows,
    })
    return heightBranch(node, right, diagnostics)
  }
  const right = appendNode(node.right, rows, diagnostics)
  if (right.height <= node.left.height + 1)
    return heightBranch(node.left, right, diagnostics)
  if (right.kind !== "branch")
    return heightBranch(node.left, right, diagnostics)
  if (right.right.height >= right.left.height) {
    return heightBranch(
      heightBranch(node.left, right.left, diagnostics),
      right.right,
      diagnostics,
    )
  }
  if (right.left.kind !== "branch")
    return heightBranch(node.left, right, diagnostics)
  return heightBranch(
    heightBranch(node.left, right.left.left, diagnostics),
    heightBranch(right.left.right, right.right, diagnostics),
    diagnostics,
  )
}

function prefix(
  node: HeightNode,
  count: number,
  diagnostics: HeightIndexDiagnostics | undefined,
): number {
  visit(diagnostics)
  if (count <= 0) return 0
  if (count >= node.count) return node.totalRows
  if (node.kind === "leaf") return node.totalRows
  if (count <= node.left.count) return prefix(node.left, count, diagnostics)
  return (
    node.left.totalRows +
    prefix(node.right, count - node.left.count, diagnostics)
  )
}

function indexAtRow(
  node: HeightNode,
  row: number,
  offset: number,
  diagnostics: HeightIndexDiagnostics | undefined,
): number {
  visit(diagnostics)
  if (node.kind === "leaf") return offset
  if (row < node.left.totalRows)
    return indexAtRow(node.left, row, offset, diagnostics)
  return indexAtRow(
    node.right,
    row - node.left.totalRows,
    offset + node.left.count,
    diagnostics,
  )
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
    if (!Number.isSafeInteger(currentTotalRows - node.totalRows + rows))
      return node
    copied(diagnostics)
    return Object.freeze({
      kind: "leaf" as const,
      count: 1 as const,
      height: 1 as const,
      totalRows: rows,
    })
  }
  if (index < node.left.count) {
    const left = replaceNode(
      node.left,
      index,
      rows,
      currentTotalRows,
      diagnostics,
    )
    if (left === node.left) return node
    copied(diagnostics)
    return Object.freeze({
      kind: "branch" as const,
      count: node.count,
      height: node.height,
      totalRows: left.totalRows + node.right.totalRows,
      left,
      right: node.right,
    })
  }
  const right = replaceNode(
    node.right,
    index - node.left.count,
    rows,
    currentTotalRows,
    diagnostics,
  )
  if (right === node.right) return node
  copied(diagnostics)
  return Object.freeze({
    kind: "branch" as const,
    count: node.count,
    height: node.height,
    totalRows: node.left.totalRows + right.totalRows,
    left: node.left,
    right,
  })
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
    if (
      !Number.isInteger(blockIndex) ||
      blockIndex < 0 ||
      blockIndex > this.blockCount
    )
      return Number.NaN
    if (!this.root || blockIndex === 0) return 0
    return prefix(this.root, blockIndex, diagnostics)
  }

  blockAtRow(
    row: number,
    diagnostics?: HeightIndexDiagnostics,
  ): number | undefined {
    if (
      !this.root ||
      !Number.isInteger(row) ||
      row < 0 ||
      row >= this.totalRows
    )
      return undefined
    return indexAtRow(this.root, row, 0, diagnostics)
  }

  rowRange(
    fromBlockIndex: number,
    toBlockIndex: number,
    diagnostics?: HeightIndexDiagnostics,
  ): HeightRowRange | undefined {
    if (
      !Number.isInteger(fromBlockIndex) ||
      !Number.isInteger(toBlockIndex) ||
      fromBlockIndex < 0 ||
      toBlockIndex < fromBlockIndex ||
      toBlockIndex > this.blockCount
    )
      return undefined
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

  replaceHeight(
    override: BlockHeightOverride,
    diagnostics?: HeightIndexDiagnostics,
  ): TranscriptHeightIndex {
    if (!this.root || !validRows(override.rows)) return this
    const index = this.blockIndex(override.blockKey)
    if (
      index === undefined ||
      this.sourceBlocks[index]?.contentRevision !== override.contentRevision
    )
      return this
    const root = replaceNode(
      this.root,
      index,
      override.rows,
      this.totalRows,
      diagnostics,
    )
    if (root === this.root) return this
    return new PersistentTranscriptHeightIndex(
      root,
      this.sourceBlocks,
      this.blockCount,
      this.indexByKey,
      this.indexesByItem,
      this.lastSpanByItem,
      this.seenItems,
    )
  }

  replaceBlock(
    blocks: readonly TranscriptBlock[],
    previous: TranscriptBlock,
    next: TranscriptBlock,
    rows: number,
    diagnostics?: HeightIndexDiagnostics,
  ): TranscriptHeightIndex | undefined {
    if (
      !this.root ||
      blocks.length !== this.blockCount ||
      !validRows(rows) ||
      blockKey(previous) !== blockKey(next) ||
      previous.key.kind !== "item" ||
      next.key.kind !== "item" ||
      previous.key.blockId !== "root" ||
      next.key.blockId !== "root" ||
      previous.key.itemId !== next.key.itemId ||
      !isTranscriptBlockReplacement(this.sourceBlocks, blocks, previous, next)
    )
      return undefined
    const index = this.blockIndex(blockKey(previous))
    const itemIndexes = this.itemBlockIndexes(previous.key.itemId)
    if (
      index === undefined ||
      itemIndexes?.length !== 1 ||
      itemIndexes[0] !== index
    )
      return undefined
    if (!("projection" in next)) return undefined
    const nextSpan = itemSpanRef(next, index)
    if (!validInitialItemSpan(nextSpan)) return undefined
    const root = replaceNode(
      this.root,
      index,
      rows,
      this.totalRows,
      diagnostics,
    )
    return new PersistentTranscriptHeightIndex(
      root,
      blocks,
      this.blockCount,
      this.indexByKey,
      this.indexesByItem,
      this.lastSpanByItem.set(next.key.itemId, nextSpan),
      this.seenItems,
    )
  }

  appendBlock(
    blocks: readonly TranscriptBlock[],
    next: TranscriptBlock,
    rows: number,
    diagnostics?: HeightIndexDiagnostics,
  ): TranscriptHeightIndex | undefined {
    if (
      !validRows(rows) ||
      blocks.length !== this.blockCount + 1 ||
      blocks[this.blockCount] !== next ||
      !isTranscriptBlockAppend(this.sourceBlocks, blocks, next)
    )
      return undefined
    const key = blockKey(next)
    if (
      this.indexByKey.has(key) ||
      !Number.isSafeInteger(this.totalRows + rows)
    )
      return undefined

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
          indexesByItem = indexesByItem.set(
            itemKey,
            Object.freeze([this.blockCount]),
          )
          lastSpanByItem = lastSpanByItem.set(itemKey, span)
        }
      } else if (
        priorIndexes?.length &&
        priorSpan &&
        validFollowingItemSpan(priorSpan, span)
      ) {
        indexesByItem = indexesByItem.set(
          itemKey,
          Object.freeze([...priorIndexes, this.blockCount]),
        )
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

  spliceItemBlocks(
    blocks: readonly TranscriptBlock[],
    index: number,
    previous: readonly TranscriptBlock[],
    next: readonly TranscriptBlock[],
    rows: readonly number[],
  ): TranscriptHeightIndex | undefined {
    return spliceItemHeightIndex(
      this,
      this.sourceBlocks,
      blocks,
      index,
      previous,
      next,
      rows,
    )
  }

  supports(blocks: readonly TranscriptBlock[]): boolean {
    return blocks === this.sourceBlocks
  }
}

/**
 * A fold changes one contiguous item span. Keep the immutable old row tree and
 * translate unaffected ordinals around that span; measurements still update
 * the owning persistent tree. The overlay is compacted by a full rebuild after
 * a bounded number of structural changes.
 */
class SplicedTranscriptHeightIndex implements TranscriptHeightIndex {
  readonly blockCount: number
  readonly totalRows: number
  readonly depth: number
  private readonly beforeRows: number
  private readonly removedRows: number
  private readonly insertedPrefix: readonly number[]
  private readonly insertedByKey: ReadonlyMap<string, number>

  constructor(
    private readonly previous: TranscriptHeightIndex,
    private readonly sourceBlocks: readonly TranscriptBlock[],
    private readonly index: number,
    private readonly removed: readonly TranscriptBlock[],
    private readonly inserted: readonly TranscriptBlock[],
    private readonly rows: readonly number[],
  ) {
    this.blockCount = previous.blockCount - removed.length + inserted.length
    this.beforeRows = previous.prefixRows(index)
    this.removedRows = previous.rowRange(index, index + removed.length)!.rows
    const prefix = [0]
    for (const row of rows) prefix.push(prefix.at(-1)! + row)
    this.insertedPrefix = Object.freeze(prefix)
    this.insertedByKey = new Map(
      inserted.map((block, offset) => [blockKey(block), offset]),
    )
    this.totalRows =
      previous.totalRows - this.removedRows + this.insertedPrefix.at(-1)!
    this.depth = structuralOverlayDepth(previous) + 1
    Object.freeze(this)
  }

  private get removedCount(): number {
    return this.removed.length
  }

  prefixRows(blockIndex: number, diagnostics?: HeightIndexDiagnostics): number {
    if (
      !Number.isSafeInteger(blockIndex) ||
      blockIndex < 0 ||
      blockIndex > this.blockCount
    )
      return Number.NaN
    if (blockIndex <= this.index)
      return this.previous.prefixRows(blockIndex, diagnostics)
    const local = blockIndex - this.index
    if (local <= this.inserted.length)
      return this.beforeRows + this.insertedPrefix[local]!
    return (
      this.previous.prefixRows(
        blockIndex - this.inserted.length + this.removedCount,
        diagnostics,
      ) +
      this.insertedPrefix.at(-1)! -
      this.removedRows
    )
  }

  blockAtRow(
    row: number,
    diagnostics?: HeightIndexDiagnostics,
  ): number | undefined {
    if (!Number.isSafeInteger(row) || row < 0 || row >= this.totalRows)
      return undefined
    if (row < this.beforeRows) return this.previous.blockAtRow(row, diagnostics)
    const local = row - this.beforeRows
    if (local < this.insertedPrefix.at(-1)!) {
      let low = 0,
        high = this.inserted.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (this.insertedPrefix[middle + 1]! > local) high = middle
        else low = middle + 1
      }
      return this.index + low
    }
    const oldRow = row - this.insertedPrefix.at(-1)! + this.removedRows
    const oldIndex = this.previous.blockAtRow(oldRow, diagnostics)
    return oldIndex === undefined
      ? undefined
      : oldIndex - this.removedCount + this.inserted.length
  }

  rowRange(
    fromBlockIndex: number,
    toBlockIndex: number,
    diagnostics?: HeightIndexDiagnostics,
  ): HeightRowRange | undefined {
    if (
      !Number.isSafeInteger(fromBlockIndex) ||
      !Number.isSafeInteger(toBlockIndex) ||
      fromBlockIndex < 0 ||
      toBlockIndex < fromBlockIndex ||
      toBlockIndex > this.blockCount
    )
      return undefined
    const start = this.prefixRows(fromBlockIndex, diagnostics)
    const end = this.prefixRows(toBlockIndex, diagnostics)
    return Object.freeze({ start, end, rows: end - start })
  }

  blockIndex(key: string): number | undefined {
    const inserted = this.insertedByKey.get(key)
    if (inserted !== undefined) return this.index + inserted
    const old = this.previous.blockIndex(key)
    if (
      old === undefined ||
      (old >= this.index && old < this.index + this.removedCount)
    )
      return undefined
    return old < this.index
      ? old
      : old - this.removedCount + this.inserted.length
  }

  itemBlockIndexes(itemId: ItemId): readonly number[] | undefined {
    const first = this.inserted[0]
    if (first?.key.kind === "item" && first.key.itemId === itemId)
      return Object.freeze(
        this.inserted.map((_, offset) => this.index + offset),
      )
    const old = this.previous.itemBlockIndexes(itemId)
    if (!old) return undefined
    return Object.freeze(
      old.flatMap((ordinal) =>
        ordinal >= this.index && ordinal < this.index + this.removedCount
          ? []
          : [
              ordinal < this.index
                ? ordinal
                : ordinal - this.removedCount + this.inserted.length,
            ],
      ),
    )
  }

  replaceHeight(
    override: BlockHeightOverride,
    diagnostics?: HeightIndexDiagnostics,
  ): TranscriptHeightIndex {
    if (!validRows(override.rows)) return this
    const local = this.insertedByKey.get(override.blockKey)
    if (local !== undefined) {
      if (
        this.inserted[local]?.contentRevision !== override.contentRevision ||
        this.rows[local] === override.rows ||
        !Number.isSafeInteger(
          this.totalRows - this.rows[local]! + override.rows,
        )
      )
        return this
      const rows = [...this.rows]
      rows[local] = override.rows
      return new SplicedTranscriptHeightIndex(
        this.previous,
        this.sourceBlocks,
        this.index,
        this.removed,
        this.inserted,
        Object.freeze(rows),
      )
    }
    if (this.blockIndex(override.blockKey) === undefined) return this
    const previous = this.previous.replaceHeight(override, diagnostics)
    if (
      !Number.isSafeInteger(
        previous.totalRows - this.removedRows + this.insertedPrefix.at(-1)!,
      )
    )
      return this
    return previous === this.previous
      ? this
      : new SplicedTranscriptHeightIndex(
          previous,
          this.sourceBlocks,
          this.index,
          this.removed,
          this.inserted,
          this.rows,
        )
  }

  replaceBlock(
    blocks: readonly TranscriptBlock[],
    previous: TranscriptBlock,
    next: TranscriptBlock,
    rows: number,
  ): TranscriptHeightIndex | undefined {
    return replaceOneHeightIndex(
      this,
      this.sourceBlocks,
      blocks,
      previous,
      next,
      rows,
    )
  }

  appendBlock(
    blocks: readonly TranscriptBlock[],
    next: TranscriptBlock,
    rows: number,
  ): TranscriptHeightIndex | undefined {
    return appendOneHeightIndex(this, this.sourceBlocks, blocks, next, rows)
  }

  spliceItemBlocks(
    blocks: readonly TranscriptBlock[],
    index: number,
    previous: readonly TranscriptBlock[],
    next: readonly TranscriptBlock[],
    rows: readonly number[],
  ): TranscriptHeightIndex | undefined {
    if (rows.length !== next.length || !rows.every(validRows)) return undefined
    const oldRows = this.rowRange(index, index + previous.length)
    if (
      !oldRows ||
      !Number.isSafeInteger(
        this.totalRows - oldRows.rows + rows.reduce((sum, row) => sum + row, 0),
      )
    )
      return undefined
    if (
      index === this.index &&
      previous.length === this.inserted.length &&
      previous.every((block, offset) => block === this.inserted[offset]) &&
      next.length === this.removed.length &&
      next.every((block, offset) => block === this.removed[offset]) &&
      isTranscriptBlockSplice(this.sourceBlocks, blocks, index, previous, next)
    ) {
      let restored = this.previous
      for (let offset = 0; offset < next.length; offset++)
        restored = restored.replaceHeight({
          blockKey: blockKey(next[offset]!),
          contentRevision: next[offset]!.contentRevision,
          rows: rows[offset]!,
        })
      if (
        next.every(
          (_, offset) =>
            restored.rowRange(index + offset, index + offset + 1)?.rows ===
            rows[offset],
        )
      )
        return new RetargetedTranscriptHeightIndex(restored, blocks)
    }
    return spliceItemHeightIndex(
      this,
      this.sourceBlocks,
      blocks,
      index,
      previous,
      next,
      rows,
    )
  }

  supports(blocks: readonly TranscriptBlock[]): boolean {
    return blocks === this.sourceBlocks
  }
}

/** Rebind an exactly restored block sequence without retaining fold history. */
class RetargetedTranscriptHeightIndex implements TranscriptHeightIndex {
  readonly blockCount: number
  readonly totalRows: number
  private readonly base: TranscriptHeightIndex

  constructor(
    prior: TranscriptHeightIndex,
    private readonly sourceBlocks: readonly TranscriptBlock[],
  ) {
    this.base =
      prior instanceof RetargetedTranscriptHeightIndex ? prior.base : prior
    this.blockCount = this.base.blockCount
    this.totalRows = this.base.totalRows
    Object.freeze(this)
  }

  get structuralDepth(): number {
    return structuralOverlayDepth(this.base)
  }

  prefixRows(index: number, diagnostics?: HeightIndexDiagnostics): number {
    return this.base.prefixRows(index, diagnostics)
  }
  blockAtRow(
    row: number,
    diagnostics?: HeightIndexDiagnostics,
  ): number | undefined {
    return this.base.blockAtRow(row, diagnostics)
  }
  rowRange(
    from: number,
    to: number,
    diagnostics?: HeightIndexDiagnostics,
  ): HeightRowRange | undefined {
    return this.base.rowRange(from, to, diagnostics)
  }
  blockIndex(key: string): number | undefined {
    return this.base.blockIndex(key)
  }
  itemBlockIndexes(itemId: ItemId): readonly number[] | undefined {
    return this.base.itemBlockIndexes(itemId)
  }
  replaceHeight(
    override: BlockHeightOverride,
    diagnostics?: HeightIndexDiagnostics,
  ): TranscriptHeightIndex {
    const updated = this.base.replaceHeight(override, diagnostics)
    return updated === this.base
      ? this
      : new RetargetedTranscriptHeightIndex(updated, this.sourceBlocks)
  }
  replaceBlock(
    blocks: readonly TranscriptBlock[],
    previous: TranscriptBlock,
    next: TranscriptBlock,
    rows: number,
  ): TranscriptHeightIndex | undefined {
    return replaceOneHeightIndex(
      this,
      this.sourceBlocks,
      blocks,
      previous,
      next,
      rows,
    )
  }
  appendBlock(
    blocks: readonly TranscriptBlock[],
    next: TranscriptBlock,
    rows: number,
  ): TranscriptHeightIndex | undefined {
    return appendOneHeightIndex(this, this.sourceBlocks, blocks, next, rows)
  }
  spliceItemBlocks(
    blocks: readonly TranscriptBlock[],
    index: number,
    previous: readonly TranscriptBlock[],
    next: readonly TranscriptBlock[],
    rows: readonly number[],
  ): TranscriptHeightIndex | undefined {
    return spliceItemHeightIndex(
      this,
      this.sourceBlocks,
      blocks,
      index,
      previous,
      next,
      rows,
    )
  }
  supports(blocks: readonly TranscriptBlock[]): boolean {
    return blocks === this.sourceBlocks
  }
}

/** One stable-key revision over an indexed sequence, collapsed on repeated updates. */
class ReplacedTranscriptHeightIndex implements TranscriptHeightIndex {
  readonly blockCount: number
  readonly totalRows: number
  private readonly startRows: number
  private readonly oldRows: number

  constructor(
    private readonly previous: TranscriptHeightIndex,
    private readonly sourceBlocks: readonly TranscriptBlock[],
    private readonly ordinal: number,
    private readonly block: TranscriptBlock,
    private readonly rows: number,
  ) {
    this.blockCount = previous.blockCount
    this.startRows = previous.prefixRows(ordinal)
    this.oldRows = previous.rowRange(ordinal, ordinal + 1)!.rows
    this.totalRows = previous.totalRows - this.oldRows + rows
    Object.freeze(this)
  }

  get structuralDepth(): number {
    return structuralOverlayDepth(this.previous)
  }

  prefixRows(index: number, diagnostics?: HeightIndexDiagnostics): number {
    const rows = this.previous.prefixRows(index, diagnostics)
    return index > this.ordinal ? rows - this.oldRows + this.rows : rows
  }
  blockAtRow(
    row: number,
    diagnostics?: HeightIndexDiagnostics,
  ): number | undefined {
    if (!Number.isSafeInteger(row) || row < 0 || row >= this.totalRows)
      return undefined
    if (row < this.startRows) return this.previous.blockAtRow(row, diagnostics)
    if (row < this.startRows + this.rows) return this.ordinal
    return this.previous.blockAtRow(row - this.rows + this.oldRows, diagnostics)
  }
  rowRange(
    from: number,
    to: number,
    diagnostics?: HeightIndexDiagnostics,
  ): HeightRowRange | undefined {
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to < from ||
      to > this.blockCount
    )
      return undefined
    const start = this.prefixRows(from, diagnostics)
    const end = this.prefixRows(to, diagnostics)
    return Object.freeze({ start, end, rows: end - start })
  }
  blockIndex(key: string): number | undefined {
    return this.previous.blockIndex(key)
  }
  itemBlockIndexes(itemId: ItemId): readonly number[] | undefined {
    return this.previous.itemBlockIndexes(itemId)
  }
  replaceHeight(
    override: BlockHeightOverride,
    diagnostics?: HeightIndexDiagnostics,
  ): TranscriptHeightIndex {
    if (blockKey(this.block) === override.blockKey) {
      if (
        this.block.contentRevision !== override.contentRevision ||
        !validRows(override.rows) ||
        this.rows === override.rows ||
        !Number.isSafeInteger(this.totalRows - this.rows + override.rows)
      )
        return this
      return new ReplacedTranscriptHeightIndex(
        this.previous,
        this.sourceBlocks,
        this.ordinal,
        this.block,
        override.rows,
      )
    }
    const updated = this.previous.replaceHeight(override, diagnostics)
    if (!Number.isSafeInteger(updated.totalRows - this.oldRows + this.rows))
      return this
    return updated === this.previous
      ? this
      : new ReplacedTranscriptHeightIndex(
          updated,
          this.sourceBlocks,
          this.ordinal,
          this.block,
          this.rows,
        )
  }
  replaceBlock(
    blocks: readonly TranscriptBlock[],
    previous: TranscriptBlock,
    next: TranscriptBlock,
    rows: number,
  ): TranscriptHeightIndex | undefined {
    if (
      previous === this.block &&
      isTranscriptBlockReplacement(this.sourceBlocks, blocks, previous, next) &&
      validRows(rows) &&
      previous.key.kind === "item" &&
      next.key.kind === "item" &&
      previous.key.itemId === next.key.itemId &&
      previous.key.blockId === "root" &&
      next.key.blockId === "root" &&
      "projection" in next &&
      validInitialItemSpan(itemSpanRef(next, this.ordinal)) &&
      Number.isSafeInteger(this.previous.totalRows - this.oldRows + rows)
    )
      return new ReplacedTranscriptHeightIndex(
        this.previous,
        blocks,
        this.ordinal,
        next,
        rows,
      )
    return replaceOneHeightIndex(
      this,
      this.sourceBlocks,
      blocks,
      previous,
      next,
      rows,
    )
  }
  appendBlock(
    blocks: readonly TranscriptBlock[],
    next: TranscriptBlock,
    rows: number,
  ): TranscriptHeightIndex | undefined {
    return appendOneHeightIndex(this, this.sourceBlocks, blocks, next, rows)
  }
  spliceItemBlocks(
    blocks: readonly TranscriptBlock[],
    index: number,
    previous: readonly TranscriptBlock[],
    next: readonly TranscriptBlock[],
    rows: readonly number[],
  ): TranscriptHeightIndex | undefined {
    return spliceItemHeightIndex(
      this,
      this.sourceBlocks,
      blocks,
      index,
      previous,
      next,
      rows,
    )
  }
  supports(blocks: readonly TranscriptBlock[]): boolean {
    return blocks === this.sourceBlocks
  }
}

function replaceOneHeightIndex(
  prior: TranscriptHeightIndex,
  source: readonly TranscriptBlock[],
  blocks: readonly TranscriptBlock[],
  previous: TranscriptBlock,
  next: TranscriptBlock,
  rows: number,
): TranscriptHeightIndex | undefined {
  if (
    !validRows(rows) ||
    !isTranscriptBlockReplacement(source, blocks, previous, next) ||
    previous.key.kind !== "item" ||
    next.key.kind !== "item" ||
    previous.key.blockId !== "root" ||
    next.key.blockId !== "root" ||
    previous.key.itemId !== next.key.itemId ||
    blockKey(previous) !== blockKey(next) ||
    !("projection" in next)
  )
    return undefined
  const ordinal = prior.blockIndex(blockKey(previous))
  const itemIndexes = prior.itemBlockIndexes(previous.key.itemId)
  if (
    ordinal === undefined ||
    source[ordinal] !== previous ||
    itemIndexes?.length !== 1 ||
    itemIndexes[0] !== ordinal ||
    !validInitialItemSpan(itemSpanRef(next, ordinal)) ||
    !Number.isSafeInteger(
      prior.totalRows - prior.rowRange(ordinal, ordinal + 1)!.rows + rows,
    )
  )
    return undefined
  return new ReplacedTranscriptHeightIndex(prior, blocks, ordinal, next, rows)
}

/** A separately indexed persistent tail keeps post-fold admissions logarithmic. */
class AppendedTranscriptHeightIndex implements TranscriptHeightIndex {
  readonly blockCount: number
  readonly totalRows: number

  constructor(
    private readonly base: TranscriptHeightIndex,
    private readonly sourceBlocks: readonly TranscriptBlock[],
    private readonly suffixPlan: readonly TranscriptBlock[],
    private readonly suffixIndex: TranscriptHeightIndex,
  ) {
    this.blockCount = base.blockCount + suffixIndex.blockCount
    this.totalRows = base.totalRows + suffixIndex.totalRows
    Object.freeze(this)
  }

  get structuralDepth(): number {
    return structuralOverlayDepth(this.base)
  }

  prefixRows(index: number, diagnostics?: HeightIndexDiagnostics): number {
    if (!Number.isSafeInteger(index) || index < 0 || index > this.blockCount)
      return Number.NaN
    return index <= this.base.blockCount
      ? this.base.prefixRows(index, diagnostics)
      : this.base.totalRows +
          this.suffixIndex.prefixRows(index - this.base.blockCount, diagnostics)
  }
  blockAtRow(
    row: number,
    diagnostics?: HeightIndexDiagnostics,
  ): number | undefined {
    if (!Number.isSafeInteger(row) || row < 0 || row >= this.totalRows)
      return undefined
    if (row < this.base.totalRows) return this.base.blockAtRow(row, diagnostics)
    const suffix = this.suffixIndex.blockAtRow(
      row - this.base.totalRows,
      diagnostics,
    )
    return suffix === undefined ? undefined : this.base.blockCount + suffix
  }
  rowRange(
    from: number,
    to: number,
    diagnostics?: HeightIndexDiagnostics,
  ): HeightRowRange | undefined {
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to < from ||
      to > this.blockCount
    )
      return undefined
    const start = this.prefixRows(from, diagnostics)
    const end = this.prefixRows(to, diagnostics)
    return Object.freeze({ start, end, rows: end - start })
  }
  blockIndex(key: string): number | undefined {
    const suffix = this.suffixIndex.blockIndex(key)
    return suffix === undefined
      ? this.base.blockIndex(key)
      : this.base.blockCount + suffix
  }
  itemBlockIndexes(itemId: ItemId): readonly number[] | undefined {
    const base = this.base.itemBlockIndexes(itemId)
    const suffix = this.suffixIndex.itemBlockIndexes(itemId)
    if (base && suffix) return undefined
    return suffix
      ? Object.freeze(suffix.map((ordinal) => this.base.blockCount + ordinal))
      : base
  }
  replaceHeight(
    override: BlockHeightOverride,
    diagnostics?: HeightIndexDiagnostics,
  ): TranscriptHeightIndex {
    const suffix = this.suffixIndex.blockIndex(override.blockKey)
    if (suffix !== undefined) {
      const updated = this.suffixIndex.replaceHeight(override, diagnostics)
      if (!Number.isSafeInteger(this.base.totalRows + updated.totalRows))
        return this
      return updated === this.suffixIndex
        ? this
        : new AppendedTranscriptHeightIndex(
            this.base,
            this.sourceBlocks,
            this.suffixPlan,
            updated,
          )
    }
    const updated = this.base.replaceHeight(override, diagnostics)
    if (!Number.isSafeInteger(updated.totalRows + this.suffixIndex.totalRows))
      return this
    return updated === this.base
      ? this
      : new AppendedTranscriptHeightIndex(
          updated,
          this.sourceBlocks,
          this.suffixPlan,
          this.suffixIndex,
        )
  }
  replaceBlock(
    blocks: readonly TranscriptBlock[],
    previous: TranscriptBlock,
    next: TranscriptBlock,
    rows: number,
  ): TranscriptHeightIndex | undefined {
    if (
      !isTranscriptBlockReplacement(this.sourceBlocks, blocks, previous, next)
    )
      return undefined
    const suffixOrdinal = this.suffixIndex.blockIndex(blockKey(previous))
    if (suffixOrdinal !== undefined) {
      const replaced = replaceTranscriptBlock(
        this.suffixPlan,
        suffixOrdinal,
        previous,
        next,
      )
      const updated = replaced
        ? this.suffixIndex.replaceBlock(replaced, previous, next, rows)
        : undefined
      return replaced &&
        updated &&
        Number.isSafeInteger(this.base.totalRows + updated.totalRows)
        ? new AppendedTranscriptHeightIndex(
            this.base,
            blocks,
            replaced,
            updated,
          )
        : undefined
    }
    return replaceOneHeightIndex(
      this,
      this.sourceBlocks,
      blocks,
      previous,
      next,
      rows,
    )
  }
  appendBlock(
    blocks: readonly TranscriptBlock[],
    next: TranscriptBlock,
    rows: number,
    diagnostics?: HeightIndexDiagnostics,
  ): TranscriptHeightIndex | undefined {
    if (
      !validRows(rows) ||
      !Number.isSafeInteger(this.totalRows + rows) ||
      !isTranscriptBlockAppend(this.sourceBlocks, blocks, next) ||
      this.base.blockIndex(blockKey(next)) !== undefined ||
      (next.key.kind === "item" && this.base.itemBlockIndexes(next.key.itemId))
    )
      return undefined
    const appended = appendTranscriptBlock(this.suffixPlan, next)
    const updated = this.suffixIndex.appendBlock?.(
      appended,
      next,
      rows,
      diagnostics,
    )
    return updated
      ? new AppendedTranscriptHeightIndex(this.base, blocks, appended, updated)
      : undefined
  }
  spliceItemBlocks(
    blocks: readonly TranscriptBlock[],
    index: number,
    previous: readonly TranscriptBlock[],
    next: readonly TranscriptBlock[],
    rows: readonly number[],
  ): TranscriptHeightIndex | undefined {
    return spliceItemHeightIndex(
      this,
      this.sourceBlocks,
      blocks,
      index,
      previous,
      next,
      rows,
    )
  }
  supports(blocks: readonly TranscriptBlock[]): boolean {
    return blocks === this.sourceBlocks
  }
}

function appendOneHeightIndex(
  prior: TranscriptHeightIndex,
  source: readonly TranscriptBlock[],
  blocks: readonly TranscriptBlock[],
  next: TranscriptBlock,
  rows: number,
): TranscriptHeightIndex | undefined {
  if (
    !validRows(rows) ||
    !isTranscriptBlockAppend(source, blocks, next) ||
    prior.blockIndex(blockKey(next)) !== undefined ||
    !Number.isSafeInteger(prior.totalRows + rows) ||
    ("projection" in next &&
      !validInitialItemSpan(itemSpanRef(next, prior.blockCount))) ||
    (next.key.kind === "item" && prior.itemBlockIndexes(next.key.itemId))
  )
    return undefined
  const suffixPlan = persistentTranscriptBlockPlan(Object.freeze([next]))
  const suffixIndex = createHeightIndex(suffixPlan, [
    { blockKey: blockKey(next), contentRevision: next.contentRevision, rows },
  ])
  return suffixIndex
    ? new AppendedTranscriptHeightIndex(prior, blocks, suffixPlan, suffixIndex)
    : undefined
}

function structuralOverlayDepth(index: TranscriptHeightIndex): number {
  return index instanceof SplicedTranscriptHeightIndex
    ? index.depth
    : index instanceof RetargetedTranscriptHeightIndex ||
        index instanceof ReplacedTranscriptHeightIndex ||
        index instanceof AppendedTranscriptHeightIndex
      ? index.structuralDepth
      : 0
}

function spliceItemHeightIndex(
  prior: TranscriptHeightIndex,
  source: readonly TranscriptBlock[],
  blocks: readonly TranscriptBlock[],
  index: number,
  previous: readonly TranscriptBlock[],
  next: readonly TranscriptBlock[],
  rows: readonly number[],
): TranscriptHeightIndex | undefined {
  if (
    !isTranscriptBlockSplice(source, blocks, index, previous, next) ||
    next.length !== rows.length ||
    next.length === 0 ||
    previous.length === 0 ||
    !rows.every(validRows) ||
    !Number.isSafeInteger(
      prior.totalRows -
        prior.rowRange(index, index + previous.length)!.rows +
        rows.reduce((sum, row) => sum + row, 0),
    )
  )
    return undefined
  const first = previous[0]
  if (first?.key.kind !== "item") return undefined
  const indexes = prior.itemBlockIndexes(first.key.itemId)
  const spans = next.map((block, offset) =>
    "projection" in block ? itemSpanRef(block, index + offset) : undefined,
  )
  if (
    !indexes ||
    indexes.length !== previous.length ||
    indexes.some((ordinal, offset) => ordinal !== index + offset) ||
    previous.some((block, offset) => source[index + offset] !== block) ||
    spans.some(
      (span, offset) =>
        !span ||
        (offset === 0
          ? !validInitialItemSpan(span)
          : !validFollowingItemSpan(spans[offset - 1]!, span)),
    ) ||
    new Set(next.map(blockKey)).size !== next.length ||
    next.some((block) => {
      const old = prior.blockIndex(blockKey(block))
      return (
        old !== undefined && (old < index || old >= index + previous.length)
      )
    }) ||
    structuralOverlayDepth(prior) >= 128
  )
    return undefined
  return new SplicedTranscriptHeightIndex(
    prior,
    blocks,
    index,
    previous,
    next,
    Object.freeze([...rows]),
  )
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
  for (const override of overrides)
    if (validRows(override.rows))
      overridesByKey.set(override.blockKey, override)

  const rows: number[] = []
  const indexByKey: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >
  const spanRefsByItem: Record<string, ItemSpanRef[]> = Object.create(
    null,
  ) as Record<string, ItemSpanRef[]>
  const seenItems: Record<string, boolean> = Object.create(null) as Record<
    string,
    boolean
  >
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
    const estimated =
      validRows(block.estimatedRows) && block.estimatedRows > 0
        ? block.estimatedRows
        : 1
    const override = overridesByKey.get(key)
    let height =
      override?.contentRevision === block.contentRevision
        ? override.rows
        : estimated
    if (!Number.isSafeInteger(totalRows + height)) height = estimated
    if (!Number.isSafeInteger(totalRows + height)) height = 1
    if (!Number.isSafeInteger(totalRows + height)) return undefined
    totalRows += height
    rows.push(height)
  }
  const indexesByItem: Record<string, readonly number[]> = Object.create(
    null,
  ) as Record<string, readonly number[]>
  const lastSpanByItem: Record<string, ItemSpanRef> = Object.create(
    null,
  ) as Record<string, ItemSpanRef>
  for (const [itemId, refs] of Object.entries(spanRefsByItem)) {
    let supported = refs.length > 0
    for (let index = 0; supported && index < refs.length; index++) {
      const ref = refs[index]!
      const prior = refs[index - 1]
      supported =
        Number.isSafeInteger(ref.from) &&
        Number.isSafeInteger(ref.to) &&
        ref.from >= 0 &&
        ref.to >= ref.from &&
        ref.to <= ref.sourceLength &&
        (!prior ||
          (ref.projection === prior.projection &&
            ref.sourceLength === prior.sourceLength &&
            ref.from >= prior.from &&
            ref.from >= prior.to)) &&
        (ref.from !== ref.to ||
          (refs.length === 1 && ref.from === 0 && ref.sourceLength === 0))
    }
    if (supported) {
      indexesByItem[itemId] = Object.freeze(refs.map((ref) => ref.index))
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
