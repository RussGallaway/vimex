import type {
  LogicalPoint,
  TranscriptState,
} from "../domain/transcript-document"
import type {
  TranscriptBlock,
  TranscriptItemBlock,
  TranscriptActivityFamily,
  TranscriptActivityBatch,
  TranscriptActivityPresentation,
  TranscriptWindow,
} from "./types"
import { blockKey, blockGraphemeRange } from "./addressing"

interface ActivityCandidate {
  readonly family: TranscriptActivityFamily
  readonly key: string
  readonly label: string
  readonly noun: string
  readonly plural: string
}

function activityCandidate(
  block: TranscriptBlock,
): ActivityCandidate | undefined {
  if (
    !("item" in block) ||
    (block.item.kind !== "command" && block.item.kind !== "tool") ||
    block.item.status !== "complete"
  )
    return undefined
  const activity = block.item.activity
  if (activity?.family === "web-research")
    return {
      family: "web-research",
      key: "web-research",
      label: "Web research",
      noun: "search",
      plural: "searches",
    }
  if (activity?.family === "read")
    return {
      family: "read",
      key: "read",
      label: "Read files",
      noun: "read",
      plural: "reads",
    }
  if (activity?.family !== "provider" || !activity.label) return undefined
  return {
    family: "provider",
    key: `provider:${activity.label.toLowerCase()}`,
    label: activity.label,
    noun: "action",
    plural: "actions",
  }
}

function sameValues<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function sameActivityBatch(
  left: TranscriptActivityBatch,
  right: TranscriptActivityBatch,
): boolean {
  return (
    left.key === right.key &&
    left.turnId === right.turnId &&
    left.family === right.family &&
    left.label === right.label &&
    left.countLabel === right.countLabel &&
    left.leadItemId === right.leadItemId &&
    left.durationMs === right.durationMs &&
    sameValues(left.itemIds, right.itemIds) &&
    left.followedByActivity === right.followedByActivity &&
    sameValues(left.blockKeys, right.blockKeys) &&
    sameValues(left.blockItemIds, right.blockItemIds) &&
    left.leadGraphemeFrom === right.leadGraphemeFrom &&
    left.leadGraphemeTo === right.leadGraphemeTo &&
    left.leadIncludesEnd === right.leadIncludesEnd
  )
}

export function activityBatches(
  blocks: readonly TranscriptBlock[],
  prior: readonly TranscriptActivityBatch[] = [],
): readonly TranscriptActivityBatch[] {
  const batches: TranscriptActivityBatch[] = []
  const priorByKey = new Map(prior.map((batch) => [batch.key, batch]))
  let run:
    | {
        candidate: ActivityCandidate
        items: TranscriptItemBlock[]
        blocks: TranscriptItemBlock[]
      }
    | undefined
  const flush = () => {
    if (!run || run.items.length < 2) {
      run = undefined
      return
    }
    const itemIds = Object.freeze(run.items.map((block) => block.key.itemId))
    const blockKeys = Object.freeze(run.blocks.map(blockKey))
    const blockItemIds = Object.freeze(
      run.blocks.map((block) => block.key.itemId),
    )
    const leadRange = blockGraphemeRange(run.blocks[0]!)
    const count = itemIds.length
    const durations = run.items.map((block) => block.item.durationMs)
    const durationMs = durations.every(
      (value) => value !== undefined && Number.isFinite(value) && value > 0,
    )
      ? durations.reduce<number>((sum, value) => sum + value!, 0)
      : undefined
    const candidate = Object.freeze({
      key: `${run.candidate.key}:${itemIds[0]}`,
      turnId: run.items[0]!.turnId,
      family: run.candidate.family,
      label: run.candidate.label,
      countLabel: `${count} ${count === 1 ? run.candidate.noun : run.candidate.plural}`,
      leadItemId: itemIds[0]!,
      itemIds,
      blockKeys,
      blockItemIds,
      leadGraphemeFrom: leadRange.from,
      leadGraphemeTo: leadRange.to,
      leadIncludesEnd:
        leadRange.to === run.blocks[0]!.projection.sourceSpans.length,
      followedByActivity: run.blocks.at(-1)!.followedByActivity,
      ...(durationMs === undefined ? {} : { durationMs }),
    })
    const previous = priorByKey.get(candidate.key)
    batches.push(
      previous && sameActivityBatch(previous, candidate) ? previous : candidate,
    )
    run = undefined
  }
  for (const block of blocks) {
    const candidate = activityCandidate(block)
    if (!candidate || !("item" in block)) {
      flush()
      continue
    }
    if (run?.blocks.at(-1)?.key.itemId === block.key.itemId) {
      run.blocks.push(block)
      continue
    }
    if (
      !run ||
      run.candidate.key !== candidate.key ||
      run.items[0]!.turnId !== block.turnId
    ) {
      flush()
      run = { candidate, items: [block], blocks: [block] }
    } else {
      run.items.push(block)
      run.blocks.push(block)
    }
  }
  flush()
  return Object.freeze(batches)
}

export function transcriptActivityPresentation(
  window: Pick<TranscriptWindow, "activityBatches">,
  state: Pick<TranscriptState, "folded" | "cursor" | "selection" | "viewport">,
  prior: Readonly<Record<string, TranscriptActivityPresentation>> = {},
): Readonly<Record<string, TranscriptActivityPresentation>> {
  const result: Record<string, TranscriptActivityPresentation> = {}
  const protectedPoints = [
    state.cursor,
    state.viewport.kind === "point" ? state.viewport.point : undefined,
    state.selection?.anchor,
    state.selection?.head,
  ].filter((point): point is LogicalPoint => Boolean(point))
  for (const batch of window.activityBatches) {
    if (!batch.itemIds.every((id) => state.folded[id] === true)) continue
    if (
      protectedPoints.some((point) => {
        if (!batch.itemIds.includes(point.itemId)) return false
        if (point.itemId !== batch.leadItemId) return true
        return (
          point.graphemeOffset < batch.leadGraphemeFrom ||
          point.graphemeOffset > batch.leadGraphemeTo ||
          (point.graphemeOffset === batch.leadGraphemeTo &&
            !batch.leadIncludesEnd)
        )
      })
    )
      continue
    batch.blockKeys.forEach((key, index) => {
      const kind = index === 0 ? "activity-lead" : "activity-hidden"
      const itemId = batch.blockItemIds[index]!
      const previous = prior[key]
      result[key] =
        previous?.kind === kind &&
        previous.batch === batch &&
        previous.itemId === itemId
          ? previous
          : Object.freeze({ kind, batch, itemId })
    })
  }
  return Object.freeze(result)
}

function sameActivityPresentation(
  left: Readonly<Record<string, TranscriptActivityPresentation>>,
  right: Readonly<Record<string, TranscriptActivityPresentation>>,
): boolean {
  const leftEntries = Object.entries(left),
    rightEntries = Object.entries(right)
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value]) =>
        right[key]?.kind === value.kind && right[key]?.batch === value.batch,
    )
  )
}

export function windowWithActivityPlan(
  blocks: readonly TranscriptBlock[],
  batches: readonly TranscriptActivityBatch[],
  state: Pick<TranscriptState, "folded" | "cursor" | "selection" | "viewport">,
  prior: TranscriptWindow | undefined,
  topSpacerRows: number,
  bottomSpacerRows: number,
  overscanRows: number,
): TranscriptWindow {
  const activityBatchByItem =
    prior?.activityBatches === batches
      ? prior.activityBatchByItem
      : Object.freeze(
          Object.fromEntries(
            batches.flatMap((batch) =>
              batch.itemIds.map((itemId) => [itemId, batch]),
            ),
          ),
        )
  const selected = transcriptActivityPresentation(
    { activityBatches: batches },
    state,
    prior?.activityPresentation,
  )
  const presentation =
    prior && sameActivityPresentation(prior.activityPresentation, selected)
      ? prior.activityPresentation
      : selected
  if (
    prior &&
    prior.blocks === blocks &&
    prior.activityBatches === batches &&
    prior.activityPresentation === presentation &&
    prior.topSpacerRows === topSpacerRows &&
    prior.bottomSpacerRows === bottomSpacerRows &&
    prior.overscanRows === overscanRows
  )
    return prior
  return Object.freeze({
    blocks,
    activityBatches: batches,
    activityBatchByItem,
    activityPresentation: presentation,
    topSpacerRows,
    bottomSpacerRows,
    overscanRows,
  })
}

export const neutralActivityState: Pick<
  TranscriptState,
  "folded" | "cursor" | "selection" | "viewport"
> = Object.freeze({
  folded: Object.freeze({}),
  viewport: Object.freeze({ kind: "tail" as const }),
})

/** Stage 2 materializes every planned block; Stage 5 replaces this policy. */
export function passThroughWindow(
  blocks: readonly TranscriptBlock[],
  state: Pick<
    TranscriptState,
    "folded" | "cursor" | "selection" | "viewport"
  > = neutralActivityState,
  prior?: TranscriptWindow,
): TranscriptWindow {
  return windowWithActivityPlan(
    blocks,
    activityBatches(blocks, prior?.activityBatches),
    state,
    prior,
    0,
    0,
    0,
  )
}

/** Preserve a settled activity plan during O(changed-item) reconciliation. */
export function passThroughWindowWithActivityPlan(
  blocks: readonly TranscriptBlock[],
  prior: TranscriptWindow,
  state: TranscriptState,
): TranscriptWindow {
  return windowWithActivityPlan(
    blocks,
    prior.activityBatches,
    state,
    prior,
    0,
    0,
    0,
  )
}
