import type { ItemId } from "@vimex/conversation"
import { graphemes, graphemeCount } from "../domain/markdown-source-map"
import { transcriptOrderIndex, type JumpLocation, type LogicalPoint, type TextProjection, type TranscriptCommand, type TranscriptSelection, type TranscriptState } from "../domain/transcript-document"
import { clampTranscript } from "./project-conversation"
export function moveCursor(state: TranscriptState, point: LogicalPoint, preferredScreenRow = 0): TranscriptState {
  return clampTranscript({
    ...state, cursor: point,
    selection: state.selection ? { ...state.selection, head: point } : undefined,
    viewport: { kind: "point", point, preferredScreenRow },
  })
}
export function anchorViewport(state: TranscriptState, point: LogicalPoint, preferredScreenRow: number): TranscriptState {
  const projection = state.projectionById[point.itemId]
  // Ignore stale renderer anchors after a session/item change. Invalid numeric
  // positions cannot name a semantic grapheme and must not detach the viewport.
  if (!projection || !transcriptOrderIndex(state.order).has(point.itemId) || !Number.isFinite(point.graphemeOffset) || !Number.isFinite(preferredScreenRow)) return state
  const anchored = { ...point, graphemeOffset: Math.max(0, Math.min(Math.trunc(point.graphemeOffset), projection.sourceSpans.length)) }
  preferredScreenRow = Math.trunc(preferredScreenRow)
  if (state.viewport.kind === "point"
    && state.viewport.point.itemId === anchored.itemId
    && state.viewport.point.graphemeOffset === anchored.graphemeOffset
    && state.viewport.preferredScreenRow === preferredScreenRow) return state
  return { ...state, viewport: { kind: "point", point: anchored, preferredScreenRow } }
}
const JUMP_LIMIT = 100
function validLocation(state: TranscriptState, location: JumpLocation | undefined): location is JumpLocation {
  return Boolean(location && state.projectionById[location.point.itemId] && Number.isFinite(location.point.graphemeOffset))
}
function currentLocation(state: TranscriptState): JumpLocation | undefined {
  if (state.viewport.kind === "point" && validLocation(state, { point: state.viewport.point, preferredScreenRow: state.viewport.preferredScreenRow })) return { point: state.viewport.point, preferredScreenRow: state.viewport.preferredScreenRow }
  if (state.cursor && validLocation(state, { point: state.cursor, preferredScreenRow: 0 })) return { point: state.cursor, preferredScreenRow: 0 }
  const itemId = state.order.at(-1), projection = itemId ? state.projectionById[itemId] : undefined
  return itemId && projection ? { point: { itemId, graphemeOffset: projection.sourceSpans.length }, preferredScreenRow: 0 } : undefined
}
function sameLocation(a: JumpLocation | undefined, b: JumpLocation | undefined): boolean {
  return Boolean(a && b && a.point.itemId === b.point.itemId && a.point.graphemeOffset === b.point.graphemeOffset && a.preferredScreenRow === b.preferredScreenRow)
}
function atLocation(state: TranscriptState, location: JumpLocation): TranscriptState {
  if (!validLocation(state, location)) return state
  const revealed = state.folded[location.point.itemId] ? setFold(state, location.point.itemId, false) : state
  return moveCursor(revealed, location.point, location.preferredScreenRow)
}
function jumpTo(state: TranscriptState, target: JumpLocation, origin?: JumpLocation): TranscriptState {
  if (!validLocation(state, target)) return state
  const from = validLocation(state, origin) ? origin : currentLocation(state)
  if (sameLocation(from, target)) return atLocation(state, target)
  const back = from ? [...state.jumps.back, from].slice(-JUMP_LIMIT) : state.jumps.back
  return { ...atLocation(state, target), jumps: { back, forward: [] } }
}
function jumpHistory(state: TranscriptState, direction: "back" | "forward", origin?: JumpLocation): TranscriptState {
  const source = [...state.jumps[direction]]
  let target: JumpLocation | undefined
  while (source.length && !target) {
    const candidate = source.pop()
    if (validLocation(state, candidate)) target = candidate
  }
  if (!target) return source.length === state.jumps[direction].length ? state : { ...state, jumps: { ...state.jumps, [direction]: source } }
  const opposite = direction === "back" ? "forward" : "back"
  const current = validLocation(state, origin) ? origin : currentLocation(state)
  const destination = current ? [...state.jumps[opposite], current].slice(-JUMP_LIMIT) : state.jumps[opposite]
  return { ...atLocation(state, target), jumps: { ...state.jumps, [direction]: source, [opposite]: destination } }
}
export function attachTail(state: TranscriptState): TranscriptState {
  const last = state.order.at(-1)
  const projection = last ? state.projectionById[last] : undefined
  const cursor = last && projection ? { itemId: last, graphemeOffset: graphemeCount(projection.plain) } : state.cursor
  if (state.viewport.kind === "tail" && state.unseenEntries === 0 && state.unseenItemIds.length === 0
    && state.cursor?.itemId === cursor?.itemId && state.cursor?.graphemeOffset === cursor?.graphemeOffset) return state
  return {
    ...state,
    cursor,
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
  if (Object.hasOwn(state.folded, id) && state.folded[id] === folded) return state
  return { ...state, folded: { ...state.folded, [id]: folded } }
}
export function setAllFolds(state: TranscriptState, folded: boolean): TranscriptState {
  const ids = state.order.filter(id => state.projectionById[id]?.nodeKind !== "message")
  if (Object.keys(state.folded).length === ids.length && ids.every(id => state.folded[id] === folded)) return state
  return { ...state, folded: Object.fromEntries(ids.map(id => [id, folded])) }
}
export function setDefaultFolds(state: TranscriptState, defaults: { readonly reasoning: boolean; readonly tools: boolean }): TranscriptState {
  if (!defaults.reasoning && !defaults.tools) return state
  const additions = state.order.flatMap(id => {
    if (Object.hasOwn(state.folded, id)) return []
    const kind = state.projectionById[id]?.nodeKind
    return (defaults.reasoning && kind === "reasoning") || (defaults.tools && kind === "tool") ? [[id, true] as const] : []
  })
  return additions.length ? { ...state, folded: { ...state.folded, ...Object.fromEntries(additions) } } : state
}
function comparePoint(state: TranscriptState, a: LogicalPoint, b: LogicalPoint): number {
  const order = transcriptOrderIndex(state.order)
  const ai = order.get(a.itemId) ?? -1
  const bi = order.get(b.itemId) ?? -1
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
  const order = transcriptOrderIndex(state.order)
  const startIndex = order.get(start.itemId)
  const endIndex = order.get(end.itemId)
  if (startIndex === undefined || endIndex === undefined) return undefined
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
    case "jump.to": return jumpTo(state, command.target, command.origin)
    case "jump.back": return jumpHistory(state, "back", command.origin)
    case "jump.forward": return jumpHistory(state, "forward", command.origin)
    case "mark.set": return validLocation(state, command.target) && /^[a-zA-Z]$/.test(command.name) ? { ...state, marks: { ...state.marks, [command.name]: command.target } } : state
    case "mark.jump": {
      const target = state.marks[command.name]
      return target ? jumpTo(state, target, command.origin) : state
    }
    case "viewport.anchor": return anchorViewport(state, command.point, command.preferredScreenRow)
    case "tail.attach": return attachTail(state)
    case "selection.begin": return beginSelection(state, command.shape)
    case "selection.swap": return swapSelection(state)
    case "selection.clear": return clearSelection(state)
    case "fold.set": return setFold(state, command.itemId, command.folded)
    case "fold.toggle": return setFold(state, command.itemId, !state.folded[command.itemId])
    case "fold.all": return setAllFolds(state, command.folded)
    case "fold.defaults": return setDefaultFolds(state, command)
  }
}
