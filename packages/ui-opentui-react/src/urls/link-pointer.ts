import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core"
import {
  graphemes,
  type TranscriptFrame,
  type UrlCandidate,
} from "@vimex/transcript"
import type { TranscriptLayout } from "../transcript/layout"
import { visibleMeasuredPoints } from "../transcript/rendered-layout"

const segments = new WeakMap<object, readonly string[]>()
function partsFor(projection: { plain: string }): readonly string[] {
  let parts = segments.get(projection)
  if (!parts) {
    parts = graphemes(projection.plain)
    segments.set(projection, parts)
  }
  return parts
}

/** Hit only measured text cells, never the whitespace nearest a link. */
export function linkAtMouse(
  frame: TranscriptFrame,
  layout: TranscriptLayout | undefined,
  scroll: ScrollBoxRenderable | null,
  x: number,
  y: number,
): UrlCandidate | undefined {
  if (
    !layout ||
    !scroll ||
    layout.materializedBlocks !== frame.window.blocks ||
    layout.geometry !== frame.geometry
  )
    return
  const viewport = scroll.viewport
  if (
    x < viewport.screenX ||
    x >= viewport.screenX + viewport.width ||
    y < viewport.screenY ||
    y >= viewport.screenY + viewport.height
  )
    return
  for (const point of visibleMeasuredPoints(layout, viewport)) {
    if (point.hidden || point.screenY !== y || point.screenX > x) continue
    const projection = frame.transcript.projectionById[point.itemId]
    if (!projection?.links.length) continue
    const link = projection.links.find(
      (link) =>
        point.graphemeOffset >= link.from && point.graphemeOffset < link.to,
    )
    if (!link) continue
    const parts = partsFor(projection)
    const width = Bun.stringWidth(parts[point.graphemeOffset] ?? "")
    if (x >= point.screenX + width) continue
    return {
      itemId: point.itemId,
      url: link.url,
      text: parts.slice(link.from, link.to).join(""),
      from: { itemId: point.itemId, graphemeOffset: link.from },
      to: { itemId: point.itemId, graphemeOffset: link.to },
    }
  }
}

export function unmodifiedLeftMouse(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.modifiers.ctrl &&
    !event.modifiers.alt &&
    !event.modifiers.shift
  )
}

export function sameLink(
  a: UrlCandidate | undefined,
  b: UrlCandidate | undefined,
): boolean {
  return Boolean(
    a &&
    b &&
    a.itemId === b.itemId &&
    a.url === b.url &&
    a.from.graphemeOffset === b.from.graphemeOffset &&
    a.to.graphemeOffset === b.to.graphemeOffset,
  )
}
