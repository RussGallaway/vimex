import type { ConversationItem } from "@vimex/conversation"
import { graphemeCount, projectMarkdown } from "../domain/markdown-source-map"
import type { LogicalPoint, TextProjection, TranscriptState } from "../domain/transcript-document"
function sourceOf(item: ConversationItem): string {
  switch (item.kind) {
    case "user": case "assistant": case "reasoning": return item.markdown
    case "edit": return item.patch
    default: return [item.title, item.detail].filter(Boolean).join("\n")
  }
}
export function projectItem(item: ConversationItem, previous?: TextProjection): TextProjection {
  return { ...projectMarkdown(sourceOf(item)), revision: (previous?.revision ?? 0) + 1 }
}
export function syncTranscriptItem(state: TranscriptState, item: ConversationItem): TranscriptState {
  const isNew = !state.projectionById[item.id]
  return clampTranscript({
    ...state,
    order: isNew ? [...state.order, item.id] : state.order,
    projectionById: { ...state.projectionById, [item.id]: projectItem(item, state.projectionById[item.id]) },
    unseenEntries: state.viewport.kind === "point" && isNew ? state.unseenEntries + 1 : state.unseenEntries,
  })
}
export function clampTranscript(state: TranscriptState): TranscriptState {
  const clampPoint = (point: LogicalPoint): LogicalPoint => {
    const projection = state.projectionById[point.itemId]
    return projection ? { ...point, graphemeOffset: Math.max(0, Math.min(point.graphemeOffset, graphemeCount(projection.plain))) } : point
  }
  return {
    ...state,
    cursor: state.cursor ? clampPoint(state.cursor) : undefined,
    selection: state.selection ? { ...state.selection, anchor: clampPoint(state.selection.anchor), head: clampPoint(state.selection.head) } : undefined,
    viewport: state.viewport.kind === "point" ? { ...state.viewport, point: clampPoint(state.viewport.point) } : state.viewport,
  }
}
