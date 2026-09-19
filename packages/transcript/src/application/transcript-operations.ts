import type { ItemId } from "@vimex/conversation"
import { graphemes, graphemeCount } from "../domain/markdown-source-map"
import { persistentTranscriptFolds, persistentTranscriptUnseenItemIds, setTranscriptFoldValue, transcriptOrderIndex, transcriptTextLengthRange, type JumpLocation, type LogicalPoint, type TextProjection, type TranscriptCommand, type TranscriptSelection, type TranscriptState, type TranscriptTextLengthIndexDiagnostics } from "../domain/transcript-document"
import { clampTranscript } from "./project-conversation"
export function moveCursor(state: TranscriptState, point: LogicalPoint, preferredScreenRow = 0): TranscriptState {
  const projection = state.projectionById[point.itemId]
  if (!projection || !transcriptOrderIndex(state.order).has(point.itemId)
    || !Number.isInteger(point.graphemeOffset) || !Number.isFinite(preferredScreenRow)) return state
  point = { ...point, graphemeOffset: Math.max(0, Math.min(point.graphemeOffset, projection.sourceSpans.length)) }
  preferredScreenRow = Math.trunc(preferredScreenRow)
  const selection = state.selection
    ? state.selection.head.itemId === point.itemId && state.selection.head.graphemeOffset === point.graphemeOffset
      ? state.selection : { ...state.selection, head: point }
    : undefined
  if (state.cursor?.itemId === point.itemId && state.cursor.graphemeOffset === point.graphemeOffset
    && state.selection === selection && state.viewport.kind === "point"
    && state.viewport.point.itemId === point.itemId && state.viewport.point.graphemeOffset === point.graphemeOffset
    && state.viewport.preferredScreenRow === preferredScreenRow) return state
  return clampTranscript({
    ...state, cursor: point,
    selection,
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
  return Boolean(location && state.projectionById[location.point.itemId]
    && transcriptOrderIndex(state.order).has(location.point.itemId)
    && Number.isInteger(location.point.graphemeOffset) && Number.isFinite(location.preferredScreenRow))
}
function normalizeLocation(state: TranscriptState, location: JumpLocation | undefined): JumpLocation | undefined {
  if (!validLocation(state, location)) return undefined
  const length = state.projectionById[location.point.itemId]!.sourceSpans.length
  return {
    point: { ...location.point, graphemeOffset: Math.max(0, Math.min(location.point.graphemeOffset, length)) },
    preferredScreenRow: Math.trunc(location.preferredScreenRow),
  }
}
function currentLocation(state: TranscriptState): JumpLocation | undefined {
  if (state.viewport.kind === "point") {
    const viewport = normalizeLocation(state, { point: state.viewport.point, preferredScreenRow: state.viewport.preferredScreenRow })
    if (viewport) return viewport
  }
  if (state.cursor) {
    const cursor = normalizeLocation(state, { point: state.cursor, preferredScreenRow: 0 })
    if (cursor) return cursor
  }
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
function jumpTo(state: TranscriptState, target: JumpLocation, origin?: JumpLocation, clearActiveSelection = false): TranscriptState {
  const normalizedTarget = normalizeLocation(state, target)
  if (!normalizedTarget) return state
  if (clearActiveSelection && state.selection) state = { ...state, selection: undefined }
  const from = normalizeLocation(state, origin) ?? currentLocation(state)
  if (sameLocation(from, normalizedTarget)) return atLocation(state, normalizedTarget)
  const back = from ? [...state.jumps.back, from].slice(-JUMP_LIMIT) : state.jumps.back
  return { ...atLocation(state, normalizedTarget), jumps: { back, forward: [] } }
}
function jumpHistory(state: TranscriptState, direction: "back" | "forward", origin?: JumpLocation): TranscriptState {
  const source = [...state.jumps[direction]]
  let target: JumpLocation | undefined
  while (source.length && !target) {
    const candidate = source.pop()
    target = normalizeLocation(state, candidate)
  }
  if (!target) return source.length === state.jumps[direction].length ? state : { ...state, jumps: { ...state.jumps, [direction]: source } }
  const opposite = direction === "back" ? "forward" : "back"
  const current = normalizeLocation(state, origin) ?? currentLocation(state)
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
    viewport: { kind: "tail" }, unseenEntries: 0, unseenItemIds: persistentTranscriptUnseenItemIds(),
  }
}
export function beginSelection(state: TranscriptState, shape: TranscriptSelection["shape"]): TranscriptState {
  return state.cursor ? { ...state, selection: { anchor: state.cursor, head: state.cursor, shape } } : state
}
export function swapSelection(state: TranscriptState): TranscriptState {
  if (!state.selection) return state
  const { anchor, head } = state.selection
  const preferredScreenRow = state.viewport.kind === "point" ? state.viewport.preferredScreenRow : 0
  return moveCursor({ ...state, selection: { ...state.selection, anchor: head, head: anchor } }, anchor, preferredScreenRow)
}
export function clearSelection(state: TranscriptState): TranscriptState { return { ...state, selection: undefined } }
export function setFold(state: TranscriptState, id: ItemId, folded: boolean): TranscriptState {
  if (!transcriptOrderIndex(state.order).has(id) || state.projectionById[id]?.nodeKind === "message") return state
  if (Object.hasOwn(state.folded, id) && state.folded[id] === folded) return state
  return { ...state, folded: setTranscriptFoldValue(state.folded, id, folded) }
}
export function setAllFolds(state: TranscriptState, folded: boolean): TranscriptState {
  const ids = state.order.filter(id => state.projectionById[id]?.nodeKind !== "message")
  if (Object.keys(state.folded).length === ids.length && ids.every(id => state.folded[id] === folded)) return state
  return { ...state, folded: persistentTranscriptFolds(Object.fromEntries(ids.map(id => [id, folded]))) }
}
export function setDefaultFolds(state: TranscriptState, defaults: { readonly reasoning: boolean; readonly tools: boolean }): TranscriptState {
  const additions = state.order.flatMap(id => {
    if (Object.hasOwn(state.folded, id)) return []
    const kind = state.projectionById[id]?.nodeKind
    return (defaults.reasoning && kind === "reasoning") || (defaults.tools && kind === "tool") ? [[id, true] as const] : []
  })
  const sameDefaults = state.foldDefaults.reasoning === defaults.reasoning && state.foldDefaults.tools === defaults.tools
  if (!additions.length && sameDefaults) return state
  let folded = state.folded
  for (const [itemId, value] of additions) folded = setTranscriptFoldValue(folded, itemId, value)
  return { ...state, folded, foldDefaults: sameDefaults ? state.foldDefaults
    : Object.freeze({ reasoning: defaults.reasoning, tools: defaults.tools }) }
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

/** Count rendered selection graphemes without constructing or scanning the selected transcript text. */
export function selectedGraphemeCount(
  state: TranscriptState,
  diagnostics?: TranscriptTextLengthIndexDiagnostics,
): number | undefined {
  if (!state.selection) return undefined
  const forward = comparePoint(state, state.selection.anchor, state.selection.head) <= 0
  const start = forward ? state.selection.anchor : state.selection.head
  const end = forward ? state.selection.head : state.selection.anchor
  const order = transcriptOrderIndex(state.order)
  const startIndex = order.get(start.itemId)
  const endIndex = order.get(end.itemId)
  if (startIndex === undefined || endIndex === undefined) return undefined
  const boundary = (point: LogicalPoint, side: "start" | "end"): readonly [number, number] => {
    const projection = state.projectionById[point.itemId]
    const length = projection?.sourceSpans.length ?? 0
    let from = side === "start" ? point.graphemeOffset : 0
    let to = side === "end" ? point.graphemeOffset : Math.max(0, length - 1)
    if (state.selection?.shape === "line" && projection) [from, to] = lineRange(graphemes(projection.plain), from, to)
    const clampedFrom = Math.max(0, Math.min(length, from))
    const clampedTo = Math.max(clampedFrom, Math.min(length, to + 1))
    return [clampedFrom, clampedTo]
  }
  if (startIndex === endIndex) {
    const projection = state.projectionById[start.itemId]
    const length = projection?.sourceSpans.length ?? 0
    let from = start.graphemeOffset
    let to = end.graphemeOffset
    if (state.selection.shape === "line" && projection) [from, to] = lineRange(graphemes(projection.plain), from, to)
    return Math.max(0, Math.min(length, to + 1) - Math.max(0, Math.min(length, from)))
  }
  const [startFrom, startTo] = boundary(start, "start")
  const [endFrom, endTo] = boundary(end, "end")
  const middle = transcriptTextLengthRange(state, startIndex + 1, endIndex, diagnostics)
  return (startTo - startFrom) + middle + (endTo - endFrom) + (endIndex - startIndex)
}
export function urlAt(state: TranscriptState, point = state.cursor): string | undefined {
  if (!point) return undefined
  return state.projectionById[point.itemId]?.links.find((link) => point.graphemeOffset >= link.from && point.graphemeOffset < link.to)?.url
}
export function reduceTranscript(state: TranscriptState, command: TranscriptCommand): TranscriptState {
  switch (command.type) {
    case "search.set": return state.search?.query === command.query && state.search.direction === command.direction
      ? state : { ...state, search: { query: command.query, direction: command.direction } }
    case "search.jump": {
      const searched = command.search && (state.search?.query !== command.search.query || state.search.direction !== command.search.direction)
        ? { ...state, search: { query: command.search.query, direction: command.search.direction } } : state
      return jumpTo(searched, command.target)
    }
    case "cursor.move": return moveCursor(state, command.point, command.preferredScreenRow)
    case "cursor.reveal": return moveCursor(setFold(state, command.point.itemId, false), command.point, command.preferredScreenRow)
    case "jump.to": return jumpTo(state, command.target, command.origin, command.clearSelection)
    case "jump.back": return jumpHistory(state, "back", command.origin)
    case "jump.forward": return jumpHistory(state, "forward", command.origin)
    case "mark.set": {
      const target = normalizeLocation(state, command.target)
      return target && /^[a-zA-Z]$/.test(command.name) ? { ...state, marks: { ...state.marks, [command.name]: target } } : state
    }
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
