import type {
  TranscriptBlock,
  TranscriptItemBlock,
  TranscriptBlockPlanDiagnostics,
} from "./types"
import { blockKey } from "./addressing"

interface BlockPlanLeaf {
  readonly kind: "leaf"
  readonly count: 1
  readonly height: 1
  readonly block: TranscriptBlock
}

interface BlockPlanBranch {
  readonly kind: "branch"
  readonly count: number
  readonly height: number
  readonly left: BlockPlanNode
  readonly right: BlockPlanNode
}

type BlockPlanNode = BlockPlanLeaf | BlockPlanBranch

interface BlockPlanReplacement {
  readonly source: readonly TranscriptBlock[]
  readonly index: number
  readonly previous: TranscriptBlock
  readonly next: TranscriptBlock
}

interface BlockPlanAppend {
  readonly source: readonly TranscriptBlock[]
  readonly next: TranscriptBlock
}

interface BlockPlanSplice {
  readonly source: readonly TranscriptBlock[]
  readonly index: number
  readonly previous: readonly TranscriptBlock[]
  readonly next: readonly TranscriptBlock[]
}

interface BlockPlanData {
  readonly root?: BlockPlanNode
  readonly length: number
  readonly replacement?: BlockPlanReplacement
  readonly append?: BlockPlanAppend
  readonly splice?: BlockPlanSplice
  readonly tailReplacement?: Readonly<{
    source: readonly TranscriptBlock[]
    previous: TranscriptItemBlock
    next?: TranscriptItemBlock
  }>
}

const blockPlanData = new WeakMap<object, BlockPlanData>()
const normalizedBlockPlans = new WeakMap<object, readonly TranscriptBlock[]>()

function buildBlockPlan(
  values: readonly TranscriptBlock[],
  from: number,
  to: number,
): BlockPlanNode | undefined {
  if (from >= to) return undefined
  if (to - from === 1)
    return Object.freeze({
      kind: "leaf" as const,
      count: 1 as const,
      height: 1 as const,
      block: values[from]!,
    })
  const middle = from + ((to - from) >>> 1)
  const left = buildBlockPlan(values, from, middle)!
  const right = buildBlockPlan(values, middle, to)!
  return Object.freeze({
    kind: "branch" as const,
    count: left.count + right.count,
    height: Math.max(left.height, right.height) + 1,
    left,
    right,
  })
}

function copiedBlockPlanNode(
  diagnostics: TranscriptBlockPlanDiagnostics | undefined,
): void {
  if (diagnostics) diagnostics.blockPlanNodesCopied += 1
}

function blockPlanBranch(
  left: BlockPlanNode,
  right: BlockPlanNode,
  diagnostics?: TranscriptBlockPlanDiagnostics,
): BlockPlanBranch {
  copiedBlockPlanNode(diagnostics)
  return Object.freeze({
    kind: "branch" as const,
    count: left.count + right.count,
    height: Math.max(left.height, right.height) + 1,
    left,
    right,
  })
}

function joinBlockPlanNodes(
  left: BlockPlanNode | undefined,
  right: BlockPlanNode | undefined,
  diagnostics?: TranscriptBlockPlanDiagnostics,
): BlockPlanNode | undefined {
  if (!left) return right
  if (!right) return left
  if (left.height > right.height + 1 && left.kind === "branch") {
    const joined = joinBlockPlanNodes(left.right, right, diagnostics)!
    if (left.left.height >= joined.height - 1)
      return blockPlanBranch(left.left, joined, diagnostics)
    if (joined.kind !== "branch")
      return blockPlanBranch(left.left, joined, diagnostics)
    if (joined.right.height >= joined.left.height)
      return blockPlanBranch(
        blockPlanBranch(left.left, joined.left, diagnostics),
        joined.right,
        diagnostics,
      )
    if (joined.left.kind !== "branch")
      return blockPlanBranch(left.left, joined, diagnostics)
    return blockPlanBranch(
      blockPlanBranch(left.left, joined.left.left, diagnostics),
      blockPlanBranch(joined.left.right, joined.right, diagnostics),
      diagnostics,
    )
  }
  if (right.height > left.height + 1 && right.kind === "branch") {
    const joined = joinBlockPlanNodes(left, right.left, diagnostics)!
    if (right.right.height >= joined.height - 1)
      return blockPlanBranch(joined, right.right, diagnostics)
    if (joined.kind !== "branch")
      return blockPlanBranch(joined, right.right, diagnostics)
    if (joined.left.height >= joined.right.height)
      return blockPlanBranch(
        joined.left,
        blockPlanBranch(joined.right, right.right, diagnostics),
        diagnostics,
      )
    if (joined.right.kind !== "branch")
      return blockPlanBranch(joined, right.right, diagnostics)
    return blockPlanBranch(
      blockPlanBranch(joined.left, joined.right.left, diagnostics),
      blockPlanBranch(joined.right.right, right.right, diagnostics),
      diagnostics,
    )
  }
  return blockPlanBranch(left, right, diagnostics)
}

function splitBlockPlanNode(
  node: BlockPlanNode | undefined,
  count: number,
  diagnostics?: TranscriptBlockPlanDiagnostics,
): readonly [BlockPlanNode | undefined, BlockPlanNode | undefined] {
  if (!node) return [undefined, undefined]
  if (count <= 0) return [undefined, node]
  if (count >= node.count) return [node, undefined]
  if (diagnostics) diagnostics.blockPlanNodeVisits += 1
  if (node.kind === "leaf") return [undefined, node]
  if (count < node.left.count) {
    const [left, right] = splitBlockPlanNode(node.left, count, diagnostics)
    return [left, joinBlockPlanNodes(right, node.right, diagnostics)]
  }
  if (count === node.left.count) return [node.left, node.right]
  const [left, right] = splitBlockPlanNode(
    node.right,
    count - node.left.count,
    diagnostics,
  )
  return [joinBlockPlanNodes(node.left, left, diagnostics), right]
}

function appendBlockPlanNode(
  node: BlockPlanNode | undefined,
  block: TranscriptBlock,
  diagnostics?: TranscriptBlockPlanDiagnostics,
): BlockPlanNode {
  if (!node) {
    copiedBlockPlanNode(diagnostics)
    return Object.freeze({
      kind: "leaf" as const,
      count: 1 as const,
      height: 1 as const,
      block,
    })
  }
  if (diagnostics) diagnostics.blockPlanNodeVisits += 1
  if (node.kind === "leaf") {
    copiedBlockPlanNode(diagnostics)
    const right = Object.freeze({
      kind: "leaf" as const,
      count: 1 as const,
      height: 1 as const,
      block,
    })
    return blockPlanBranch(node, right, diagnostics)
  }
  const right = appendBlockPlanNode(node.right, block, diagnostics)
  if (right.height <= node.left.height + 1)
    return blockPlanBranch(node.left, right, diagnostics)

  // Appending changes only the right spine. Restore AVL balance with one
  // persistent rotation while sharing every untouched subtree.
  if (right.kind !== "branch")
    return blockPlanBranch(node.left, right, diagnostics)
  if (right.right.height >= right.left.height) {
    return blockPlanBranch(
      blockPlanBranch(node.left, right.left, diagnostics),
      right.right,
      diagnostics,
    )
  }
  if (right.left.kind !== "branch")
    return blockPlanBranch(node.left, right, diagnostics)
  return blockPlanBranch(
    blockPlanBranch(node.left, right.left.left, diagnostics),
    blockPlanBranch(right.left.right, right.right, diagnostics),
    diagnostics,
  )
}

function blockPlanValue(
  node: BlockPlanNode | undefined,
  index: number,
  diagnostics?: TranscriptBlockPlanDiagnostics,
): TranscriptBlock | undefined {
  while (node) {
    if (diagnostics) diagnostics.blockPlanNodeVisits += 1
    if (node.kind === "leaf") return index === 0 ? node.block : undefined
    if (index < node.left.count) node = node.left
    else {
      index -= node.left.count
      node = node.right
    }
  }
  return undefined
}

function replaceBlockPlanNode(
  node: BlockPlanNode,
  index: number,
  block: TranscriptBlock,
  diagnostics?: TranscriptBlockPlanDiagnostics,
): BlockPlanNode {
  if (diagnostics) diagnostics.blockPlanNodeVisits += 1
  if (node.kind === "leaf") {
    if (node.block === block) return node
    if (diagnostics) diagnostics.blockPlanNodesCopied += 1
    return Object.freeze({
      kind: "leaf" as const,
      count: 1 as const,
      height: 1 as const,
      block,
    })
  }
  if (index < node.left.count) {
    const left = replaceBlockPlanNode(node.left, index, block, diagnostics)
    if (left === node.left) return node
    if (diagnostics) diagnostics.blockPlanNodesCopied += 1
    return Object.freeze({
      kind: "branch" as const,
      count: node.count,
      height: node.height,
      left,
      right: node.right,
    })
  }
  const right = replaceBlockPlanNode(
    node.right,
    index - node.left.count,
    block,
    diagnostics,
  )
  if (right === node.right) return node
  if (diagnostics) diagnostics.blockPlanNodesCopied += 1
  return Object.freeze({
    kind: "branch" as const,
    count: node.count,
    height: node.height,
    left: node.left,
    right,
  })
}

function* blockPlanValues(
  root: BlockPlanNode | undefined,
): IterableIterator<TranscriptBlock> {
  if (!root) return
  const pending: BlockPlanNode[] = [root]
  while (pending.length) {
    const node = pending.pop()!
    if (node.kind === "leaf") yield node.block
    else {
      pending.push(node.right)
      pending.push(node.left)
    }
  }
}

function numericIndex(
  property: PropertyKey,
  length: number,
): number | undefined {
  if (typeof property !== "string" || property === "") return undefined
  const index = Number(property)
  return Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === property
    ? index
    : undefined
}

function blockPlan(data: BlockPlanData): readonly TranscriptBlock[] {
  const target: TranscriptBlock[] = new Array(data.length)
  const proxy = new Proxy(target, {
    get: (_target, property, receiver) => {
      if (property === "length") return data.length
      if (property === Symbol.iterator) return () => blockPlanValues(data.root)
      const index = numericIndex(property, data.length)
      return index === undefined
        ? Reflect.get(target, property, receiver)
        : blockPlanValue(data.root, index)
    },
    has: (_target, property) =>
      property === "length" ||
      numericIndex(property, data.length) !== undefined ||
      Reflect.has(target, property),
    ownKeys: () => [
      ...Array.from({ length: data.length }, (_, index) => String(index)),
      "length",
    ],
    getOwnPropertyDescriptor: (_target, property) => {
      if (property === "length")
        return Reflect.getOwnPropertyDescriptor(target, property)
      const index = numericIndex(property, data.length)
      return index === undefined
        ? Reflect.getOwnPropertyDescriptor(target, property)
        : {
            configurable: true,
            enumerable: true,
            writable: false,
            value: blockPlanValue(data.root, index),
          }
    },
    set: () => false,
    deleteProperty: () => false,
    defineProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  })
  blockPlanData.set(proxy, data)
  return proxy
}

/** Immutable indexed complete plan whose point replacements path-copy O(log n). */
export function persistentTranscriptBlockPlan(
  blocks: readonly TranscriptBlock[],
): readonly TranscriptBlock[] {
  if (blockPlanData.has(blocks)) return blocks
  const cached = normalizedBlockPlans.get(blocks)
  if (cached) return cached
  const plan = blockPlan({
    root: buildBlockPlan(blocks, 0, blocks.length),
    length: blocks.length,
  })
  normalizedBlockPlans.set(blocks, plan)
  return plan
}

/** Replace one stable-key block without copying historical slots. */
export function replaceTranscriptBlock(
  blocks: readonly TranscriptBlock[],
  index: number,
  previous: TranscriptBlock,
  next: TranscriptBlock,
  diagnostics?: TranscriptBlockPlanDiagnostics,
): readonly TranscriptBlock[] | undefined {
  const plan = persistentTranscriptBlockPlan(blocks)
  const data = blockPlanData.get(plan)!
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= data.length ||
    blockPlanValue(data.root, index, diagnostics) !== previous ||
    blockKey(previous) !== blockKey(next)
  )
    return undefined
  const root = replaceBlockPlanNode(data.root!, index, next, diagnostics)
  if (root === data.root) return plan
  if (diagnostics) diagnostics.blockPlanUpdates += 1
  return blockPlan({
    root,
    length: data.length,
    replacement: Object.freeze({ source: plan, index, previous, next }),
  })
}

/** Append one block while sharing the complete historical plan. */
export function appendTranscriptBlock(
  blocks: readonly TranscriptBlock[],
  next: TranscriptBlock,
  diagnostics?: TranscriptBlockPlanDiagnostics,
): readonly TranscriptBlock[] {
  const plan = persistentTranscriptBlockPlan(blocks)
  const data = blockPlanData.get(plan)!
  const root = appendBlockPlanNode(data.root, next, diagnostics)
  if (diagnostics) diagnostics.blockPlanUpdates += 1
  return blockPlan({
    root,
    length: data.length + 1,
    append: Object.freeze({ source: plan, next }),
  })
}

/** Replace or remove one unsplit tail item without visiting historical slots. */
export function replaceTranscriptTailItem(
  blocks: readonly TranscriptBlock[],
  previous: TranscriptItemBlock,
  next?: TranscriptItemBlock,
  diagnostics?: TranscriptBlockPlanDiagnostics,
): readonly TranscriptBlock[] | undefined {
  if (
    blocks.at(-1) !== previous ||
    previous.key.blockId !== "root" ||
    (next && next.key.blockId !== "root")
  )
    return undefined
  const plan = persistentTranscriptBlockPlan(blocks)
  const data = blockPlanData.get(plan)!
  const [prefix] = splitBlockPlanNode(data.root, data.length - 1, diagnostics)
  const root = next ? appendBlockPlanNode(prefix, next, diagnostics) : prefix
  if (diagnostics) diagnostics.blockPlanUpdates += 1
  return blockPlan({
    root,
    length: data.length - (next ? 0 : 1),
    tailReplacement: Object.freeze({ source: plan, previous, next }),
  })
}

export function isTranscriptTailItemReplacement(
  source: readonly TranscriptBlock[],
  blocks: readonly TranscriptBlock[],
  previous: TranscriptItemBlock,
  next?: TranscriptItemBlock,
): boolean {
  const change = blockPlanData.get(blocks)?.tailReplacement
  return (
    change?.source === source &&
    change.previous === previous &&
    change.next === next
  )
}

/** Replace one contiguous logical item's block span while sharing history. */
export function spliceTranscriptItemBlocks(
  blocks: readonly TranscriptBlock[],
  index: number,
  previous: readonly TranscriptBlock[],
  next: readonly TranscriptBlock[],
  diagnostics?: TranscriptBlockPlanDiagnostics,
): readonly TranscriptBlock[] | undefined {
  const plan = persistentTranscriptBlockPlan(blocks)
  const data = blockPlanData.get(plan)!
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index + previous.length > data.length ||
    previous.length === 0 ||
    next.length === 0 ||
    previous.some(
      (block, offset) =>
        blockPlanValue(data.root, index + offset, diagnostics) !== block,
    ) ||
    previous[0]?.key.kind !== "item" ||
    previous.some(
      (block) =>
        block.key.kind !== "item" ||
        (previous[0]?.key.kind === "item" &&
          block.key.itemId !== previous[0].key.itemId),
    ) ||
    next.some(
      (block) =>
        block.key.kind !== "item" ||
        (previous[0]?.key.kind === "item" &&
          block.key.itemId !== previous[0].key.itemId),
    )
  )
    return undefined
  const [before, remaining] = splitBlockPlanNode(data.root, index, diagnostics)
  const [, after] = splitBlockPlanNode(remaining, previous.length, diagnostics)
  const inserted = buildBlockPlan(next, 0, next.length)
  const root = joinBlockPlanNodes(
    joinBlockPlanNodes(before, inserted, diagnostics),
    after,
    diagnostics,
  )
  if (diagnostics) diagnostics.blockPlanUpdates += 1
  return blockPlan({
    root,
    length: data.length - previous.length + next.length,
    splice: Object.freeze({ source: plan, index, previous, next }),
  })
}

/** O(1) proof of an exact item-span splice from a prior indexed plan. */
export function isTranscriptBlockSplice(
  source: readonly TranscriptBlock[],
  blocks: readonly TranscriptBlock[],
  index: number,
  previous: readonly TranscriptBlock[],
  next: readonly TranscriptBlock[],
): boolean {
  const splice = blockPlanData.get(blocks)?.splice
  return (
    splice?.source === source &&
    splice.index === index &&
    splice.previous === previous &&
    splice.next === next
  )
}

/** O(1) lineage proof consumed by indexes that retain complete-plan ordinals. */
export function isTranscriptBlockReplacement(
  source: readonly TranscriptBlock[],
  blocks: readonly TranscriptBlock[],
  previous: TranscriptBlock,
  next: TranscriptBlock,
): boolean {
  const replacement = blockPlanData.get(blocks)?.replacement
  return (
    replacement?.source === source &&
    replacement.previous === previous &&
    replacement.next === next
  )
}

/** O(1) proof that blocks is the exact persistent append of source. */
export function isTranscriptBlockAppend(
  source: readonly TranscriptBlock[],
  blocks: readonly TranscriptBlock[],
  next: TranscriptBlock,
): boolean {
  const append = blockPlanData.get(blocks)?.append
  return append?.source === source && append.next === next
}
