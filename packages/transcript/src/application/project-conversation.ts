import type { ConversationItem } from "@vimex/conversation"
import { projectMarkdown, projectPlainText } from "../domain/markdown-source-map"
import { inheritTranscriptTextLengthIndex, persistentTranscriptFolds, setTranscriptFoldValue, type LogicalPoint, type TextProjection, type TranscriptState } from "../domain/transcript-document"
import { inheritTranscriptUrlIndex } from "./transcript-url-index"
function sourceOf(item: ConversationItem): string {
  switch (item.kind) {
    case "user": case "assistant": case "reasoning": return item.markdown
    case "edit": return item.patch
    case "command": return [item.title, item.executionCommand, item.detail].filter(Boolean).join("\n")
    case "agent": return item.detail
    case "tool": case "unknown": return [item.title, item.detail].filter(Boolean).join("\n")
    default: return unreachable(item)
  }
}
function unreachable(item: never): never { throw new Error(`Unsupported conversation item: ${String(item)}`) }
export function projectItem(item: ConversationItem, previous?: TextProjection): TextProjection {
  const project = item.kind === "user" || item.kind === "assistant" || item.kind === "reasoning" ? projectMarkdown : projectPlainText
  const nodeKind = item.kind === "user" || item.kind === "assistant" ? "message" : item.kind === "command" || item.kind === "agent" ? "tool" : item.kind
  const source = sourceOf(item)
  if (previous?.source === source && previous.nodeKind === nodeKind) return previous
  return { ...project(source), nodeKind, revision: (previous?.revision ?? 0) + 1 }
}
export function syncTranscriptItem(state: TranscriptState, item: ConversationItem): TranscriptState {
  if (item.kind === "unknown" && item.transcript === "diagnostic") return state
  if (item.kind === "agent" && (item.action === "activity" || item.action === "wait" || item.action === "list") && !item.detail) return state
  const previous = state.projectionById[item.id]
  const projection = projectItem(item, previous)
  if (projection === previous) return state
  const isNew = !previous
  const changed = !previous || previous.source !== projection.source
  const unseenItemIds = state.unseenItemIds ?? []
  const newlyUnseen = state.viewport.kind === "point" && changed && !unseenItemIds.includes(item.id)
  // Markdown delimiters can become invisible when a streamed construct closes.
  // Preserve the source location rather than the old rendered-text index.
  const reproject = (point: LogicalPoint): LogicalPoint => {
    if (!previous || point.itemId !== item.id) return point
    const sourceOffset = previous.sourceSpans[point.graphemeOffset]?.from ?? previous.source.length
    const offset = projection.sourceSpans.findIndex(span => span.to > sourceOffset)
    return { ...point, graphemeOffset: offset < 0 ? projection.sourceSpans.length : offset }
  }
  let next = clampTranscript({
    ...state,
    order: isNew ? [...state.order, item.id] : state.order,
    projectionById: { ...state.projectionById, [item.id]: projection },
    cursor: state.cursor ? reproject(state.cursor) : undefined,
    selection: state.selection ? { ...state.selection, anchor: reproject(state.selection.anchor), head: reproject(state.selection.head) } : undefined,
    viewport: state.viewport.kind === "point" ? { ...state.viewport, point: reproject(state.viewport.point) } : state.viewport,
    jumps: { back: state.jumps.back.map(location => ({ ...location, point: reproject(location.point) })), forward: state.jumps.forward.map(location => ({ ...location, point: reproject(location.point) })) },
    marks: Object.fromEntries(Object.entries(state.marks).map(([name, location]) => [name, { ...location, point: reproject(location.point) }])),
    unseenEntries: newlyUnseen ? state.unseenEntries + 1 : state.unseenEntries,
    unseenItemIds: newlyUnseen ? [...unseenItemIds, item.id] : unseenItemIds,
  })
  if (isNew && !Object.hasOwn(next.folded, item.id)
    && ((next.foldDefaults.reasoning && projection.nodeKind === "reasoning")
      || (next.foldDefaults.tools && projection.nodeKind === "tool"))) {
    next = { ...next, folded: setTranscriptFoldValue(next.folded, item.id, true) }
  }
  inheritTranscriptTextLengthIndex(state, next, item.id, isNew)
  inheritTranscriptUrlIndex(state, next, item.id, isNew)
  return next
}
export function clampTranscript(state: TranscriptState): TranscriptState {
  const clampPoint = (point: LogicalPoint): LogicalPoint => {
    const projection = state.projectionById[point.itemId]
    return projection ? { ...point, graphemeOffset: Math.max(0, Math.min(point.graphemeOffset, projection.sourceSpans.length)) } : point
  }
  return {
    ...state,
    folded: persistentTranscriptFolds(state.folded),
    cursor: state.cursor ? clampPoint(state.cursor) : undefined,
    selection: state.selection ? { ...state.selection, anchor: clampPoint(state.selection.anchor), head: clampPoint(state.selection.head) } : undefined,
    viewport: state.viewport.kind === "point" ? { ...state.viewport, point: clampPoint(state.viewport.point) } : state.viewport,
    jumps: { back: state.jumps.back.map(location => ({ ...location, point: clampPoint(location.point) })), forward: state.jumps.forward.map(location => ({ ...location, point: clampPoint(location.point) })) },
    marks: Object.fromEntries(Object.entries(state.marks).map(([name, location]) => [name, { ...location, point: clampPoint(location.point) }])),
  }
}
