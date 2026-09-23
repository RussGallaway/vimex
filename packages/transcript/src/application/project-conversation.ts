import type { ConversationItem } from "@vimex/conversation"
import {
  projectMarkdown,
  projectPlainText,
} from "../domain/markdown-source-map"
import {
  appendTranscriptOrder,
  appendTranscriptUnseenItemId,
  hasTranscriptUnseenItemId,
  inheritTranscriptTextLengthIndex,
  persistentTranscriptFolds,
  persistentTranscriptOrder,
  persistentTranscriptUnseenItemIds,
  setTranscriptFoldValue,
  setTranscriptProjection,
  type LogicalPoint,
  type TextProjection,
  type TranscriptOrderIndexDiagnostics,
  type TranscriptProjectionRecordDiagnostics,
  type TranscriptState,
  type TranscriptTextLengthIndexDiagnostics,
  type TranscriptUnseenItemDiagnostics,
} from "../domain/transcript-document"
import {
  inheritTranscriptUrlIndex,
  type TranscriptUrlIndexDiagnostics,
} from "./transcript-url-index"

export interface TranscriptItemSyncDiagnostics
  extends
    TranscriptProjectionRecordDiagnostics,
    TranscriptTextLengthIndexDiagnostics,
    TranscriptOrderIndexDiagnostics,
    TranscriptUrlIndexDiagnostics,
    TranscriptUnseenItemDiagnostics {}
function sourceOf(item: ConversationItem): string {
  switch (item.kind) {
    case "user":
    case "assistant":
    case "reasoning":
      return item.markdown
    case "edit":
      return item.patch
    case "command":
      return [item.title, item.executionCommand, item.detail]
        .filter(Boolean)
        .join("\n")
    case "agent":
      return item.detail
    case "tool":
    case "unknown":
      return [item.title, item.detail].filter(Boolean).join("\n")
    default:
      return unreachable(item)
  }
}
function unreachable(item: never): never {
  throw new Error(`Unsupported conversation item: ${String(item)}`)
}
export function projectItem(
  item: ConversationItem,
  previous?: TextProjection,
): TextProjection {
  const project =
    item.kind === "user" ||
    item.kind === "assistant" ||
    item.kind === "reasoning"
      ? projectMarkdown
      : projectPlainText
  const nodeKind =
    item.kind === "user" || item.kind === "assistant"
      ? "message"
      : item.kind === "command" || item.kind === "agent"
        ? "tool"
        : item.kind
  const source = sourceOf(item)
  if (previous?.source === source && previous.nodeKind === nodeKind)
    return previous
  return {
    ...project(source),
    nodeKind,
    revision: (previous?.revision ?? 0) + 1,
  }
}
/**
 * The primary transcript is a user-facing work record, not a lossless dump of
 * every canonical event. Reasoning remains available in ConversationState for
 * activity synthesis and a future inspector, but never acquires transcript
 * semantics such as navigation, search, selection, unseen state, or geometry.
 */
export function projectsToTranscript(item: ConversationItem): boolean {
  if (item.kind === "reasoning") return false
  if (item.kind === "unknown" && item.transcript === "diagnostic") return false
  if (
    item.kind === "agent" &&
    (item.action === "activity" ||
      item.action === "wait" ||
      item.action === "list") &&
    !item.detail
  )
    return false
  return true
}

function removeTranscriptItem(
  state: TranscriptState,
  itemId: ConversationItem["id"],
): TranscriptState {
  if (!state.projectionById[itemId]) return state
  const removedIndex = state.order.indexOf(itemId)
  const order = state.order.filter((id) => id !== itemId)
  const projectionById = { ...state.projectionById }
  const folded = { ...state.folded }
  delete projectionById[itemId]
  delete folded[itemId]
  const fallbackId =
    order[Math.min(Math.max(removedIndex, 0), order.length - 1)]
  const fallback = fallbackId
    ? { itemId: fallbackId, graphemeOffset: 0 }
    : undefined
  const retained = (point: LogicalPoint): boolean => point.itemId !== itemId
  const unseenItemIds = state.unseenItemIds.filter((id) => id !== itemId)
  return {
    ...state,
    order,
    projectionById,
    folded,
    cursor: state.cursor && retained(state.cursor) ? state.cursor : fallback,
    selection:
      state.selection &&
      retained(state.selection.anchor) &&
      retained(state.selection.head)
        ? state.selection
        : undefined,
    viewport:
      state.viewport.kind === "point" && !retained(state.viewport.point)
        ? fallback
          ? { ...state.viewport, point: fallback }
          : { kind: "tail" }
        : state.viewport,
    unseenEntries: Math.max(
      0,
      state.unseenEntries -
        (unseenItemIds.length === state.unseenItemIds.length ? 0 : 1),
    ),
    unseenItemIds,
    jumps: {
      back: state.jumps.back.filter((location) => retained(location.point)),
      forward: state.jumps.forward.filter((location) =>
        retained(location.point),
      ),
    },
    marks: Object.fromEntries(
      Object.entries(state.marks).filter(([, location]) =>
        retained(location.point),
      ),
    ),
  }
}

export function syncTranscriptItem(
  state: TranscriptState,
  item: ConversationItem,
  diagnostics?: TranscriptItemSyncDiagnostics,
): TranscriptState {
  if (!projectsToTranscript(item)) return removeTranscriptItem(state, item.id)
  const previous = state.projectionById[item.id]
  const projection = projectItem(item, previous)
  if (projection === previous) return state
  const isNew = !previous
  const changed = !previous || previous.source !== projection.source
  const unseenItemIds = persistentTranscriptUnseenItemIds(
    state.unseenItemIds,
    diagnostics,
  )
  const newlyUnseen =
    state.viewport.kind === "point" &&
    changed &&
    !hasTranscriptUnseenItemId(unseenItemIds, item.id, diagnostics)
  // Markdown delimiters can become invisible when a streamed construct closes.
  // Preserve the source location rather than the old rendered-text index.
  const reproject = (point: LogicalPoint): LogicalPoint => {
    if (!previous || point.itemId !== item.id) return point
    const sourceOffset =
      previous.sourceSpans[point.graphemeOffset]?.from ?? previous.source.length
    const offset = projection.sourceSpans.findIndex(
      (span) => span.to > sourceOffset,
    )
    return {
      ...point,
      graphemeOffset: offset < 0 ? projection.sourceSpans.length : offset,
    }
  }
  let next = clampTranscript({
    ...state,
    order: isNew
      ? appendTranscriptOrder(state.order, item.id)
      : persistentTranscriptOrder(state.order),
    projectionById: setTranscriptProjection(
      state.projectionById,
      item.id,
      projection,
      diagnostics,
    ),
    cursor: state.cursor ? reproject(state.cursor) : undefined,
    selection: state.selection
      ? {
          ...state.selection,
          anchor: reproject(state.selection.anchor),
          head: reproject(state.selection.head),
        }
      : undefined,
    viewport:
      state.viewport.kind === "point"
        ? { ...state.viewport, point: reproject(state.viewport.point) }
        : state.viewport,
    jumps: {
      back: state.jumps.back.map((location) => ({
        ...location,
        point: reproject(location.point),
      })),
      forward: state.jumps.forward.map((location) => ({
        ...location,
        point: reproject(location.point),
      })),
    },
    marks: Object.fromEntries(
      Object.entries(state.marks).map(([name, location]) => [
        name,
        { ...location, point: reproject(location.point) },
      ]),
    ),
    unseenEntries: newlyUnseen ? state.unseenEntries + 1 : state.unseenEntries,
    unseenItemIds: newlyUnseen
      ? appendTranscriptUnseenItemId(unseenItemIds, item.id, diagnostics)
      : unseenItemIds,
  })
  if (
    isNew &&
    !Object.hasOwn(next.folded, item.id) &&
    ((next.foldDefaults.reasoning && projection.nodeKind === "reasoning") ||
      ((next.bulkToolFolded ?? next.foldDefaults.tools) &&
        projection.nodeKind === "tool" &&
        !(item.kind === "command" && item.userInitiated)))
  ) {
    next = {
      ...next,
      folded: setTranscriptFoldValue(next.folded, item.id, true),
    }
  }
  inheritTranscriptTextLengthIndex(state, next, item.id, isNew, diagnostics)
  inheritTranscriptUrlIndex(state, next, item.id, isNew, diagnostics)
  return next
}
export function clampTranscript(state: TranscriptState): TranscriptState {
  const clampPoint = (point: LogicalPoint): LogicalPoint => {
    const projection = state.projectionById[point.itemId]
    return projection
      ? {
          ...point,
          graphemeOffset: Math.max(
            0,
            Math.min(point.graphemeOffset, projection.sourceSpans.length),
          ),
        }
      : point
  }
  return {
    ...state,
    folded: persistentTranscriptFolds(state.folded),
    cursor: state.cursor ? clampPoint(state.cursor) : undefined,
    selection: state.selection
      ? {
          ...state.selection,
          anchor: clampPoint(state.selection.anchor),
          head: clampPoint(state.selection.head),
        }
      : undefined,
    viewport:
      state.viewport.kind === "point"
        ? { ...state.viewport, point: clampPoint(state.viewport.point) }
        : state.viewport,
    jumps: {
      back: state.jumps.back.map((location) => ({
        ...location,
        point: clampPoint(location.point),
      })),
      forward: state.jumps.forward.map((location) => ({
        ...location,
        point: clampPoint(location.point),
      })),
    },
    marks: Object.fromEntries(
      Object.entries(state.marks).map(([name, location]) => [
        name,
        { ...location, point: clampPoint(location.point) },
      ]),
    ),
  }
}
