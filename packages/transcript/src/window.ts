import { effectiveItemStatus, type ConversationItem, type ConversationState, type ItemId, type ItemStatus, type ThreadId, type Turn, type TurnId } from "@vimex/conversation"
import type { LogicalPoint, SourceSpan, TextProjection, TranscriptState } from "./domain/transcript-document"
import type { TranscriptHeightIndex } from "./height-index"
import { projectMarkdown } from "./domain/markdown-source-map"

/** Published render plans never expose mutable canonical objects. */
export type Immutable<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends readonly (infer Element)[]
    ? readonly Immutable<Element>[]
    : T extends object
      ? { readonly [Key in keyof T]: Immutable<T[Key]> }
      : T

export type TranscriptBlockItem = Immutable<ConversationItem>
export type TranscriptBlockProjection = Immutable<TextProjection>

export interface TranscriptItemFragment {
  readonly kind: "command-header" | "command-output" | "markdown" | "edit-header" | "edit-file"
  readonly index: number
  readonly count: number
}

export interface TranscriptItemBlock {
  readonly key: Readonly<{ kind: "item"; itemId: ItemId; blockId: string }>
  readonly turnId: TurnId
  /** Immutable canonical item metadata shared by every block of this item. */
  readonly item: TranscriptBlockItem
  /** Render-ready payload for sourceSpan. Stage 2 publishes the complete item. */
  readonly renderItem: TranscriptBlockItem
  /** Immutable semantic projection used to address sourceSpan and logical points. */
  readonly projection: TranscriptBlockProjection
  readonly sourceSpan: Readonly<SourceSpan>
  readonly contentRevision: number
  readonly estimatedRows: number
  /** Disposable render-fragment role; semantic positions never contain it. */
  readonly fragment?: TranscriptItemFragment
  /** Complete-plan adjacency; native height must not depend on a window boundary. */
  readonly followedByActivity: boolean
}

export interface TranscriptTurnActivityBlock {
  readonly key: Readonly<{ kind: "turn-activity"; turnId: TurnId }>
  readonly turn: Turn
  readonly sourceSpan?: undefined
  readonly contentRevision: number
  readonly estimatedRows: number
}

export type TranscriptBlock = TranscriptItemBlock | TranscriptTurnActivityBlock

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

interface BlockPlanData {
  readonly root?: BlockPlanNode
  readonly length: number
  readonly replacement?: BlockPlanReplacement
  readonly append?: BlockPlanAppend
}

export interface TranscriptBlockPlanDiagnostics {
  blockPlanUpdates: number
  /** Validation plus persistent-tree work for updates; ordinary reads are outside this counter. */
  blockPlanNodeVisits: number
  blockPlanNodesCopied: number
}

const blockPlanData = new WeakMap<object, BlockPlanData>()
const normalizedBlockPlans = new WeakMap<object, readonly TranscriptBlock[]>()

function buildBlockPlan(values: readonly TranscriptBlock[], from: number, to: number): BlockPlanNode | undefined {
  if (from >= to) return undefined
  if (to - from === 1) return Object.freeze({ kind: "leaf" as const, count: 1 as const, height: 1 as const, block: values[from]! })
  const middle = from + ((to - from) >>> 1)
  const left = buildBlockPlan(values, from, middle)!
  const right = buildBlockPlan(values, middle, to)!
  return Object.freeze({ kind: "branch" as const, count: left.count + right.count, height: Math.max(left.height, right.height) + 1, left, right })
}

function copiedBlockPlanNode(diagnostics: TranscriptBlockPlanDiagnostics | undefined): void {
  if (diagnostics) diagnostics.blockPlanNodesCopied += 1
}

function blockPlanBranch(
  left: BlockPlanNode,
  right: BlockPlanNode,
  diagnostics?: TranscriptBlockPlanDiagnostics,
): BlockPlanBranch {
  copiedBlockPlanNode(diagnostics)
  return Object.freeze({ kind: "branch" as const, count: left.count + right.count, height: Math.max(left.height, right.height) + 1, left, right })
}

function appendBlockPlanNode(
  node: BlockPlanNode | undefined,
  block: TranscriptBlock,
  diagnostics?: TranscriptBlockPlanDiagnostics,
): BlockPlanNode {
  if (!node) {
    copiedBlockPlanNode(diagnostics)
    return Object.freeze({ kind: "leaf" as const, count: 1 as const, height: 1 as const, block })
  }
  if (diagnostics) diagnostics.blockPlanNodeVisits += 1
  if (node.kind === "leaf") {
    copiedBlockPlanNode(diagnostics)
    const right = Object.freeze({ kind: "leaf" as const, count: 1 as const, height: 1 as const, block })
    return blockPlanBranch(node, right, diagnostics)
  }
  const right = appendBlockPlanNode(node.right, block, diagnostics)
  if (right.height <= node.left.height + 1) return blockPlanBranch(node.left, right, diagnostics)

  // Appending changes only the right spine. Restore AVL balance with one
  // persistent rotation while sharing every untouched subtree.
  if (right.kind !== "branch") return blockPlanBranch(node.left, right, diagnostics)
  if (right.right.height >= right.left.height) {
    return blockPlanBranch(blockPlanBranch(node.left, right.left, diagnostics), right.right, diagnostics)
  }
  if (right.left.kind !== "branch") return blockPlanBranch(node.left, right, diagnostics)
  return blockPlanBranch(
    blockPlanBranch(node.left, right.left.left, diagnostics),
    blockPlanBranch(right.left.right, right.right, diagnostics),
    diagnostics,
  )
}

function blockPlanValue(node: BlockPlanNode | undefined, index: number, diagnostics?: TranscriptBlockPlanDiagnostics): TranscriptBlock | undefined {
  while (node) {
    if (diagnostics) diagnostics.blockPlanNodeVisits += 1
    if (node.kind === "leaf") return index === 0 ? node.block : undefined
    if (index < node.left.count) node = node.left
    else { index -= node.left.count; node = node.right }
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
    return Object.freeze({ kind: "leaf" as const, count: 1 as const, height: 1 as const, block })
  }
  if (index < node.left.count) {
    const left = replaceBlockPlanNode(node.left, index, block, diagnostics)
    if (left === node.left) return node
    if (diagnostics) diagnostics.blockPlanNodesCopied += 1
    return Object.freeze({ kind: "branch" as const, count: node.count, height: node.height, left, right: node.right })
  }
  const right = replaceBlockPlanNode(node.right, index - node.left.count, block, diagnostics)
  if (right === node.right) return node
  if (diagnostics) diagnostics.blockPlanNodesCopied += 1
  return Object.freeze({ kind: "branch" as const, count: node.count, height: node.height, left: node.left, right })
}

function *blockPlanValues(root: BlockPlanNode | undefined): IterableIterator<TranscriptBlock> {
  if (!root) return
  const pending: BlockPlanNode[] = [root]
  while (pending.length) {
    const node = pending.pop()!
    if (node.kind === "leaf") yield node.block
    else { pending.push(node.right); pending.push(node.left) }
  }
}

function numericIndex(property: PropertyKey, length: number): number | undefined {
  if (typeof property !== "string" || property === "") return undefined
  const index = Number(property)
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === property ? index : undefined
}

function blockPlan(data: BlockPlanData): readonly TranscriptBlock[] {
  const target: TranscriptBlock[] = new Array(data.length)
  const proxy = new Proxy(target, {
    get: (_target, property, receiver) => {
      if (property === "length") return data.length
      if (property === Symbol.iterator) return () => blockPlanValues(data.root)
      const index = numericIndex(property, data.length)
      return index === undefined ? Reflect.get(target, property, receiver) : blockPlanValue(data.root, index)
    },
    has: (_target, property) => property === "length" || numericIndex(property, data.length) !== undefined || Reflect.has(target, property),
    ownKeys: () => [...Array.from({ length: data.length }, (_, index) => String(index)), "length"],
    getOwnPropertyDescriptor: (_target, property) => {
      if (property === "length") return Reflect.getOwnPropertyDescriptor(target, property)
      const index = numericIndex(property, data.length)
      return index === undefined ? Reflect.getOwnPropertyDescriptor(target, property) : {
        configurable: true, enumerable: true, writable: false, value: blockPlanValue(data.root, index),
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
export function persistentTranscriptBlockPlan(blocks: readonly TranscriptBlock[]): readonly TranscriptBlock[] {
  if (blockPlanData.has(blocks)) return blocks
  const cached = normalizedBlockPlans.get(blocks)
  if (cached) return cached
  const plan = blockPlan({ root: buildBlockPlan(blocks, 0, blocks.length), length: blocks.length })
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
  if (!Number.isSafeInteger(index) || index < 0 || index >= data.length
    || blockPlanValue(data.root, index, diagnostics) !== previous || blockKey(previous) !== blockKey(next)) return undefined
  const root = replaceBlockPlanNode(data.root!, index, next, diagnostics)
  if (root === data.root) return plan
  if (diagnostics) diagnostics.blockPlanUpdates += 1
  return blockPlan({ root, length: data.length, replacement: Object.freeze({ source: plan, index, previous, next }) })
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
  return blockPlan({ root, length: data.length + 1, append: Object.freeze({ source: plan, next }) })
}

/** O(1) lineage proof consumed by indexes that retain complete-plan ordinals. */
export function isTranscriptBlockReplacement(
  source: readonly TranscriptBlock[],
  blocks: readonly TranscriptBlock[],
  previous: TranscriptBlock,
  next: TranscriptBlock,
): boolean {
  const replacement = blockPlanData.get(blocks)?.replacement
  return replacement?.source === source && replacement.previous === previous && replacement.next === next
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

export interface TranscriptWindow {
  readonly blocks: readonly TranscriptBlock[]
  readonly topSpacerRows: number
  readonly bottomSpacerRows: number
  readonly overscanRows: number
}

export type TranscriptWindowAttachment =
  | Readonly<{ kind: "tail" }>
  | Readonly<{
      kind: "point"
      point: LogicalPoint
      preferredScreenRow: number
      /** Disposable measured row within the owning render block. */
      blockLocalRow?: number
    }>

/** Optional deterministic counters for target-resolution tests and diagnostics. */
export interface TranscriptWindowDiagnostics {
  targetLookupVisits: number
}

export interface PlanTranscriptWindowInput {
  readonly blocks: readonly TranscriptBlock[]
  readonly heights: TranscriptHeightIndex
  readonly viewportRows: number
  readonly overscanRows: number
  readonly attachment: TranscriptWindowAttachment
  /** A one-shot target takes planning focus when it is outside the ordinary window. */
  readonly reveal?: LogicalPoint
  readonly diagnostics?: TranscriptWindowDiagnostics
}

export interface BuildTranscriptBlocksInput {
  readonly conversation: ConversationState
  readonly transcript: TranscriptState
  readonly excludedTurnIds?: readonly TurnId[] | ReadonlySet<TurnId>
  /** Presentation lineage; cached render-block identity never crosses a reset. */
  readonly canonicalGeneration?: number
  readonly threadId?: ThreadId
}

/** Terminal turn metadata is presentation decoration, not transcript content. */
export function hasTurnActivity(turn: Turn): boolean {
  return turn.status === "failed" || turn.status === "interrupted"
    || (turn.status === "complete" && (turn.durationMs !== undefined || (turn.startedAt !== undefined && turn.completedAt !== undefined)))
}

function turnActivityRevision(turn: Turn): number {
  const value = `${turn.status}\u0000${turn.startedAt ?? ""}\u0000${turn.completedAt ?? ""}\u0000${turn.durationMs ?? ""}`
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619)
  return hash >>> 0
}

function immutableClone<T>(value: T): Immutable<T> {
  if (Array.isArray(value)) return Object.freeze(value.map(entry => immutableClone(entry))) as Immutable<T>
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, immutableClone(entry)]))) as Immutable<T>
  }
  return value as Immutable<T>
}

const itemSnapshots = new WeakMap<ConversationItem, Map<ItemStatus, TranscriptBlockItem>>()
const itemRevisions = new WeakMap<ConversationItem, Map<string, WeakMap<TextProjection, number>>>()
const itemBlockPlans = new WeakMap<ConversationItem, WeakMap<TextProjection, Map<string, readonly TranscriptItemBlock[]>>>()
let nextItemRevision = 1

const commandFragmentSourceLimit = 4_096
const markdownFragmentSourceLimit = 4_096
const markdownFragmentUnitLimit = 12
const editFragmentFileLimit = 1

function snapshotItem(conversation: ConversationState, item: ConversationItem): TranscriptBlockItem {
  const status = effectiveItemStatus(conversation, item)
  let byStatus = itemSnapshots.get(item)
  if (!byStatus) {
    byStatus = new Map()
    itemSnapshots.set(item, byStatus)
  }
  const existing = byStatus.get(status)
  if (existing) return existing
  const snapshot = immutableClone({ ...item, status } as ConversationItem)
  byStatus.set(status, snapshot)
  return snapshot
}

function snapshotProjection(projection: TextProjection): TranscriptBlockProjection {
  // TextProjection is deeply readonly at the domain boundary. Sharing it
  // avoids cloning every grapheme source span again on each streaming cadence.
  return projection
}

function itemContentRevision(sourceItem: ConversationItem, status: ItemStatus, sourceProjection: TextProjection, followedByActivity: boolean): number {
  let byStatus = itemRevisions.get(sourceItem)
  if (!byStatus) {
    byStatus = new Map()
    itemRevisions.set(sourceItem, byStatus)
  }
  const presentation = `${status}:${followedByActivity ? 1 : 0}`
  let byProjection = byStatus.get(presentation)
  if (!byProjection) {
    byProjection = new WeakMap()
    byStatus.set(presentation, byProjection)
  }
  const existing = byProjection.get(sourceProjection)
  if (existing !== undefined) return existing
  // Canonical reducers replace item/projection objects rather than mutating
  // them. Their identity pair therefore covers source and every visible item
  // field without serializing a growing tool or Markdown payload per cadence.
  const revision = nextItemRevision++
  byProjection.set(sourceProjection, revision)
  return revision
}

function snapshotTurn(turn: Turn): Turn {
  return Object.freeze({ ...turn, itemIds: Object.freeze([...turn.itemIds]) })
}

/** Builds the source-less terminal decoration for one canonical turn. */
export function buildTranscriptTurnActivityBlock(turn: Turn): TranscriptTurnActivityBlock | undefined {
  if (!hasTurnActivity(turn)) return undefined
  return Object.freeze({
    key: Object.freeze({ kind: "turn-activity" as const, turnId: turn.id }),
    turn: snapshotTurn(turn),
    contentRevision: turnActivityRevision(turn),
    estimatedRows: 2,
  })
}

function rootItemBlock(
  input: Pick<BuildTranscriptBlocksInput, "conversation" | "transcript">,
  itemId: ItemId,
  followedByActivity: boolean,
): TranscriptItemBlock | undefined {
  const item = input.conversation.items[itemId]
  const projection = input.transcript.projectionById[itemId]
  if (!item || !projection) return undefined
  const status = effectiveItemStatus(input.conversation, item)
  const itemSnapshot = snapshotItem(input.conversation, item)
  const projectionSnapshot = snapshotProjection(projection)
  return Object.freeze({
    key: Object.freeze({ kind: "item" as const, itemId, blockId: "root" }),
    turnId: item.turnId,
    item: itemSnapshot,
    renderItem: itemSnapshot,
    projection: projectionSnapshot,
    sourceSpan: Object.freeze({ from: 0, to: projectionSnapshot.source.length }),
    contentRevision: itemContentRevision(item, status, projection, followedByActivity),
    estimatedRows: 1,
    followedByActivity,
  })
}

function commandDetailChunks(detail: string, firstLimit: number): readonly Readonly<{ from: number; to: number }>[] | undefined {
  if (!detail || detail.includes("\r") || firstLimit <= 0) return undefined
  const lines: { from: number; to: number }[] = []
  let from = 0
  while (from < detail.length) {
    const newline = detail.indexOf("\n", from)
    const to = newline < 0 ? detail.length : newline + 1
    if (to - from > commandFragmentSourceLimit) return undefined
    lines.push({ from, to })
    from = to
  }
  if (!lines.length) return undefined

  const chunks: { from: number; to: number }[] = []
  let chunkFrom = 0, chunkTo = 0, limit = firstLimit
  for (const line of lines) {
    if (chunkTo > chunkFrom && line.to - chunkFrom > limit) {
      chunks.push(Object.freeze({ from: chunkFrom, to: chunkTo }))
      chunkFrom = line.from
      limit = commandFragmentSourceLimit
    }
    if (line.to - chunkFrom > limit) return undefined
    chunkTo = line.to
  }
  chunks.push(Object.freeze({ from: chunkFrom, to: chunkTo }))
  return chunks.length > 1 ? Object.freeze(chunks) : undefined
}

function commandItemBlocks(
  input: Pick<BuildTranscriptBlocksInput, "conversation" | "transcript">,
  itemId: ItemId,
  followedByActivity: boolean,
): readonly TranscriptItemBlock[] | undefined {
  const sourceItem = input.conversation.items[itemId]
  const projection = input.transcript.projectionById[itemId]
  if (!sourceItem || sourceItem.kind !== "command" || !projection
    || input.transcript.folded[itemId] || effectiveItemStatus(input.conversation, sourceItem) === "running"
    || projection.plain !== projection.source || projection.source.includes("\r")) return undefined
  const source = [sourceItem.title, sourceItem.executionCommand, sourceItem.detail].filter(Boolean).join("\n")
  if (source !== projection.source || sourceItem.detail.length <= commandFragmentSourceLimit) return undefined
  const detailFrom = source.length - sourceItem.detail.length
  const chunks = commandDetailChunks(sourceItem.detail, commandFragmentSourceLimit - detailFrom)
  if (!chunks) return undefined
  if (chunks.some((chunk, index) => index < chunks.length - 1
    && sourceItem.detail.slice(chunk.from, chunk.to - 1).length === 0)) return undefined

  const status = effectiveItemStatus(input.conversation, sourceItem)
  const item = snapshotItem(input.conversation, sourceItem)
  if (item.kind !== "command") return undefined
  const revision = itemContentRevision(sourceItem, status, projection, followedByActivity)
  const count = chunks.length
  const blocks = chunks.map((chunk, index): TranscriptItemBlock => {
    const first = index === 0, last = index === count - 1
    const detail = sourceItem.detail.slice(chunk.from, chunk.to)
    const renderItem: TranscriptBlockItem = Object.freeze(first
      ? { ...item, detail }
      : { ...item, title: "", executionCommand: undefined, detail }) as TranscriptBlockItem
    const from = first ? 0 : detailFrom + chunk.from
    const to = detailFrom + chunk.to
    return Object.freeze({
      key: Object.freeze({ kind: "item" as const, itemId,
        blockId: first ? "command:header" : `command:output:${chunk.from}` }),
      turnId: sourceItem.turnId,
      item,
      renderItem,
      projection,
      sourceSpan: Object.freeze({ from, to }),
      contentRevision: revision,
      estimatedRows: Math.max(1, detail.split("\n").length + (first ? 4 : 0)),
      fragment: Object.freeze({ kind: first ? "command-header" as const : "command-output" as const, index, count }),
      followedByActivity: last && followedByActivity,
    })
  })
  if (blocks[0]?.sourceSpan.from !== 0 || blocks.at(-1)?.sourceSpan.to !== projection.source.length
    || blocks.some((block, index) => index > 0 && blocks[index - 1]!.sourceSpan.to !== block.sourceSpan.from)) return undefined
  return Object.freeze(blocks)
}

function markdownAtoms(source: string): readonly Readonly<SourceSpan>[] | undefined {
  if (source.includes("\r") || source.includes("\n\n\n") || /\n[ \t]+\n/u.test(source)) return undefined
  const fenced: SourceSpan[] = []
  let fence: { marker: "`" | "~"; width: number; from: number } | undefined
  for (let lineFrom = 0; lineFrom <= source.length;) {
    const newline = source.indexOf("\n", lineFrom)
    const lineTo = newline < 0 ? source.length : newline
    const newlineTo = newline < 0 ? source.length : newline + 1
    const line = source.slice(lineFrom, lineTo)
    if (fence) {
      const close = /^( {0,3})(`{3,}|~{3,})[ \t]*$/u.exec(line)
      if (close?.[2]?.[0] === fence.marker && close[2].length >= fence.width) {
        fenced.push(Object.freeze({ from: fence.from, to: newlineTo }))
        fence = undefined
      }
    } else {
      const open = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line)
      if (open?.[2] && !(open[2][0] === "`" && open[3]?.includes("`"))) {
        fence = { marker: open[2][0] as "`" | "~", width: open[2].length, from: lineFrom }
      } else if (/^(?: {4}|\t| {0,3}(?:>|(?:[-+*]|\d+[.)])\s|\[[^\]]+\]:|<(?:!--|\/?[A-Za-z])))/u.test(line)) {
        return undefined
      }
    }
    if (newline < 0) break
    lineFrom = newlineTo
  }
  if (fence) return undefined

  const cuts: number[] = []
  for (const match of source.matchAll(/\n\n/gu)) {
    if (!fenced.some(span => match.index >= span.from && match.index + 2 <= span.to)) cuts.push(match.index + 2)
  }
  if (!cuts.length) return undefined
  const atoms: SourceSpan[] = []
  let from = 0
  for (const to of cuts) {
    if (to <= from) return undefined
    atoms.push(Object.freeze({ from, to }))
    from = to
  }
  if (from < source.length) atoms.push(Object.freeze({ from, to: source.length }))
  return atoms.length > 1 ? Object.freeze(atoms) : undefined
}

function markdownChunks(source: string): readonly Readonly<SourceSpan>[] | undefined {
  const atoms = markdownAtoms(source)
  if (!atoms) return undefined
  const chunks: SourceSpan[] = []
  let from = atoms[0]!.from, to = from, units = 0
  for (const atom of atoms) {
    if (atom.to - atom.from > markdownFragmentSourceLimit) return undefined
    if (to > from && (atom.to - from > markdownFragmentSourceLimit || units >= markdownFragmentUnitLimit)) {
      chunks.push(Object.freeze({ from, to }))
      from = atom.from
      units = 0
    }
    to = atom.to
    units++
  }
  chunks.push(Object.freeze({ from, to }))
  return chunks.length > 1 ? Object.freeze(chunks) : undefined
}

function markdownChunksCompose(projection: TextProjection, chunks: readonly Readonly<SourceSpan>[]): boolean {
  let plain = "", graphemeOffset = 0
  const spans: SourceSpan[] = []
  const links: TextProjection["links"][number][] = []
  const regions: NonNullable<TextProjection["sourceRegions"]>[number][] = []
  for (const chunk of chunks) {
    const local = projectMarkdown(projection.source.slice(chunk.from, chunk.to))
    plain += local.plain
    spans.push(...local.sourceSpans.map(span => ({ from: span.from + chunk.from, to: span.to + chunk.from })))
    links.push(...local.links.map(link => ({ ...link, from: link.from + graphemeOffset, to: link.to + graphemeOffset })))
    regions.push(...(local.sourceRegions ?? []).map(region => ({ ...region,
      from: region.from + graphemeOffset, to: region.to + graphemeOffset,
      sourceFrom: region.sourceFrom + chunk.from, sourceTo: region.sourceTo + chunk.from })))
    graphemeOffset += local.sourceSpans.length
  }
  const expectedRegions = projection.sourceRegions ?? []
  return plain === projection.plain
    && spans.length === projection.sourceSpans.length
    && spans.every((span, index) => span.from === projection.sourceSpans[index]?.from && span.to === projection.sourceSpans[index]?.to)
    && links.length === projection.links.length
    && links.every((link, index) => link.from === projection.links[index]?.from
      && link.to === projection.links[index]?.to && link.url === projection.links[index]?.url)
    && regions.length === expectedRegions.length
    && regions.every((region, index) => region.from === expectedRegions[index]?.from && region.to === expectedRegions[index]?.to
      && region.sourceFrom === expectedRegions[index]?.sourceFrom && region.sourceTo === expectedRegions[index]?.sourceTo)
}

function markdownItemBlocks(
  input: Pick<BuildTranscriptBlocksInput, "conversation" | "transcript">,
  itemId: ItemId,
  followedByActivity: boolean,
): readonly TranscriptItemBlock[] | undefined {
  const sourceItem = input.conversation.items[itemId]
  const projection = input.transcript.projectionById[itemId]
  if (!sourceItem || (sourceItem.kind !== "assistant" && sourceItem.kind !== "user") || !projection
    || input.transcript.folded[itemId] || effectiveItemStatus(input.conversation, sourceItem) === "running"
    || projection.source !== sourceItem.markdown || projection.source.length <= markdownFragmentSourceLimit) return undefined
  const chunks = markdownChunks(projection.source)
  if (!chunks || !markdownChunksCompose(projection, chunks)) return undefined
  const status = effectiveItemStatus(input.conversation, sourceItem)
  const item = snapshotItem(input.conversation, sourceItem)
  if (item.kind !== "assistant" && item.kind !== "user") return undefined
  const revision = itemContentRevision(sourceItem, status, projection, followedByActivity)
  const count = chunks.length
  return Object.freeze(chunks.map((chunk, index): TranscriptItemBlock => Object.freeze({
    key: Object.freeze({ kind: "item" as const, itemId, blockId: `markdown:${chunk.from}` }),
    turnId: sourceItem.turnId,
    item,
    renderItem: Object.freeze({ ...item, markdown: projection.source.slice(chunk.from, chunk.to) }),
    projection,
    sourceSpan: chunk,
    contentRevision: revision,
    estimatedRows: Math.max(1, projection.source.slice(chunk.from, chunk.to).split("\n").length + (index > 0 ? 1 : 0)),
    fragment: Object.freeze({ kind: "markdown" as const, index, count }),
    followedByActivity: index === count - 1 && followedByActivity,
  })))
}

function editItemBlocks(
  input: Pick<BuildTranscriptBlocksInput, "conversation" | "transcript">,
  itemId: ItemId,
  followedByActivity: boolean,
): readonly TranscriptItemBlock[] | undefined {
  const sourceItem = input.conversation.items[itemId]
  const projection = input.transcript.projectionById[itemId]
  if (!sourceItem || sourceItem.kind !== "edit" || !projection || input.transcript.folded[itemId]
    || effectiveItemStatus(input.conversation, sourceItem) === "running" || sourceItem.patch.includes("\r")
    || projection.plain !== sourceItem.patch || projection.source !== sourceItem.patch
    || !sourceItem.changes || sourceItem.changes.length < 2
    || sourceItem.changes.some(change => !change.patch)
    || sourceItem.changes.map(change => change.patch).join("\n") !== sourceItem.patch) return undefined
  const status = effectiveItemStatus(input.conversation, sourceItem)
  const item = snapshotItem(input.conversation, sourceItem)
  if (item.kind !== "edit" || !item.changes) return undefined
  const revision = itemContentRevision(sourceItem, status, projection, followedByActivity)
  const groups = Array.from({ length: Math.ceil(item.changes.length / editFragmentFileLimit) }, (_, index) =>
    Object.freeze(item.changes!.slice(index * editFragmentFileLimit, (index + 1) * editFragmentFileLimit)))
  const count = groups.length
  let from = 0
  return Object.freeze(groups.map((changes, index): TranscriptItemBlock => {
    const contentLength = changes.reduce((length, change, localIndex) => length + change.patch.length
      + (localIndex < changes.length - 1 ? 1 : 0), 0)
    const to = from + contentLength + (index < count - 1 ? 1 : 0)
    const span = Object.freeze({ from, to })
    const block = Object.freeze({
      key: Object.freeze({ kind: "item" as const, itemId,
        blockId: index === 0 ? "edit:header" : `edit:file:${from}` }),
      turnId: sourceItem.turnId,
      item,
      renderItem: Object.freeze({ ...item, patch: projection.source.slice(from, to), changes }),
      projection,
      sourceSpan: span,
      contentRevision: revision,
      estimatedRows: Math.max(1, changes.reduce((rows, change) => rows + change.patch.split("\n").length + 1, index === 0 ? 3 : 1)),
      fragment: Object.freeze({ kind: index === 0 ? "edit-header" as const : "edit-file" as const, index, count }),
      followedByActivity: index === count - 1 && followedByActivity,
    })
    from = to
    return block
  }))
}

/** Builds the complete render plan for one semantic item, with an exact root fallback. */
export function buildTranscriptItemBlocks(
  input: Pick<BuildTranscriptBlocksInput, "conversation" | "transcript" | "canonicalGeneration" | "threadId">,
  itemId: ItemId,
): readonly TranscriptItemBlock[] {
  const sourceItem = input.conversation.items[itemId]
  const projection = input.transcript.projectionById[itemId]
  if (!sourceItem || !projection) return Object.freeze([])
  const turn = input.conversation.turns[sourceItem.turnId]
  const lastSemanticItemId = turn?.itemIds.findLast(candidate => Boolean(
    input.conversation.items[candidate] && input.transcript.projectionById[candidate],
  ))
  const followedByActivity = Boolean(turn && lastSemanticItemId === itemId && hasTurnActivity(turn))
  const cacheKey = `${input.threadId ?? ""}:${input.canonicalGeneration ?? 0}:${effectiveItemStatus(input.conversation, sourceItem)}:${input.transcript.folded[itemId] ? 1 : 0}:${followedByActivity ? 1 : 0}`
  let byProjection = itemBlockPlans.get(sourceItem)
  if (!byProjection) { byProjection = new WeakMap(); itemBlockPlans.set(sourceItem, byProjection) }
  let byPresentation = byProjection.get(projection)
  if (!byPresentation) { byPresentation = new Map(); byProjection.set(projection, byPresentation) }
  const cached = byPresentation.get(cacheKey)
  if (cached) return cached
  const fragmented = commandItemBlocks(input, itemId, followedByActivity)
    ?? markdownItemBlocks(input, itemId, followedByActivity)
    ?? editItemBlocks(input, itemId, followedByActivity)
  const root = fragmented ? undefined : rootItemBlock(input, itemId, followedByActivity)
  const blocks = fragmented ?? Object.freeze(root ? [root] : [])
  byPresentation.set(cacheKey, blocks)
  return blocks
}

/** Builds the Stage 2 root block for one known semantic item. */
export function buildTranscriptItemBlock(input: Pick<BuildTranscriptBlocksInput, "conversation" | "transcript" | "canonicalGeneration" | "threadId">, itemId: ItemId): TranscriptItemBlock | undefined {
  const blocks = buildTranscriptItemBlocks(input, itemId)
  return blocks.length === 1 ? blocks[0] : undefined
}

/**
 * Builds the Stage 2 pass-through block plan from canonical chronology.
 * Activity blocks deliberately have no source span and therefore no logical
 * transcript target.
 */
export function buildTranscriptBlocks(input: BuildTranscriptBlocksInput): readonly TranscriptBlock[] {
  const { conversation, transcript } = input
  const excluded = input.excludedTurnIds instanceof Set
    ? input.excludedTurnIds
    : new Set(input.excludedTurnIds ?? [])
  const semanticItems = new Set(transcript.order)
  const blocks: TranscriptBlock[] = []

  for (const turnId of conversation.turnIds) {
    if (excluded.has(turnId)) continue
    const turn = conversation.turns[turnId]
    if (!turn) continue
    for (const itemId of turn.itemIds) {
      if (!semanticItems.has(itemId)) continue
      const itemBlocks = buildTranscriptItemBlocks(input, itemId)
      if (itemBlocks.length) blocks.push(...itemBlocks)
    }

    const activity = buildTranscriptTurnActivityBlock(turn)
    if (activity) blocks.push(activity)
  }

  return Object.freeze(blocks)
}

/** Stage 2 materializes every planned block; Stage 5 replaces this policy. */
export function passThroughWindow(blocks: readonly TranscriptBlock[]): TranscriptWindow {
  return Object.freeze({ blocks, topSpacerRows: 0, bottomSpacerRows: 0, overscanRows: 0 })
}

function validPlannerCount(value: number, positive = false): boolean {
  return Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum))
}

function targetLookupVisit(diagnostics: TranscriptWindowDiagnostics | undefined): void {
  if (diagnostics) diagnostics.targetLookupVisits += 1
}

/** Resolve one logical point without consulting native nodes or terminal coordinates. */
export function transcriptPointBlockIndex(
  blocks: readonly TranscriptBlock[],
  heights: TranscriptHeightIndex,
  point: LogicalPoint,
  diagnostics: TranscriptWindowDiagnostics | undefined,
): number | undefined {
  if (!Number.isInteger(point.graphemeOffset) || point.graphemeOffset < 0) return undefined

  targetLookupVisit(diagnostics)
  const itemIndexes = heights.itemBlockIndexes(point.itemId)
  if (!itemIndexes?.length) return undefined
  const first = blocks[itemIndexes[0]!]
  targetLookupVisit(diagnostics)
  if (!first || !("projection" in first) || first.key.itemId !== point.itemId
    || point.graphemeOffset > first.projection.sourceSpans.length) return undefined
  const sourceOffset = first.projection.sourceSpans[point.graphemeOffset]?.from ?? first.projection.source.length

  // Item block ordinals are ordered by non-overlapping source-span starts. The
  // last start at or before the target owns a boundary, subject to the final
  // materialization check for gaps and the item-end point.
  let low = 0
  let high = itemIndexes.length
  while (low < high) {
    const middle = low + ((high - low) >>> 1)
    const block = blocks[itemIndexes[middle]!]
    targetLookupVisit(diagnostics)
    if (!block || !("projection" in block) || block.key.itemId !== point.itemId) return undefined
    if (block.sourceSpan.from <= sourceOffset) low = middle + 1
    else high = middle
  }
  if (low === 0) return undefined
  const blockIndex = itemIndexes[low - 1]!
  const block = blocks[blockIndex]
  targetLookupVisit(diagnostics)
  return block && pointIsMaterialized([block], point) ? blockIndex : undefined
}

/**
 * Pure renderer-neutral window planner. Unknown or internally inconsistent
 * relationships take the exact pass-through path rather than guessing.
 */
export function planTranscriptWindow(input: PlanTranscriptWindowInput): TranscriptWindow {
  const { blocks, heights } = input
  if (blocks.length === 0) return Object.freeze({ blocks: Object.freeze([]), topSpacerRows: 0, bottomSpacerRows: 0, overscanRows: 0 })
  if (!validPlannerCount(input.viewportRows, true) || !validPlannerCount(input.overscanRows)
    || !heights.supports(blocks) || heights.blockCount !== blocks.length
    || !validPlannerCount(heights.totalRows, true)) return passThroughWindow(blocks)

  let focusIndex: number | undefined
  let preferredScreenRow = 0
  if (input.attachment.kind === "point") {
    if (!Number.isSafeInteger(input.attachment.preferredScreenRow)
      || (input.attachment.blockLocalRow !== undefined
        && (!Number.isSafeInteger(input.attachment.blockLocalRow) || input.attachment.blockLocalRow < 0))) return passThroughWindow(blocks)
    focusIndex = transcriptPointBlockIndex(blocks, heights, input.attachment.point, input.diagnostics)
    if (focusIndex === undefined) return passThroughWindow(blocks)
    preferredScreenRow = clamp(input.attachment.preferredScreenRow, 0, input.viewportRows - 1)
  }

  const maximumVisibleStart = Math.max(0, heights.totalRows - input.viewportRows)
  const focusRange = input.attachment.kind === "point" ? heights.rowRange(focusIndex!, focusIndex! + 1) : undefined
  if (input.attachment.kind === "point" && !focusRange) return passThroughWindow(blocks)
  const blockLocalRow = input.attachment.kind === "point"
    ? clamp(input.attachment.blockLocalRow ?? 0, 0, Math.max(0, focusRange!.rows - 1)) : 0
  let visibleStart = input.attachment.kind === "tail"
    ? maximumVisibleStart
    : clamp(focusRange!.start + blockLocalRow - Math.min(preferredScreenRow, input.viewportRows - 1), 0, maximumVisibleStart)
  let visibleEnd = Math.min(heights.totalRows, visibleStart + input.viewportRows)
  let plannedFrom = Math.max(0, visibleStart - input.overscanRows)
  let plannedTo = input.attachment.kind === "tail"
    ? heights.totalRows
    : Math.min(heights.totalRows, visibleEnd + input.overscanRows)

  if (input.reveal) {
    const revealIndex = transcriptPointBlockIndex(blocks, heights, input.reveal, input.diagnostics)
    if (revealIndex === undefined) return passThroughWindow(blocks)
    const revealRange = heights.rowRange(revealIndex, revealIndex + 1)
    if (!revealRange) return passThroughWindow(blocks)
    const alreadyPlanned = revealRange.end > plannedFrom && revealRange.start < plannedTo
    if (!alreadyPlanned) {
      preferredScreenRow = Math.floor((input.viewportRows - 1) / 2)
      visibleStart = clamp(revealRange.start - preferredScreenRow, 0, maximumVisibleStart)
      visibleEnd = Math.min(heights.totalRows, visibleStart + input.viewportRows)
      plannedFrom = Math.max(0, visibleStart - input.overscanRows)
      plannedTo = Math.min(heights.totalRows, visibleEnd + input.overscanRows)
    }
  }

  const first = heights.blockAtRow(plannedFrom)
  if (first === undefined || first < 0 || first >= blocks.length) return passThroughWindow(blocks)
  let lastExclusive: number
  if (plannedTo >= heights.totalRows) lastExclusive = blocks.length
  else {
    const atEnd = heights.blockAtRow(plannedTo)
    if (atEnd === undefined || atEnd < first || atEnd >= blocks.length) return passThroughWindow(blocks)
    lastExclusive = heights.prefixRows(atEnd) === plannedTo ? atEnd : atEnd + 1
  }
  if (lastExclusive <= first) return passThroughWindow(blocks)

  const topSpacerRows = heights.prefixRows(first)
  const bottomSpacerRows = heights.totalRows - heights.prefixRows(lastExclusive)
  if (!validPlannerCount(topSpacerRows) || !validPlannerCount(bottomSpacerRows)
    || topSpacerRows + (heights.prefixRows(lastExclusive) - topSpacerRows) + bottomSpacerRows !== heights.totalRows) {
    return passThroughWindow(blocks)
  }
  const windowBlocks = Object.freeze(blocks.slice(first, lastExclusive))
  if (input.reveal && !pointIsMaterialized(windowBlocks, input.reveal)) return passThroughWindow(blocks)
  if (!input.reveal && input.attachment.kind === "point" && !pointIsMaterialized(windowBlocks, input.attachment.point)) return passThroughWindow(blocks)
  return Object.freeze({ blocks: windowBlocks, topSpacerRows, bottomSpacerRows, overscanRows: input.overscanRows })
}

export function blockKey(block: TranscriptBlock): string {
  return block.key.kind === "item"
    ? `item:${block.key.itemId}:${block.key.blockId}`
    : `turn-activity:${block.key.turnId}`
}

/** Inclusive/exclusive logical grapheme range addressed by an item render block. */
export function blockGraphemeRange(block: TranscriptItemBlock): Readonly<{ from: number; to: number }> {
  const spans = block.projection.sourceSpans
  let from = spans.findIndex(span => span.to > block.sourceSpan.from)
  if (from < 0) from = spans.length
  let to = spans.findLastIndex(span => span.from < block.sourceSpan.to)
  if (to < 0) to = from
  else to += 1
  return Object.freeze({ from, to })
}

/** Source-less activity decoration can never satisfy a logical item target. */
export function pointIsMaterialized(blocks: readonly TranscriptBlock[], point: LogicalPoint): boolean {
  if (!Number.isInteger(point.graphemeOffset) || point.graphemeOffset < 0) return false
  return blocks.some(block => {
    if (!("projection" in block) || block.key.itemId !== point.itemId || point.graphemeOffset > block.projection.sourceSpans.length) return false
    const sourceOffset = block.projection.sourceSpans[point.graphemeOffset]?.from ?? block.projection.source.length
    const ownsEnd = block.sourceSpan.to === block.projection.source.length
    return sourceOffset >= block.sourceSpan.from
      && (sourceOffset < block.sourceSpan.to || (ownsEnd && sourceOffset === block.sourceSpan.to))
  })
}
