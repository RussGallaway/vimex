import {
  effectiveItemStatus,
  type ConversationItem,
  type ConversationState,
  type ItemId,
  type ItemStatus,
  type Turn,
} from "@vimex/conversation"
import type { SourceSpan, TextProjection } from "../domain/transcript-document"
import { projectMarkdown } from "../domain/markdown-source-map"
import type {
  Immutable,
  BuildTranscriptBlocksInput,
  TranscriptBlock,
  TranscriptBlockItem,
  TranscriptBlockProjection,
  TranscriptItemBlock,
  TranscriptTurnActivityBlock,
} from "./types"

/** Terminal turn metadata is presentation decoration, not transcript content. */
export function hasTurnActivity(turn: Turn): boolean {
  return (
    turn.status === "failed" ||
    turn.status === "interrupted" ||
    (turn.status === "complete" &&
      (turn.durationMs !== undefined ||
        (turn.startedAt !== undefined && turn.completedAt !== undefined)))
  )
}

function turnActivityRevision(turn: Turn): number {
  const value = `${turn.status}\u0000${turn.startedAt ?? ""}\u0000${turn.completedAt ?? ""}\u0000${turn.durationMs ?? ""}`
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index++)
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619)
  return hash >>> 0
}

function immutableClone<T>(value: T): Immutable<T> {
  if (Array.isArray(value))
    return Object.freeze(
      value.map((entry) => immutableClone(entry)),
    ) as Immutable<T>
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          immutableClone(entry),
        ]),
      ),
    ) as Immutable<T>
  }
  return value as Immutable<T>
}

const itemSnapshots = new WeakMap<
  ConversationItem,
  Map<ItemStatus, TranscriptBlockItem>
>()
const itemRevisions = new WeakMap<
  ConversationItem,
  Map<string, WeakMap<TextProjection, number>>
>()
const itemBlockPlans = new WeakMap<
  ConversationItem,
  WeakMap<TextProjection, Map<string, readonly TranscriptItemBlock[]>>
>()
let nextItemRevision = 1

const commandFragmentSourceLimit = 4_096
const markdownFragmentSourceLimit = 4_096
const markdownFragmentUnitLimit = 12
const editFragmentFileLimit = 1

function estimatedDiffBodyRows(patch: string): number {
  // Native diff rows omit Git/file headers and hunk markers.
  let rows = 0
  let inHunk = false
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false
      continue
    }
    if (line.startsWith("@@")) {
      inHunk = true
      continue
    }
    if (
      inHunk &&
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))
    )
      rows++
  }
  return rows
}

function snapshotItem(
  conversation: ConversationState,
  item: ConversationItem,
): TranscriptBlockItem {
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

function snapshotProjection(
  projection: TextProjection,
): TranscriptBlockProjection {
  // TextProjection is deeply readonly at the domain boundary. Sharing it
  // avoids cloning every grapheme source span again on each streaming cadence.
  return projection
}

function itemContentRevision(
  sourceItem: ConversationItem,
  status: ItemStatus,
  sourceProjection: TextProjection,
  followedByActivity: boolean,
): number {
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

function estimatedTextRows(text: string): number {
  if (!text) return 0
  // A running command can grow without bound before it is fragmentable. Keep
  // each publication's estimate independent of its complete output length.
  const limit = Math.min(text.length, commandFragmentSourceLimit)
  let rows = 1
  for (let index = 0; index < limit; index++)
    if (text.charCodeAt(index) === 10) rows++
  return rows
}

function estimatedRootRows(item: ConversationItem, folded: boolean): number {
  if (
    item.kind !== "command" &&
    item.kind !== "tool" &&
    item.kind !== "unknown"
  )
    return 1
  if (folded) return 1
  const detailRows = estimatedTextRows(item.detail)
  const commandRows =
    item.kind === "command" ? estimatedTextRows(item.executionCommand ?? "") : 0
  return (
    4 +
    (commandRows > 0 ? commandRows + 2 : 0) +
    (detailRows > 0 ? detailRows + 2 : 0)
  )
}

/** Builds the source-less terminal decoration for one canonical turn. */
export function buildTranscriptTurnActivityBlock(
  turn: Turn,
): TranscriptTurnActivityBlock | undefined {
  if (!hasTurnActivity(turn)) return undefined
  return Object.freeze({
    key: Object.freeze({ kind: "turn-activity" as const, turnId: turn.id }),
    turn: snapshotTurn(turn),
    contentRevision: turnActivityRevision(turn),
    estimatedRows: 3,
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
    sourceSpan: Object.freeze({
      from: 0,
      to: projectionSnapshot.source.length,
    }),
    contentRevision: itemContentRevision(
      item,
      status,
      projection,
      followedByActivity,
    ),
    estimatedRows: estimatedRootRows(
      itemSnapshot,
      Boolean(input.transcript.folded[itemId]),
    ),
    followedByActivity,
  })
}

function commandDetailChunks(
  detail: string,
  firstLimit: number,
): readonly Readonly<{ from: number; to: number }>[] | undefined {
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
  let chunkFrom = 0,
    chunkTo = 0,
    limit = firstLimit
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
  if (
    !sourceItem ||
    sourceItem.kind !== "command" ||
    !projection ||
    input.transcript.folded[itemId] ||
    effectiveItemStatus(input.conversation, sourceItem) === "running" ||
    projection.plain !== projection.source ||
    projection.source.includes("\r")
  )
    return undefined
  const source = [
    sourceItem.title,
    sourceItem.executionCommand,
    sourceItem.detail,
  ]
    .filter(Boolean)
    .join("\n")
  if (
    source !== projection.source ||
    sourceItem.detail.length <= commandFragmentSourceLimit
  )
    return undefined
  const detailFrom = source.length - sourceItem.detail.length
  const chunks = commandDetailChunks(
    sourceItem.detail,
    commandFragmentSourceLimit - detailFrom,
  )
  if (!chunks) return undefined
  if (
    chunks.some(
      (chunk, index) =>
        index < chunks.length - 1 &&
        sourceItem.detail.slice(chunk.from, chunk.to - 1).length === 0,
    )
  )
    return undefined

  const status = effectiveItemStatus(input.conversation, sourceItem)
  const item = snapshotItem(input.conversation, sourceItem)
  if (item.kind !== "command") return undefined
  const revision = itemContentRevision(
    sourceItem,
    status,
    projection,
    followedByActivity,
  )
  const count = chunks.length
  const blocks = chunks.map((chunk, index): TranscriptItemBlock => {
    const first = index === 0,
      last = index === count - 1
    const detail = sourceItem.detail.slice(chunk.from, chunk.to)
    const renderItem: TranscriptBlockItem = Object.freeze(
      first
        ? { ...item, detail }
        : { ...item, title: "", executionCommand: undefined, detail },
    ) as TranscriptBlockItem
    const from = first ? 0 : detailFrom + chunk.from
    const to = detailFrom + chunk.to
    return Object.freeze({
      key: Object.freeze({
        kind: "item" as const,
        itemId,
        blockId: first ? "command:header" : `command:output:${chunk.from}`,
      }),
      turnId: sourceItem.turnId,
      item,
      renderItem,
      projection,
      sourceSpan: Object.freeze({ from, to }),
      contentRevision: revision,
      estimatedRows: Math.max(1, detail.split("\n").length + (first ? 4 : 0)),
      fragment: Object.freeze({
        kind: first ? ("command-header" as const) : ("command-output" as const),
        index,
        count,
      }),
      followedByActivity: last && followedByActivity,
    })
  })
  if (
    blocks[0]?.sourceSpan.from !== 0 ||
    blocks.at(-1)?.sourceSpan.to !== projection.source.length ||
    blocks.some(
      (block, index) =>
        index > 0 && blocks[index - 1]!.sourceSpan.to !== block.sourceSpan.from,
    )
  )
    return undefined
  return Object.freeze(blocks)
}

function markdownAtoms(
  source: string,
): readonly Readonly<SourceSpan>[] | undefined {
  if (
    source.includes("\r") ||
    source.includes("\n\n\n") ||
    /\n[ \t]+\n/u.test(source)
  )
    return undefined
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
        fence = {
          marker: open[2][0] as "`" | "~",
          width: open[2].length,
          from: lineFrom,
        }
      } else if (
        /^(?: {4}|\t| {0,3}(?:>|(?:[-+*]|\d+[.)])\s|\[[^\]]+\]:|<(?:!--|\/?[A-Za-z])))/u.test(
          line,
        )
      ) {
        return undefined
      }
    }
    if (newline < 0) break
    lineFrom = newlineTo
  }
  if (fence) return undefined

  const cuts: number[] = []
  for (const match of source.matchAll(/\n\n/gu)) {
    if (
      !fenced.some(
        (span) => match.index >= span.from && match.index + 2 <= span.to,
      )
    )
      cuts.push(match.index + 2)
  }
  if (!cuts.length) return undefined
  const atoms: SourceSpan[] = []
  let from = 0
  for (const to of cuts) {
    if (to <= from) return undefined
    atoms.push(Object.freeze({ from, to }))
    from = to
  }
  if (from < source.length)
    atoms.push(Object.freeze({ from, to: source.length }))
  return atoms.length > 1 ? Object.freeze(atoms) : undefined
}

function markdownChunks(
  source: string,
): readonly Readonly<SourceSpan>[] | undefined {
  const atoms = markdownAtoms(source)
  if (!atoms) return undefined
  const chunks: SourceSpan[] = []
  let from = atoms[0]!.from,
    to = from,
    units = 0
  for (const atom of atoms) {
    if (atom.to - atom.from > markdownFragmentSourceLimit) return undefined
    if (
      to > from &&
      (atom.to - from > markdownFragmentSourceLimit ||
        units >= markdownFragmentUnitLimit)
    ) {
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

function markdownChunksCompose(
  projection: TextProjection,
  chunks: readonly Readonly<SourceSpan>[],
): boolean {
  let plain = "",
    graphemeOffset = 0
  const spans: SourceSpan[] = []
  const links: TextProjection["links"][number][] = []
  const regions: NonNullable<TextProjection["sourceRegions"]>[number][] = []
  for (const chunk of chunks) {
    const local = projectMarkdown(projection.source.slice(chunk.from, chunk.to))
    plain += local.plain
    spans.push(
      ...local.sourceSpans.map((span) => ({
        from: span.from + chunk.from,
        to: span.to + chunk.from,
      })),
    )
    links.push(
      ...local.links.map((link) => ({
        ...link,
        from: link.from + graphemeOffset,
        to: link.to + graphemeOffset,
      })),
    )
    regions.push(
      ...(local.sourceRegions ?? []).map((region) => ({
        ...region,
        from: region.from + graphemeOffset,
        to: region.to + graphemeOffset,
        sourceFrom: region.sourceFrom + chunk.from,
        sourceTo: region.sourceTo + chunk.from,
      })),
    )
    graphemeOffset += local.sourceSpans.length
  }
  const expectedRegions = projection.sourceRegions ?? []
  return (
    plain === projection.plain &&
    spans.length === projection.sourceSpans.length &&
    spans.every(
      (span, index) =>
        span.from === projection.sourceSpans[index]?.from &&
        span.to === projection.sourceSpans[index]?.to,
    ) &&
    links.length === projection.links.length &&
    links.every(
      (link, index) =>
        link.from === projection.links[index]?.from &&
        link.to === projection.links[index]?.to &&
        link.url === projection.links[index]?.url,
    ) &&
    regions.length === expectedRegions.length &&
    regions.every(
      (region, index) =>
        region.from === expectedRegions[index]?.from &&
        region.to === expectedRegions[index]?.to &&
        region.sourceFrom === expectedRegions[index]?.sourceFrom &&
        region.sourceTo === expectedRegions[index]?.sourceTo,
    )
  )
}

function markdownItemBlocks(
  input: Pick<BuildTranscriptBlocksInput, "conversation" | "transcript">,
  itemId: ItemId,
  followedByActivity: boolean,
): readonly TranscriptItemBlock[] | undefined {
  const sourceItem = input.conversation.items[itemId]
  const projection = input.transcript.projectionById[itemId]
  if (
    !sourceItem ||
    (sourceItem.kind !== "assistant" && sourceItem.kind !== "user") ||
    !projection ||
    input.transcript.folded[itemId] ||
    effectiveItemStatus(input.conversation, sourceItem) === "running" ||
    projection.source !== sourceItem.markdown ||
    projection.source.length <= markdownFragmentSourceLimit
  )
    return undefined
  const chunks = markdownChunks(projection.source)
  if (!chunks || !markdownChunksCompose(projection, chunks)) return undefined
  const status = effectiveItemStatus(input.conversation, sourceItem)
  const item = snapshotItem(input.conversation, sourceItem)
  if (item.kind !== "assistant" && item.kind !== "user") return undefined
  const revision = itemContentRevision(
    sourceItem,
    status,
    projection,
    followedByActivity,
  )
  const count = chunks.length
  return Object.freeze(
    chunks.map((chunk, index): TranscriptItemBlock =>
      Object.freeze({
        key: Object.freeze({
          kind: "item" as const,
          itemId,
          blockId: `markdown:${chunk.from}`,
        }),
        turnId: sourceItem.turnId,
        item,
        renderItem: Object.freeze({
          ...item,
          markdown: projection.source.slice(chunk.from, chunk.to),
        }),
        projection,
        sourceSpan: chunk,
        contentRevision: revision,
        estimatedRows: Math.max(
          1,
          projection.source.slice(chunk.from, chunk.to).split("\n").length +
            (index > 0 ? 1 : 0),
        ),
        fragment: Object.freeze({ kind: "markdown" as const, index, count }),
        followedByActivity: index === count - 1 && followedByActivity,
      }),
    ),
  )
}

function editItemBlocks(
  input: Pick<BuildTranscriptBlocksInput, "conversation" | "transcript">,
  itemId: ItemId,
  followedByActivity: boolean,
): readonly TranscriptItemBlock[] | undefined {
  const sourceItem = input.conversation.items[itemId]
  const projection = input.transcript.projectionById[itemId]
  if (
    !sourceItem ||
    sourceItem.kind !== "edit" ||
    !projection ||
    input.transcript.folded[itemId] ||
    effectiveItemStatus(input.conversation, sourceItem) === "running" ||
    sourceItem.patch.includes("\r") ||
    projection.plain !== sourceItem.patch ||
    projection.source !== sourceItem.patch ||
    !sourceItem.changes ||
    sourceItem.changes.length < 2 ||
    sourceItem.changes.some((change) => !change.patch) ||
    sourceItem.changes.map((change) => change.patch).join("\n") !==
      sourceItem.patch
  )
    return undefined
  const status = effectiveItemStatus(input.conversation, sourceItem)
  const item = snapshotItem(input.conversation, sourceItem)
  if (item.kind !== "edit" || !item.changes) return undefined
  const revision = itemContentRevision(
    sourceItem,
    status,
    projection,
    followedByActivity,
  )
  const groups = Array.from(
    { length: Math.ceil(item.changes.length / editFragmentFileLimit) },
    (_, index) =>
      Object.freeze(
        item.changes!.slice(
          index * editFragmentFileLimit,
          (index + 1) * editFragmentFileLimit,
        ),
      ),
  )
  const count = groups.length
  let from = 0
  return Object.freeze(
    groups.map((changes, index): TranscriptItemBlock => {
      const contentLength = changes.reduce(
        (length, change, localIndex) =>
          length +
          change.patch.length +
          (localIndex < changes.length - 1 ? 1 : 0),
        0,
      )
      const to = from + contentLength + (index < count - 1 ? 1 : 0)
      const span = Object.freeze({ from, to })
      const block = Object.freeze({
        key: Object.freeze({
          kind: "item" as const,
          itemId,
          blockId: index === 0 ? "edit:header" : `edit:file:${from}`,
        }),
        turnId: sourceItem.turnId,
        item,
        renderItem: Object.freeze({
          ...item,
          patch: projection.source.slice(from, to),
          changes,
        }),
        projection,
        sourceSpan: span,
        contentRevision: revision,
        estimatedRows: Math.max(
          1,
          changes.reduce(
            (rows, change) => rows + estimatedDiffBodyRows(change.patch) + 1,
            index === 0 ? 2 : 0,
          ),
        ),
        fragment: Object.freeze({
          kind: index === 0 ? ("edit-header" as const) : ("edit-file" as const),
          index,
          count,
        }),
        followedByActivity: index === count - 1 && followedByActivity,
      })
      from = to
      return block
    }),
  )
}

/** Builds the complete render plan for one semantic item, with an exact root fallback. */
export function buildTranscriptItemBlocks(
  input: Pick<
    BuildTranscriptBlocksInput,
    "conversation" | "transcript" | "canonicalGeneration" | "threadId"
  >,
  itemId: ItemId,
): readonly TranscriptItemBlock[] {
  const sourceItem = input.conversation.items[itemId]
  const projection = input.transcript.projectionById[itemId]
  if (!sourceItem || !projection) return Object.freeze([])
  const turn = input.conversation.turns[sourceItem.turnId]
  const lastSemanticItemId = turn?.itemIds.findLast((candidate) =>
    Boolean(
      input.conversation.items[candidate] &&
      input.transcript.projectionById[candidate],
    ),
  )
  const followedByActivity = Boolean(
    turn && lastSemanticItemId === itemId && hasTurnActivity(turn),
  )
  const cacheKey = `${input.threadId ?? ""}:${input.canonicalGeneration ?? 0}:${effectiveItemStatus(input.conversation, sourceItem)}:${input.transcript.folded[itemId] ? 1 : 0}:${followedByActivity ? 1 : 0}`
  let byProjection = itemBlockPlans.get(sourceItem)
  if (!byProjection) {
    byProjection = new WeakMap()
    itemBlockPlans.set(sourceItem, byProjection)
  }
  let byPresentation = byProjection.get(projection)
  if (!byPresentation) {
    byPresentation = new Map()
    byProjection.set(projection, byPresentation)
  }
  const cached = byPresentation.get(cacheKey)
  if (cached) return cached
  const fragmented =
    commandItemBlocks(input, itemId, followedByActivity) ??
    markdownItemBlocks(input, itemId, followedByActivity) ??
    editItemBlocks(input, itemId, followedByActivity)
  const root = fragmented
    ? undefined
    : rootItemBlock(input, itemId, followedByActivity)
  const blocks = fragmented ?? Object.freeze(root ? [root] : [])
  byPresentation.set(cacheKey, blocks)
  return blocks
}

/** Builds the Stage 2 root block for one known semantic item. */
export function buildTranscriptItemBlock(
  input: Pick<
    BuildTranscriptBlocksInput,
    "conversation" | "transcript" | "canonicalGeneration" | "threadId"
  >,
  itemId: ItemId,
): TranscriptItemBlock | undefined {
  const blocks = buildTranscriptItemBlocks(input, itemId)
  return blocks.length === 1 ? blocks[0] : undefined
}

/**
 * Builds the Stage 2 pass-through block plan from canonical chronology.
 * Activity blocks deliberately have no source span and therefore no logical
 * transcript target.
 */
export function buildTranscriptBlocks(
  input: BuildTranscriptBlocksInput,
): readonly TranscriptBlock[] {
  const { conversation, transcript } = input
  const excluded =
    input.excludedTurnIds instanceof Set
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
