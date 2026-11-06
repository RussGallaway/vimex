import type { LogicalPoint } from "../domain/transcript-document"
import type { TranscriptHeightIndex } from "../height-index"
import type {
  TranscriptBlock,
  TranscriptItemBlock,
  TranscriptWindowDiagnostics,
} from "./types"

function targetLookupVisit(
  diagnostics: TranscriptWindowDiagnostics | undefined,
): void {
  if (diagnostics) diagnostics.targetLookupVisits += 1
}

/** Resolve one logical point without consulting native nodes or terminal coordinates. */
export function transcriptPointBlockIndex(
  blocks: readonly TranscriptBlock[],
  heights: TranscriptHeightIndex,
  point: LogicalPoint,
  diagnostics: TranscriptWindowDiagnostics | undefined,
): number | undefined {
  if (!Number.isInteger(point.graphemeOffset) || point.graphemeOffset < 0)
    return undefined

  targetLookupVisit(diagnostics)
  const itemIndexes = heights.itemBlockIndexes(point.itemId)
  if (!itemIndexes?.length) return undefined
  const first = blocks[itemIndexes[0]!]
  targetLookupVisit(diagnostics)
  if (
    !first ||
    !("projection" in first) ||
    first.key.itemId !== point.itemId ||
    point.graphemeOffset > first.projection.sourceSpans.length
  )
    return undefined
  const sourceOffset =
    first.projection.sourceSpans[point.graphemeOffset]?.from ??
    first.projection.source.length

  // Item block ordinals are ordered by non-overlapping source-span starts. The
  // last start at or before the target owns a boundary, subject to the final
  // materialization check for gaps and the item-end point.
  let low = 0
  let high = itemIndexes.length
  while (low < high) {
    const middle = low + ((high - low) >>> 1)
    const block = blocks[itemIndexes[middle]!]
    targetLookupVisit(diagnostics)
    if (!block || !("projection" in block) || block.key.itemId !== point.itemId)
      return undefined
    if (block.sourceSpan.from <= sourceOffset) low = middle + 1
    else high = middle
  }
  if (low === 0) return undefined
  const blockIndex = itemIndexes[low - 1]!
  const block = blocks[blockIndex]
  targetLookupVisit(diagnostics)
  return block && pointIsMaterialized([block], point) ? blockIndex : undefined
}

export function blockKey(block: TranscriptBlock): string {
  return block.key.kind === "item"
    ? `item:${block.key.itemId}:${block.key.blockId}`
    : `turn-activity:${block.key.turnId}`
}

/** Inclusive/exclusive logical grapheme range addressed by an item render block. */
export function blockGraphemeRange(
  block: TranscriptItemBlock,
): Readonly<{ from: number; to: number }> {
  const spans = block.projection.sourceSpans
  let from = spans.findIndex((span) => span.to > block.sourceSpan.from)
  if (from < 0) from = spans.length
  let to = spans.findLastIndex((span) => span.from < block.sourceSpan.to)
  if (to < 0) to = from
  else to += 1
  return Object.freeze({ from, to })
}

/** Source-less activity decoration can never satisfy a logical item target. */
export function pointIsMaterialized(
  blocks: readonly TranscriptBlock[],
  point: LogicalPoint,
): boolean {
  if (!Number.isInteger(point.graphemeOffset) || point.graphemeOffset < 0)
    return false
  return blocks.some((block) => {
    if (
      !("projection" in block) ||
      block.key.itemId !== point.itemId ||
      point.graphemeOffset > block.projection.sourceSpans.length
    )
      return false
    const sourceOffset =
      block.projection.sourceSpans[point.graphemeOffset]?.from ??
      block.projection.source.length
    const ownsEnd = block.sourceSpan.to === block.projection.source.length
    return (
      sourceOffset >= block.sourceSpan.from &&
      (sourceOffset < block.sourceSpan.to ||
        (ownsEnd && sourceOffset === block.sourceSpan.to))
    )
  })
}
