import {
  graphemes,
  type TextProjection,
  type TranscriptState,
} from "@vimex/transcript"
import type { MeasuredPoint, TranscriptLayout } from "./layout"
import { measuredPoint, visibleMeasuredPoints } from "./rendered-layout"

export interface FlashTarget extends MeasuredPoint {
  label?: string
}
export interface FlashViewport {
  screenX: number
  screenY: number
  width: number
  height: number
}
const textCache = new WeakMap<TextProjection, readonly string[]>()
const alphabet = "asdfghjklqwertyuiopzxcvbnm"
export function flashTargets(
  state: TranscriptState,
  layout: TranscriptLayout,
  viewport: FlashViewport,
  query: string,
  page = 0,
) {
  const needle = graphemes(query)
  const sensitive = query !== query.toLowerCase()
  const compare = (text: string) => (sensitive ? text : text.toLowerCase())
  const visible = (p: MeasuredPoint | undefined): p is MeasuredPoint =>
    Boolean(
      p &&
      p.screenX >= viewport.screenX &&
      p.screenX < viewport.screenX + viewport.width &&
      p.screenY >= viewport.screenY &&
      p.screenY < viewport.screenY + viewport.height,
    )
  const matches: FlashTarget[] = []
  const continuations = new Set<string>()
  const cells = new Set<string>()
  if (!needle.length) return { matches, labels: matches, pages: 1 }
  // Keep the folded block's synthetic offset-zero point. It is the jump
  // target that lets Flash reveal a collapsed block; other hidden fallback
  // points are rejected below.
  const index = [...visibleMeasuredPoints(layout, viewport)].sort(
    (a, b) => a.screenY - b.screenY || a.screenX - b.screenX,
  )
  for (const raw of index) {
    const point = raw
    if (!visible(point)) continue
    const projection = state.projectionById[raw.itemId]
    if (!projection) continue
    // Folded tool and activity blocks expose a single hidden logical point at
    // their visible header. Label that point so Flash can reveal the block on
    // jump instead of making its output unreachable from the current page.
    if (point.hidden && (!state.folded[raw.itemId] || raw.graphemeOffset !== 0))
      continue
    let text = textCache.get(projection)
    if (!text) {
      text = graphemes(projection.plain)
      textCache.set(projection, text)
    }
    if (/\s/u.test(text[raw.graphemeOffset] ?? "")) continue
    const start = raw.graphemeOffset
    if (
      !needle.every(
        (part, i) =>
          text![start + i] !== undefined &&
          compare(text![start + i]!) === compare(part) &&
          visible(
            measuredPoint(layout, {
              itemId: raw.itemId,
              graphemeOffset: start + i,
            }),
          ),
      )
    )
      continue
    const cell = `${point.screenX}:${point.screenY}`
    if (cells.has(cell)) continue
    cells.add(cell)
    matches.push(point)
    continuations.add(compare(text[start + needle.length] ?? ""))
  }
  matches.sort((a, b) => a.screenY - b.screenY || a.screenX - b.screenX)
  // A label never steals a character that could continue this search.
  const keys = [...alphabet].filter((key) => !continuations.has(compare(key)))
  const size = Math.max(1, keys.length)
  const pages = Math.max(1, Math.ceil(matches.length / size))
  const labels = keys.length
    ? matches
        .slice((page % pages) * size, ((page % pages) + 1) * size)
        .map((point, i) => ({ ...point, label: keys[i]! }))
    : []
  return { matches, labels, pages }
}
