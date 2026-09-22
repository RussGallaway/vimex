import { CliRenderEvents, type ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import type { ThreadId } from "@vimex/conversation"
import {
  blockGraphemeRange,
  blockKey,
  type GeometryStyleRevision,
  type LogicalPoint,
  type TranscriptFrame,
  type TranscriptRuntime,
  type TranscriptState,
} from "@vimex/transcript"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import type { VimexUiController } from "../contracts"
import { buildTranscriptLayout, type TranscriptLayout } from "./layout"
import {
  measureRenderedTranscript,
  measuredPoint,
  topVisiblePoint,
  bottomVisiblePoint,
  rebaseTranscriptLayout,
  releaseRenderedTranscriptLayout,
  transcriptBlockRenderableId,
  transcriptItemRenderableId,
  translateTranscriptLayout,
  type RenderedLayoutDiagnostics,
} from "./rendered-layout"

/** Owns the volatile bridge between semantic anchors and terminal geometry. */
export function useTranscriptLayout(options: {
  threadId?: ThreadId
  transcript: TranscriptState
  frame?: TranscriptFrame
  runtime?: TranscriptRuntime
  styleRevision?: GeometryStyleRevision
  width: number
  height: number
  scrollRef: RefObject<ScrollBoxRenderable | null>
  controller: VimexUiController
  visible?: boolean
  /** Optional operation-count sink for scaling evidence; omitted in production UI use. */
  measurementDiagnostics?: RenderedLayoutDiagnostics
  /** Observes every completed measurement pass without owning geometry state. */
  onMeasurementDiagnostics?(
    diagnostics: Readonly<RenderedLayoutDiagnostics>,
  ): void
  onAnchor?(point: LogicalPoint, preferredScreenRow: number): void
}) {
  const renderer = useRenderer()
  const { transcript, threadId, width, height, scrollRef, controller } = options
  const latest = useRef(options)
  latest.current = options
  const measuredLayout = useRef<TranscriptLayout | undefined>(undefined)
  const currentMeasuredLayout = useRef<TranscriptLayout | undefined>(undefined)
  const [, publishPlacement] = useState(0)
  const pendingAnchor = useRef(false)
  const pendingRestore = useRef(false)
  const lastScrollTop = useRef(0)
  const hasRuntimeGeometry = Boolean(
    options.frame && options.frame.geometry.measuredBlockCount > 0,
  )
  const estimatedTranscript = useMemo(() => {
    if (!options.runtime || !options.frame) return transcript
    const order = Object.freeze([
      ...new Set(
        options.frame.window.blocks.flatMap((block) =>
          "projection" in block ? [block.key.itemId] : [],
        ),
      ),
    ])
    const projectionById = Object.freeze(
      Object.fromEntries(
        order.flatMap((itemId) => {
          const projection = transcript.projectionById[itemId]
          return projection ? [[itemId, projection]] : []
        }),
      ),
    )
    return Object.freeze({ ...transcript, order, projectionById })
  }, [options.frame?.window.blocks, options.runtime, transcript])
  // Estimated wrapping is only a startup fallback. Rewrapping the whole history
  // on each fold wastes work once native geometry is available.
  const estimated = useMemo(
    () =>
      hasRuntimeGeometry
        ? undefined
        : buildTranscriptLayout(estimatedTranscript, Math.max(8, width - 7)),
    [estimatedTranscript, hasRuntimeGeometry, width],
  )
  useLayoutEffect(() => {
    measuredLayout.current = undefined
    pendingAnchor.current = false
    pendingRestore.current = transcript.viewport.kind === "point"
    lastScrollTop.current = scrollRef.current?.scrollTop ?? 0
  }, [threadId])
  useLayoutEffect(() => {
    if (options.visible !== false) return
    // Native transcript roots are absent while the pane is hidden. Never let
    // their last placement escape into input handling after a later reveal.
    measuredLayout.current = undefined
    currentMeasuredLayout.current = undefined
    pendingAnchor.current = false
    pendingRestore.current = false
    lastScrollTop.current = 0
  }, [options.visible])
  useLayoutEffect(() => {
    if (options.visible === false) return
    if (transcript.viewport.kind !== "tail") return
    pendingAnchor.current = false
    pendingRestore.current = false
    scrollRef.current?.scrollTo(Number.MAX_SAFE_INTEGER)
  }, [threadId, transcript.viewport.kind, scrollRef, options.visible])
  useLayoutEffect(() => {
    if (options.visible === false) return
    if (transcript.viewport.kind === "point") pendingRestore.current = true
  }, [
    width,
    height,
    transcript.order,
    transcript.projectionById,
    transcript.folded,
    transcript.viewport,
    options.visible,
  ])

  const captureScrolledAnchor = useCallback((): boolean => {
    const current = latest.current
    const scrollbox = scrollRef.current
    const prior = measuredLayout.current
    if (!scrollbox || !prior) return false
    const deltaY = lastScrollTop.current - scrollbox.scrollTop
    const translated = translateTranscriptLayout(prior, 0, deltaY)
    const anchor = topVisiblePoint(translated, scrollbox)
    if (!anchor) return false
    measuredLayout.current = translated
    lastScrollTop.current = scrollbox.scrollTop
    pendingAnchor.current = false
    pendingRestore.current = false
    const point = {
      itemId: anchor.itemId,
      graphemeOffset: anchor.graphemeOffset,
    }
    const row = anchor.screenY - scrollbox.viewport.screenY
    if (current.onAnchor) current.onAnchor(point, row)
    else
      controller.transcript({
        type: "viewport.anchor",
        point,
        preferredScreenRow: row,
      })
    return true
  }, [controller, scrollRef])

  const onManualScroll = useCallback(() => {
    pendingAnchor.current = true
    pendingRestore.current = false
    renderer.requestRender()
  }, [renderer])

  const prepositionWindowForPoint = useCallback(
    (
      frame: TranscriptFrame,
      point: LogicalPoint,
      preferredScreenRow: number,
    ): void => {
      const scrollbox = scrollRef.current
      if (!scrollbox) return
      const target = frame.window.blocks.find((block) => {
        if (!("projection" in block) || block.key.itemId !== point.itemId)
          return false
        const range = blockGraphemeRange(block)
        return (
          point.graphemeOffset >= range.from &&
          (point.graphemeOffset < range.to ||
            (range.to === block.projection.sourceSpans.length &&
              point.graphemeOffset === range.to))
        )
      })
      if (!target || !("projection" in target)) return
      scrollbox.scrollChildIntoView(transcriptBlockRenderableId(target))
      const key = blockKey(target)
      const blockRow =
        frame.geometry.rowByBlockKey[key] ?? frame.window.topSpacerRows
      const localRow =
        frame.geometry.byBlockKey[key]?.points[point.graphemeOffset]?.row ?? 0
      const renderable = scrollbox.getRenderable(
        transcriptBlockRenderableId(target),
      )
      if (
        !renderable ||
        renderable.screenY < scrollbox.viewport.screenY ||
        renderable.screenY >=
          scrollbox.viewport.screenY + scrollbox.viewport.height
      ) {
        scrollbox.scrollTo(
          Math.max(0, blockRow + localRow - preferredScreenRow),
        )
      }
      lastScrollTop.current = scrollbox.scrollTop
    },
    [scrollRef],
  )

  useEffect(() => {
    if (options.visible === false) return
    const ownedScrollbox = scrollRef.current
    const measure = () => {
      const current = latest.current
      const scrollbox = scrollRef.current
      if (!scrollbox) return
      if (current.runtime && current.frame) {
        const configured = current.runtime.setWindowViewport(
          Math.max(1, scrollbox.viewport.height),
        )
        if (configured !== current.frame) {
          renderer.requestRender()
          return
        }
        if (
          pendingRestore.current &&
          current.transcript.viewport.kind === "point" &&
          measuredLayout.current?.materializedBlocks !==
            current.frame.window.blocks
        ) {
          prepositionWindowForPoint(
            current.frame,
            current.transcript.viewport.point,
            current.transcript.viewport.preferredScreenRow,
          )
        }
      }
      // A manual scroll establishes semantic meaning before dirty native
      // reflow is allowed to publish corrected heights around the old anchor.
      if (
        pendingAnchor.current &&
        measuredLayout.current &&
        lastScrollTop.current !== scrollbox.scrollTop
      ) {
        if (captureScrolledAnchor()) {
          renderer.requestRender()
          return
        }
      }
      const next = measureRenderedTranscript(
        renderer,
        scrollbox,
        current.frame
          ? {
              frame: current.frame,
              runtime: current.runtime,
              styleRevision: current.styleRevision ?? "default",
              diagnostics: current.measurementDiagnostics,
            }
          : current.transcript,
      )
      if (current.measurementDiagnostics)
        current.onMeasurementDiagnostics?.(current.measurementDiagnostics)
      if (!next) return
      // Measurement owns a geometry cache. Its stable identity avoids serializing
      // every logical point merely to discover that a frame has not changed.
      if (next !== measuredLayout.current) {
        const hadLayout = measuredLayout.current !== undefined
        const geometryChanged =
          next.geometry !== measuredLayout.current?.geometry
        measuredLayout.current = next
        // Geometry remains runtime-owned; this tick only exposes a newly
        // measured native placement to render-time consumers such as Flash.
        if (!hadLayout || geometryChanged)
          publishPlacement((value) => value + 1)
        // Markdown and table renderables can settle over later native frames
        // without changing transcript state. Reapply a detached logical anchor
        // after each real geometry revision so async reflow cannot move it.
        if (
          geometryChanged &&
          current.transcript.viewport.kind === "point" &&
          !pendingAnchor.current
        )
          pendingRestore.current = true
      }
      lastScrollTop.current = scrollbox.scrollTop
      if (pendingAnchor.current) {
        pendingAnchor.current = false
        pendingRestore.current = false
        const anchor = topVisiblePoint(next, scrollbox)
        if (anchor) {
          const point = {
            itemId: anchor.itemId,
            graphemeOffset: anchor.graphemeOffset,
          }
          const row = anchor.screenY - scrollbox.viewport.screenY
          if (current.onAnchor) current.onAnchor(point, row)
          else
            controller.transcript({
              type: "viewport.anchor",
              point,
              preferredScreenRow: row,
            })
        }
      } else if (
        pendingRestore.current &&
        current.transcript.viewport.kind === "point"
      ) {
        const viewport = current.transcript.viewport
        const anchor = measuredPoint(next, viewport.point)
        if (anchor) {
          pendingRestore.current = false
          const delta =
            anchor.screenY -
            scrollbox.viewport.screenY -
            viewport.preferredScreenRow
          if (delta) scrollbox.scrollBy(delta, "step")
        } else if (!current.runtime)
          scrollbox.scrollChildIntoView(
            transcriptItemRenderableId(viewport.point.itemId),
          )
      }
    }
    renderer.on(CliRenderEvents.FRAME, measure)
    renderer.requestRender()
    return () => {
      renderer.off(CliRenderEvents.FRAME, measure)
      if (ownedScrollbox) releaseRenderedTranscriptLayout(ownedScrollbox)
    }
  }, [
    captureScrolledAnchor,
    controller,
    options.visible,
    prepositionWindowForPoint,
    renderer,
    scrollRef,
  ])
  const enterVisibleTranscript = useCallback(() => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return
    // Measure at key time: scrolling may have occurred since the last frame.
    const current = latest.current
    const next = measureRenderedTranscript(
      renderer,
      scrollbox,
      current.frame
        ? {
            frame: current.frame,
            runtime: current.runtime,
            styleRevision: current.styleRevision ?? "default",
            diagnostics: current.measurementDiagnostics,
          }
        : current.transcript,
    )
    if (current.measurementDiagnostics)
      current.onMeasurementDiagnostics?.(current.measurementDiagnostics)
    if (!next) return
    const point = bottomVisiblePoint(next, scrollbox)
    if (!point) return
    measuredLayout.current = next
    pendingAnchor.current = false
    pendingRestore.current = false
    controller.transcript({
      type: "cursor.move",
      target: { itemId: point.itemId, graphemeOffset: point.graphemeOffset },
      preferredScreenRow: point.screenY - scrollbox.viewport.screenY,
      extend: false,
    })
  }, [controller, renderer, scrollRef])
  const currentWindow =
    !options.runtime ||
    measuredLayout.current?.materializedBlocks === options.frame?.window.blocks
  const currentLayout =
    currentWindow &&
    (!options.runtime ||
      measuredLayout.current?.geometry === options.frame?.geometry)
      ? measuredLayout.current
      : undefined
  const rebased =
    !currentLayout && currentWindow && options.frame && measuredLayout.current
      ? rebaseTranscriptLayout(measuredLayout.current, options.frame.geometry)
      : undefined
  const layout =
    currentLayout ??
    rebased ??
    estimated ??
    buildTranscriptLayout(estimatedTranscript, Math.max(8, width - 7))
  // Input consumers must never bypass the current runtime frame by reading an
  // older native layout during the remeasurement frame.
  currentMeasuredLayout.current = currentLayout ?? rebased
  return {
    enterVisibleTranscript,
    layout,
    measuredLayout: currentMeasuredLayout,
    onManualScroll,
  }
}
