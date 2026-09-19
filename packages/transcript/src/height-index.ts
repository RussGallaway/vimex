import type { ItemId } from "@vimex/conversation"
import type { TranscriptBlock, TranscriptBlockProjection } from "./window"
import { blockKey } from "./window"

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
  /** O(1) compatibility check for the exact complete-plan snapshot indexed at construction. */
  supports(blocks: readonly TranscriptBlock[]): boolean
}

interface HeightLeaf {
  readonly kind: "leaf"
  readonly count: 1
  readonly totalRows: number
}

interface HeightBranch {
  readonly kind: "branch"
  readonly count: number
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

function validRows(rows: number): boolean {
  return Number.isSafeInteger(rows) && rows >= 1
}

function visit(diagnostics: HeightIndexDiagnostics | undefined): void {
  if (diagnostics) diagnostics.nodeVisits += 1
}

function copied(diagnostics: HeightIndexDiagnostics | undefined): void {
  if (diagnostics) diagnostics.nodesCopied += 1
}

function buildNode(rows: readonly number[], from: number, to: number): HeightNode {
  if (to - from === 1) return Object.freeze({ kind: "leaf" as const, count: 1 as const, totalRows: rows[from]! })
  const middle = from + ((to - from) >>> 1)
  const left = buildNode(rows, from, middle)
  const right = buildNode(rows, middle, to)
  return Object.freeze({ kind: "branch" as const, count: left.count + right.count, totalRows: left.totalRows + right.totalRows, left, right })
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
    return Object.freeze({ kind: "leaf" as const, count: 1 as const, totalRows: rows })
  }
  if (index < node.left.count) {
    const left = replaceNode(node.left, index, rows, currentTotalRows, diagnostics)
    if (left === node.left) return node
    copied(diagnostics)
    return Object.freeze({ kind: "branch" as const, count: node.count, totalRows: left.totalRows + node.right.totalRows, left, right: node.right })
  }
  const right = replaceNode(node.right, index - node.left.count, rows, currentTotalRows, diagnostics)
  if (right === node.right) return node
  copied(diagnostics)
  return Object.freeze({ kind: "branch" as const, count: node.count, totalRows: node.left.totalRows + right.totalRows, left: node.left, right })
}

class PersistentTranscriptHeightIndex implements TranscriptHeightIndex {
  readonly blockCount: number
  readonly totalRows: number

  constructor(
    private readonly root: HeightNode | undefined,
    private readonly sourceBlocks: readonly TranscriptBlock[],
    private readonly blockKeys: readonly string[],
    private readonly contentRevisions: readonly number[],
    private readonly indexByKey: Readonly<Record<string, number>>,
    private readonly indexesByItem: Readonly<Record<string, readonly number[]>>,
  ) {
    this.blockCount = blockKeys.length
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
    const index = this.indexByKey[key]
    return index === undefined ? undefined : index
  }

  itemBlockIndexes(itemId: ItemId): readonly number[] | undefined {
    return this.indexesByItem[itemId]
  }

  replaceHeight(override: BlockHeightOverride, diagnostics?: HeightIndexDiagnostics): TranscriptHeightIndex {
    if (!this.root || !validRows(override.rows)) return this
    const index = this.blockIndex(override.blockKey)
    if (index === undefined || this.contentRevisions[index] !== override.contentRevision) return this
    const root = replaceNode(this.root, index, override.rows, this.totalRows, diagnostics)
    if (root === this.root) return this
    return new PersistentTranscriptHeightIndex(root, this.sourceBlocks, this.blockKeys, this.contentRevisions, this.indexByKey, this.indexesByItem)
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

  const keys: string[] = []
  const revisions: number[] = []
  const rows: number[] = []
  const indexByKey: Record<string, number> = Object.create(null) as Record<string, number>
  const spanRefsByItem: Record<string, ItemSpanRef[]> = Object.create(null) as Record<string, ItemSpanRef[]>
  let totalRows = 0
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!
    const key = blockKey(block)
    if (indexByKey[key] !== undefined) return undefined
    indexByKey[key] = index
    keys.push(key)
    revisions.push(block.contentRevision)
    if ("projection" in block) (spanRefsByItem[block.key.itemId] ??= []).push(Object.freeze({
      index,
      from: block.sourceSpan.from,
      to: block.sourceSpan.to,
      sourceLength: block.projection.source.length,
      projection: block.projection,
    }))
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
    if (supported) indexesByItem[itemId] = Object.freeze(refs.map(ref => ref.index))
  }
  const root = rows.length ? buildNode(rows, 0, rows.length) : undefined
  return new PersistentTranscriptHeightIndex(
    root,
    blocks,
    Object.freeze(keys),
    Object.freeze(revisions),
    Object.freeze(indexByKey),
    Object.freeze(indexesByItem),
  )
}
