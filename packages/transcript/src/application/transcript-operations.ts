import type { ItemId } from "@vimex/conversation"
import { graphemes, graphemeCount } from "../domain/markdown-source-map"
import type { LogicalPoint, TextProjection, TranscriptCommand, TranscriptSelection, TranscriptState } from "../domain/transcript-document"
import { clampTranscript } from "./project-conversation"
export function moveCursor(state: TranscriptState, point: LogicalPoint, preferredScreenRow = 0): TranscriptState {
  return clampTranscript({
    ...state, cursor: point,
    selection: state.selection ? { ...state.selection, head: point } : undefined,
    viewport: { kind: "point", point, preferredScreenRow },
  })
}
export function attachTail(state: TranscriptState): TranscriptState {
  const last = state.order.at(-1)
  const projection = last ? state.projectionById[last] : undefined
  return {
    ...state,
    cursor: last && projection ? { itemId: last, graphemeOffset: graphemeCount(projection.plain) } : state.cursor,
    viewport: { kind: "tail" }, unseenEntries: 0, unseenItemIds: [],
  }
}
export function beginSelection(state: TranscriptState, shape: TranscriptSelection["shape"]): TranscriptState {
  return state.cursor ? { ...state, selection: { anchor: state.cursor, head: state.cursor, shape } } : state
}
export function swapSelection(state: TranscriptState): TranscriptState {
  if (!state.selection) return state
  const { anchor, head } = state.selection
  return { ...state, cursor: anchor, selection: { ...state.selection, anchor: head, head: anchor } }
}
export function clearSelection(state: TranscriptState): TranscriptState { return { ...state, selection: undefined } }
export function setFold(state: TranscriptState, id: ItemId, folded: boolean): TranscriptState {
  return { ...state, folded: { ...state.folded, [id]: folded } }
}
export function setAllFolds(state: TranscriptState, folded: boolean): TranscriptState {
  return { ...state, folded: Object.fromEntries(state.order.map((id) => [id, folded])) }
}
function comparePoint(state: TranscriptState, a: LogicalPoint, b: LogicalPoint): number {
  const ai = state.order.indexOf(a.itemId)
  const bi = state.order.indexOf(b.itemId)
  return ai === bi ? a.graphemeOffset - b.graphemeOffset : ai - bi
}
function lineRange(parts: readonly string[], from: number, to: number): [number, number] {
  let start = Math.min(from, parts.length)
  let end = Math.min(to, Math.max(0, parts.length - 1))
  while (start > 0 && parts[start - 1] !== "\n") start--
  while (end < parts.length && parts[end] !== "\n") end++
  return [start, end]
}
function projectedSlice(projection: TextProjection, from: number, inclusiveTo: number, format: "plain" | "source"): string {
  const parts = graphemes(projection.plain)
  const start = Math.max(0, Math.min(from, parts.length))
  const end = Math.max(start, Math.min(inclusiveTo + 1, parts.length))
  if (format === "plain") return parts.slice(start, end).join("")
  if (start >= end) return ""
  if (start === 0 && end === parts.length) return projection.source
  let sourceFrom = projection.sourceSpans[start]?.from
  let sourceTo = projection.sourceSpans[end - 1]?.to
  if (sourceFrom === undefined || sourceTo === undefined) return ""
  for (const region of projection.sourceRegions ?? []) {
    if (region.from >= start && region.to <= end && region.to > region.from) {
      sourceFrom = Math.min(sourceFrom, region.sourceFrom)
      sourceTo = Math.max(sourceTo, region.sourceTo)
    }
  }
  return projection.source.slice(sourceFrom, sourceTo)
}
export function selectedText(state: TranscriptState, format: "plain" | "source"): string | undefined {
  if (!state.selection) return undefined
  const forward = comparePoint(state, state.selection.anchor, state.selection.head) <= 0
  const start = forward ? state.selection.anchor : state.selection.head
  const end = forward ? state.selection.head : state.selection.anchor
  const startIndex = state.order.indexOf(start.itemId)
  const endIndex = state.order.indexOf(end.itemId)
  if (startIndex < 0 || endIndex < 0) return undefined
  const ids = state.order.slice(startIndex, endIndex + 1)
  return ids.map((id, index) => {
    const projection = state.projectionById[id]
    if (!projection) return ""
    const parts = graphemes(projection.plain)
    let from = index === 0 ? start.graphemeOffset : 0
    let to = index === ids.length - 1 ? end.graphemeOffset : Math.max(0, parts.length - 1)
    if (state.selection?.shape === "line") [from, to] = lineRange(parts, from, to)
    return projectedSlice(projection, from, to, format)
  }).join("\n")
}
export function urlAt(state: TranscriptState, point = state.cursor): string | undefined {
  if (!point) return undefined
  return state.projectionById[point.itemId]?.links.find((link) => point.graphemeOffset >= link.from && point.graphemeOffset < link.to)?.url
}
export function reduceTranscript(state: TranscriptState, command: TranscriptCommand): TranscriptState {
  switch (command.type) {
    case "search.set": return { ...state, search: { query: command.query, direction: command.direction } }
    case "cursor.move": return moveCursor(state, command.point, command.preferredScreenRow)
    case "tail.attach": return attachTail(state)
    case "selection.begin": return beginSelection(state, command.shape)
    case "selection.swap": return swapSelection(state)
    case "selection.clear": return clearSelection(state)
    case "fold.set": return setFold(state, command.itemId, command.folded)
    case "fold.toggle": return setFold(state, command.itemId, !state.folded[command.itemId])
    case "fold.all": return setAllFolds(state, command.folded)
  }
}
