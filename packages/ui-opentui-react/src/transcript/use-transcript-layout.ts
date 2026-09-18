import { CliRenderEvents, type ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import type { ThreadId } from "@vimex/conversation"
import type { TranscriptState } from "@vimex/transcript"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"
import type { VimexUiController } from "../contracts"
import { buildTranscriptLayout, type TranscriptLayout } from "./layout"
import { measureRenderedTranscript, measuredPoint, topVisiblePoint, bottomVisiblePoint } from "./rendered-layout"

/** Owns the volatile bridge between semantic anchors and terminal geometry. */
export function useTranscriptLayout(options: {
  threadId?: ThreadId
  transcript: TranscriptState
  width: number
  height: number
  scrollRef: RefObject<ScrollBoxRenderable | null>
  controller: VimexUiController
}) {
  const renderer = useRenderer()
  const { transcript, threadId, width, height, scrollRef, controller } = options
  const latest = useRef(options)
  latest.current = options
  const measuredLayout = useRef<TranscriptLayout | undefined>(undefined)
  const [rendered, setRendered] = useState<{ threadId?: ThreadId; layout: TranscriptLayout }>()
  const pendingAnchor = useRef(false)
  const pendingRestore = useRef(false)
  const hasMeasuredLayout = rendered !== undefined && rendered.threadId === threadId
  // Estimated wrapping is only a startup fallback. Rewrapping the whole history
  // on each fold wastes work once native geometry is available.
  const estimated = useMemo(() => hasMeasuredLayout ? undefined : buildTranscriptLayout(transcript, Math.max(8, width - 7)),
    [hasMeasuredLayout, transcript.order, transcript.projectionById, transcript.folded, width])
  useLayoutEffect(() => {
    measuredLayout.current = undefined
    pendingAnchor.current = false
    pendingRestore.current = transcript.viewport.kind === "point"
  }, [threadId])
  useLayoutEffect(() => {
    if (transcript.viewport.kind !== "tail") return
    pendingAnchor.current = false
    pendingRestore.current = false
    scrollRef.current?.scrollTo(Number.MAX_SAFE_INTEGER)
  }, [threadId, transcript.viewport.kind, scrollRef])
  useEffect(() => {
    if (transcript.viewport.kind === "point") pendingRestore.current = true
  }, [width, height, transcript.order, transcript.projectionById, transcript.folded])

  const onManualScroll = useCallback(() => {
    pendingAnchor.current = true
    pendingRestore.current = false
    renderer.requestRender()
  }, [renderer])

  useEffect(() => {
    const measure = () => {
      const current = latest.current
      const scrollbox = scrollRef.current
      if (!scrollbox) return
      const next = measureRenderedTranscript(renderer, scrollbox, current.transcript)
      if (!next) return
      // Measurement owns a geometry cache. Its stable identity avoids serializing
      // every logical point merely to discover that a frame has not changed.
      if (next !== measuredLayout.current) {
        const geometryChanged = next.points !== measuredLayout.current?.points
        measuredLayout.current = next
        setRendered({ threadId: current.threadId, layout: next })
        // Markdown and table renderables can settle over later native frames
        // without changing transcript state. Reapply a detached logical anchor
        // after each real geometry revision so async reflow cannot move it.
        if (geometryChanged && current.transcript.viewport.kind === "point" && !pendingAnchor.current) pendingRestore.current = true
      }
      if (pendingAnchor.current) {
        pendingAnchor.current = false
        pendingRestore.current = false
        const anchor = topVisiblePoint(next, scrollbox)
        if (anchor) controller.transcript({ type: "viewport.anchor", point: { itemId: anchor.itemId, graphemeOffset: anchor.graphemeOffset }, preferredScreenRow: anchor.screenY - scrollbox.viewport.screenY })
      } else if (pendingRestore.current && current.transcript.viewport.kind === "point") {
        const viewport = current.transcript.viewport
        const anchor = measuredPoint(next, viewport.point)
        if (anchor) {
          pendingRestore.current = false
          const delta = anchor.screenY - scrollbox.viewport.screenY - viewport.preferredScreenRow
          if (delta) scrollbox.scrollBy(delta, "step")
        } else scrollbox.scrollChildIntoView(`transcript-item:${viewport.point.itemId}`)
      }
    }
    renderer.on(CliRenderEvents.FRAME, measure)
    renderer.requestRender()
    return () => { renderer.off(CliRenderEvents.FRAME, measure) }
  }, [controller, renderer, scrollRef])
  const enterVisibleTranscript = useCallback(() => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return
    // Measure at key time: scrolling may have occurred since the last frame.
    const current = latest.current
    const next = measureRenderedTranscript(renderer, scrollbox, current.transcript)
    if (!next) return
    const point = bottomVisiblePoint(next, scrollbox)
    if (!point) return
    measuredLayout.current = next
    pendingAnchor.current = false
    pendingRestore.current = false
    controller.transcript({ type: "cursor.move", target: { itemId: point.itemId, graphemeOffset: point.graphemeOffset }, preferredScreenRow: point.screenY - scrollbox.viewport.screenY, extend: false })
  }, [controller, renderer, scrollRef])
  return { enterVisibleTranscript, layout: hasMeasuredLayout ? rendered!.layout : estimated!, measuredLayout, onManualScroll }
}
