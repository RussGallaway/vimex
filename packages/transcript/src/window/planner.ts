import type {
  PlanTranscriptWindowInput,
  TranscriptBlock,
  TranscriptWindow,
} from "./types"
import {
  activityBatches,
  neutralActivityState,
  passThroughWindow,
  windowWithActivityPlan,
} from "./activity"
import {
  blockKey,
  pointIsMaterialized,
  transcriptPointBlockIndex,
} from "./addressing"

function validPlannerCount(value: number, positive = false): boolean {
  return Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum))
}

/**
 * Pure renderer-neutral window planner. Unknown or internally inconsistent
 * relationships take the exact pass-through path rather than guessing.
 */
export function planTranscriptWindow(
  input: PlanTranscriptWindowInput,
): TranscriptWindow {
  const { blocks, heights } = input
  const state = input.state ?? neutralActivityState
  const activityPlan = input.activityPlan
  if (blocks.length === 0)
    return passThroughWindow(Object.freeze([]), state, input.prior)
  if (
    !validPlannerCount(input.viewportRows, true) ||
    !validPlannerCount(input.overscanRows) ||
    (input.recentTailBlocks !== undefined &&
      !validPlannerCount(input.recentTailBlocks)) ||
    (input.recentTailRows !== undefined &&
      !validPlannerCount(input.recentTailRows, true)) ||
    (input.olderLookAheadRows !== undefined &&
      !validPlannerCount(input.olderLookAheadRows)) ||
    !heights.supports(blocks) ||
    heights.blockCount !== blocks.length ||
    !validPlannerCount(heights.totalRows, true)
  )
    return passThroughWindow(blocks, state, input.prior)

  let focusIndex: number | undefined
  let preferredScreenRow = 0
  if (input.attachment.kind === "point") {
    if (
      !Number.isSafeInteger(input.attachment.preferredScreenRow) ||
      (input.attachment.blockLocalRow !== undefined &&
        (!Number.isSafeInteger(input.attachment.blockLocalRow) ||
          input.attachment.blockLocalRow < 0))
    )
      return passThroughWindow(blocks, state, input.prior)
    focusIndex = transcriptPointBlockIndex(
      blocks,
      heights,
      input.attachment.point,
      input.diagnostics,
    )
    if (focusIndex === undefined)
      return passThroughWindow(blocks, state, input.prior)
    preferredScreenRow = clamp(
      input.attachment.preferredScreenRow,
      0,
      input.viewportRows - 1,
    )
  }

  const maximumVisibleStart = Math.max(
    0,
    heights.totalRows - input.viewportRows,
  )
  const focusRange =
    input.attachment.kind === "point"
      ? heights.rowRange(focusIndex!, focusIndex! + 1)
      : undefined
  if (input.attachment.kind === "point" && !focusRange)
    return passThroughWindow(blocks, state, input.prior)
  const blockLocalRow =
    input.attachment.kind === "point"
      ? clamp(
          input.attachment.blockLocalRow ?? 0,
          0,
          Math.max(0, focusRange!.rows - 1),
        )
      : 0
  let visibleStart =
    input.attachment.kind === "tail"
      ? maximumVisibleStart
      : clamp(
          focusRange!.start +
            blockLocalRow -
            Math.min(preferredScreenRow, input.viewportRows - 1),
          0,
          maximumVisibleStart,
        )
  let visibleEnd = Math.min(
    heights.totalRows,
    visibleStart + input.viewportRows,
  )
  let plannedFrom = Math.max(0, visibleStart - input.overscanRows)
  let plannedTo =
    input.attachment.kind === "tail"
      ? heights.totalRows
      : Math.min(heights.totalRows, visibleEnd + input.overscanRows)

  if (input.reveal) {
    const revealIndex = transcriptPointBlockIndex(
      blocks,
      heights,
      input.reveal,
      input.diagnostics,
    )
    if (revealIndex === undefined)
      return passThroughWindow(blocks, state, input.prior)
    const revealRange = heights.rowRange(revealIndex, revealIndex + 1)
    if (!revealRange) return passThroughWindow(blocks, state, input.prior)
    const alreadyPlanned =
      revealRange.end > plannedFrom && revealRange.start < plannedTo
    if (!alreadyPlanned) {
      preferredScreenRow = Math.floor((input.viewportRows - 1) / 2)
      visibleStart = clamp(
        revealRange.start - preferredScreenRow,
        0,
        maximumVisibleStart,
      )
      visibleEnd = Math.min(
        heights.totalRows,
        visibleStart + input.viewportRows,
      )
      plannedFrom = Math.max(0, visibleStart - input.overscanRows)
      plannedTo = Math.min(heights.totalRows, visibleEnd + input.overscanRows)
    }
  }

  // Give both ends the same prepared area: `gg` followed by downward paging
  // should have as much content ready as upward paging from the tail. Beyond
  // either area's inward boundary, taper retained content instead of dropping
  // it all at once. The ordinary visible window still bounds distant history.
  // The legacy tail-named policy fields deliberately share both edge budgets.
  const recentTailBlocks = input.recentTailBlocks ?? 0
  if (!input.retainWindow && recentTailBlocks > 0) {
    let headEnd = Math.min(blocks.length, recentTailBlocks)
    let tailStart = Math.max(0, blocks.length - recentTailBlocks)
    if (input.recentTailRows !== undefined) {
      const lastHeadRow = Math.min(heights.totalRows, input.recentTailRows) - 1
      const headRowBound = heights.blockAtRow(lastHeadRow)
      if (headRowBound !== undefined)
        headEnd = Math.min(headEnd, headRowBound + 1)
      const earliestRow = Math.max(0, heights.totalRows - input.recentTailRows)
      const rowBound = heights.blockAtRow(earliestRow)
      if (rowBound !== undefined) tailStart = Math.max(tailStart, rowBound)
    }
    const headEndRow = heights.prefixRows(headEnd)
    if (visibleStart < headEndRow) {
      plannedFrom = 0
      plannedTo = Math.max(
        plannedTo,
        Math.min(
          heights.totalRows,
          headEndRow + (input.olderLookAheadRows ?? 0),
        ),
      )
    } else {
      const distanceBelowHead = visibleStart - headEndRow
      plannedFrom = Math.min(plannedFrom, 2 * distanceBelowHead)
    }
    const tailStartRow = heights.prefixRows(tailStart)
    if (visibleEnd > tailStartRow) {
      plannedFrom = Math.min(
        plannedFrom,
        Math.max(0, tailStartRow - (input.olderLookAheadRows ?? 0)),
      )
      plannedTo = heights.totalRows
    } else {
      const distanceAboveTail = tailStartRow - visibleEnd
      plannedTo = Math.max(
        plannedTo,
        Math.max(0, heights.totalRows - 2 * distanceAboveTail),
      )
    }
  }

  if (input.retainWindow) {
    const coreFirst = heights.blockAtRow(plannedFrom)!
    const coreLast = heights.blockAtRow(Math.max(plannedFrom, plannedTo - 1))!
    const rowBudget = Math.max(
      plannedTo - plannedFrom,
      (input.recentTailRows ?? input.viewportRows + 2 * input.overscanRows) +
        (input.olderLookAheadRows ?? 0),
    )
    const blockBudget = Math.max(coreLast - coreFirst + 1, recentTailBlocks)
    const retained = input.retainedWindow?.blocks
    const oldFirst = retained?.length
      ? heights.blockIndex(blockKey(retained[0]!))
      : undefined
    const oldLast = retained?.length
      ? heights.blockIndex(blockKey(retained[retained.length - 1]!))
      : undefined
    const oldFrom =
      oldFirst === undefined ? undefined : heights.prefixRows(oldFirst)
    const oldTo =
      oldLast === undefined ? undefined : heights.prefixRows(oldLast + 1)
    // Retain until the viewport approaches an inner boundary, rather than
    // translating the mounted range on each row movement. Read current indexed
    // heights at stable endpoints; old absolute spacer coordinates can be stale.
    const guard =
      oldFrom === undefined || oldTo === undefined
        ? 0
        : Math.min(
            input.overscanRows,
            Math.max(0, Math.floor((oldTo - oldFrom - input.viewportRows) / 4)),
          )
    if (
      oldFrom !== undefined &&
      oldTo !== undefined &&
      oldFirst! <= oldLast! &&
      oldLast! - oldFirst! + 1 <= blockBudget &&
      oldTo - oldFrom <= 2 * rowBudget &&
      visibleStart >= oldFrom &&
      visibleEnd <= oldTo &&
      (oldFrom === 0 || visibleStart >= oldFrom + guard) &&
      (oldTo === heights.totalRows || visibleEnd <= oldTo - guard)
    ) {
      plannedFrom = oldFrom
      plannedTo = oldTo
    } else {
      const from = clamp(
        visibleStart - Math.floor((rowBudget - input.viewportRows) / 2),
        0,
        Math.max(0, heights.totalRows - rowBudget),
      )
      const to = Math.min(heights.totalRows, from + rowBudget)
      const wantedFirst = heights.blockAtRow(from) ?? coreFirst
      const wantedLast = heights.blockAtRow(Math.max(from, to - 1)) ?? coreLast
      const extraBlocks = blockBudget - (coreLast - coreFirst + 1)
      const beforeBlocks = Math.min(
        coreFirst,
        Math.max(
          Math.floor(extraBlocks / 2),
          extraBlocks - (blocks.length - coreLast - 1),
        ),
      )
      const first = Math.max(wantedFirst, coreFirst - beforeBlocks)
      const last = Math.min(wantedLast, coreLast + extraBlocks - beforeBlocks)
      plannedFrom = Math.min(plannedFrom, heights.prefixRows(first))
      plannedTo = Math.max(plannedTo, heights.prefixRows(last + 1))
    }
  }

  const first = heights.blockAtRow(plannedFrom)
  if (first === undefined || first < 0 || first >= blocks.length)
    return passThroughWindow(blocks, state, input.prior)
  let lastExclusive: number
  if (plannedTo >= heights.totalRows) lastExclusive = blocks.length
  else {
    const atEnd = heights.blockAtRow(plannedTo)
    if (atEnd === undefined || atEnd < first || atEnd >= blocks.length)
      return passThroughWindow(blocks, state, input.prior)
    lastExclusive = heights.prefixRows(atEnd) === plannedTo ? atEnd : atEnd + 1
  }
  if (lastExclusive <= first)
    return passThroughWindow(blocks, state, input.prior)

  const topSpacerRows = heights.prefixRows(first)
  const bottomSpacerRows = heights.totalRows - heights.prefixRows(lastExclusive)
  if (
    !validPlannerCount(topSpacerRows) ||
    !validPlannerCount(bottomSpacerRows) ||
    topSpacerRows +
      (heights.prefixRows(lastExclusive) - topSpacerRows) +
      bottomSpacerRows !==
      heights.totalRows
  ) {
    return passThroughWindow(blocks, state, input.prior)
  }
  // Zero-height batch children stay in the semantic plan but need no native
  // roots. Jump by indexed row so a huge collapsed group stays bounded.
  const selected: TranscriptBlock[] = []
  if (activityPlan?.activityBatches.length) {
    let ordinal = first
    while (ordinal < lastExclusive) {
      const block = blocks[ordinal]!
      if (
        activityPlan.activityPresentation[blockKey(block)]?.kind !==
        "activity-hidden"
      )
        selected.push(block)
      const nextRow = heights.prefixRows(ordinal + 1)
      if (nextRow >= heights.totalRows) break
      const next = heights.blockAtRow(nextRow)
      if (next === undefined || next <= ordinal) break
      ordinal = next
    }
  } else selected.push(...blocks.slice(first, lastExclusive))
  const windowBlocks = Object.freeze(selected)
  if (input.reveal && !pointIsMaterialized(windowBlocks, input.reveal))
    return passThroughWindow(blocks, state, input.prior)
  if (
    !input.reveal &&
    input.attachment.kind === "point" &&
    !pointIsMaterialized(windowBlocks, input.attachment.point)
  )
    return passThroughWindow(blocks, state, input.prior)
  if (activityPlan)
    return Object.freeze({
      ...activityPlan,
      blocks: windowBlocks,
      topSpacerRows,
      bottomSpacerRows,
      overscanRows: input.overscanRows,
    })
  const batches = activityBatches(windowBlocks, input.prior?.activityBatches)
  return windowWithActivityPlan(
    windowBlocks,
    batches,
    state,
    input.prior,
    topSpacerRows,
    bottomSpacerRows,
    input.overscanRows,
  )
}
