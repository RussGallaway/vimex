import { type ScrollBoxRenderable } from "@opentui/core"
import { flushSync, useRenderer } from "@opentui/react"
import { prepareNativeTranscriptLayout } from "./scroll-preparation"
import type { ThreadId } from "@vimex/conversation"
import {
  blockGraphemeRange,
  blockKey,
  transcriptOrderIndex,
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
import { invalidateRenderedBlock } from "./measure-rendered-block"
import {
  measureRenderedTranscript,
  measuredPoint,
  topVisiblePoint,
  visibleMeasuredPoints,
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
  const prepareScroll = useRef<(() => void) | undefined>(undefined)
  const { transcript, threadId, width, height, scrollRef, controller } = options
  const latest = useRef(options)
  latest.current = options
  const measuredLayout = useRef<TranscriptLayout | undefined>(undefined)
  const currentMeasuredLayout = useRef<TranscriptLayout | undefined>(undefined)
  const [, publishPlacement] = useState(0)
  const queuedViewport = useRef<TranscriptState["viewport"] | undefined>(
    undefined,
  )
  const queuedIntentRevision = useRef<number | undefined>(undefined)
  const pendingScrollRows = useRef<
    Array<{ rows: number; cursor?: "follow" | "clamp" }>
  >([])
  const pendingCursor = useRef<{ row: number; column: number } | undefined>(
    undefined,
  )
  const pendingNativeScroll = useRef(false)
  const pendingNativeDirection = useRef<"up" | "down" | undefined>(undefined)
  const coldContinuation = useRef(false)
  const pendingAnchor = useRef(false)
  const pendingRestore = useRef(false)
  const lastScrollTop = useRef(0)
  // One native preposition per requested point; the mounted window can stay
  // identical across distant semantic jumps inside the generous hot tail.
  const prepositionedTarget = useRef<
    | {
        blocks: TranscriptFrame["window"]["blocks"]
        point: LogicalPoint
        preferredScreenRow: number
        intentRevision: number
      }
    | undefined
  >(undefined)
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
    currentMeasuredLayout.current = undefined
    prepositionedTarget.current = undefined
    pendingScrollRows.current = []
    pendingCursor.current = undefined
    pendingNativeScroll.current = false
    pendingNativeDirection.current = undefined
    coldContinuation.current = false
    queuedViewport.current = undefined
    queuedIntentRevision.current = undefined
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
    prepositionedTarget.current = undefined
    pendingScrollRows.current = []
    pendingCursor.current = undefined
    pendingNativeScroll.current = false
    pendingNativeDirection.current = undefined
    coldContinuation.current = false
    queuedViewport.current = undefined
    queuedIntentRevision.current = undefined
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
    let translated = translateTranscriptLayout(prior, 0, deltaY)
    let anchor = topVisiblePoint(translated, scrollbox)
    if (current.runtime && current.frame) {
      const frame = current.frame
      // A newly visible fragment can retain estimated height or an empty
      // source map while its Markdown children finish native layout. Refresh
      // only visible roots before deriving a semantic anchor from the index.
      const underestimated = frame.window.blocks.flatMap((block) => {
        const root = scrollbox.getRenderable(transcriptBlockRenderableId(block))
        if (
          !root ||
          root.screenY >=
            scrollbox.viewport.screenY + scrollbox.viewport.height ||
          root.screenY + root.height <= scrollbox.viewport.screenY ||
          (anchor && root.screenY > anchor.screenY)
        )
          return []
        const geometry = frame.geometry.byBlockKey[blockKey(block)]
        const hasUnmappedSource =
          "projection" in block &&
          blockGraphemeRange(block).to > blockGraphemeRange(block).from &&
          Object.keys(geometry?.pointOffsetsByRow ?? {}).length === 0
        return geometry?.rows === undefined ||
          geometry.rows < root.height ||
          hasUnmappedSource
          ? [root]
          : []
      })
      if (underestimated.length) {
        prepareNativeTranscriptLayout(renderer)
        for (const root of underestimated) invalidateRenderedBlock(root)
        const measuredFrame = current.runtime.getSnapshot()
        let recovered = measureRenderedTranscript(renderer, scrollbox, {
          frame: measuredFrame,
          runtime: current.runtime,
          styleRevision: current.styleRevision ?? "default",
        })
        // The measurement may publish corrected heights and a new window.
        // Read its geometry while the overlapping native roots are still here.
        const correctedFrame = current.runtime.getSnapshot()
        if (correctedFrame !== measuredFrame)
          recovered = measureRenderedTranscript(renderer, scrollbox, {
            frame: correctedFrame,
            runtime: current.runtime,
            styleRevision: current.styleRevision ?? "default",
          })
        if (recovered) {
          translated = recovered
          anchor = topVisiblePoint(recovered, scrollbox)
        }
      }
    }
    let fallback: ReturnType<TranscriptRuntime["scrollAnchorAtRow"]>
    if (!anchor && current.runtime) {
      const runtimeFrame = current.runtime.getSnapshot()
      const viewport = runtimeFrame.transcript.viewport
      // A height correction can move native spacer coordinates by many rows.
      // Start from the last semantic anchor in the current height index when
      // possible, then apply the requested native scroll displacement.
      let documentRow: number | undefined
      if (viewport.kind === "point")
        for (const block of runtimeFrame.window.blocks) {
          if (
            !("projection" in block) ||
            block.key.itemId !== viewport.point.itemId
          )
            continue
          const range = blockGraphemeRange(block)
          if (
            viewport.point.graphemeOffset < range.from ||
            viewport.point.graphemeOffset >= range.to
          )
            continue
          const key = blockKey(block)
          const start = runtimeFrame.geometry.rowByBlockKey[key]
          const local =
            runtimeFrame.geometry.byBlockKey[key]?.points[
              viewport.point.graphemeOffset
            ]
          if (start !== undefined && local) {
            documentRow =
              start + local.row - viewport.preferredScreenRow - deltaY
            break
          }
        }
      if (documentRow === undefined) {
        const entry = Object.entries(translated.placementByBlockKey ?? {}).find(
          ([key]) => translated.geometry?.rowByBlockKey[key] !== undefined,
        )
        documentRow = entry
          ? translated.geometry!.rowByBlockKey[entry[0]]! +
            scrollbox.viewport.screenY -
            entry[1].screenY -
            (translated.screenOffset?.y ?? 0)
          : scrollbox.scrollTop
      }
      fallback = current.runtime.scrollAnchorAtRow(documentRow)
      const transcript = current.runtime.getSnapshot().transcript
      const priorPoint =
        transcript.viewport.kind === "point"
          ? transcript.viewport.point
          : transcript.cursor
      if (fallback && priorPoint && deltaY !== 0) {
        const order = transcriptOrderIndex(transcript.order)
        const priorIndex = order.get(priorPoint.itemId)
        const fallbackIndex = order.get(fallback.point.itemId)
        const displacement =
          priorIndex === undefined || fallbackIndex === undefined
            ? 0
            : fallbackIndex - priorIndex ||
              fallback.point.graphemeOffset - priorPoint.graphemeOffset
        if (displacement * deltaY > 0) {
          // Estimated rows can land in an unmounted gap after a window shift.
          // Never let that approximation reverse the semantic direction of a
          // manual scroll; retain the last exact point until roots catch up.
          const priorRow =
            transcript.viewport.kind === "point"
              ? transcript.viewport.preferredScreenRow
              : scrollbox.viewport.height - 1
          fallback = {
            point: priorPoint,
            preferredScreenRow: Math.max(
              0,
              Math.min(scrollbox.viewport.height - 1, priorRow + deltaY),
            ),
          }
        }
      }
    }
    if (!anchor && !fallback) return false
    measuredLayout.current = translated
    lastScrollTop.current = scrollbox.scrollTop
    pendingAnchor.current = false
    pendingRestore.current = Boolean(fallback)
    const point = anchor
      ? {
          itemId: anchor.itemId,
          graphemeOffset: anchor.graphemeOffset,
        }
      : fallback!.point
    const row = anchor
      ? anchor.screenY - scrollbox.viewport.screenY
      : fallback!.preferredScreenRow
    if (current.onAnchor) current.onAnchor(point, row)
    else
      controller.transcript({
        type: "viewport.anchor",
        point,
        preferredScreenRow: row,
      })
    return true
  }, [controller, renderer, scrollRef])

  const onManualScroll = useCallback(
    (
      rows?: number,
      cursor?: "follow" | "clamp",
      direction?: "up" | "down",
      action?:
        | "line_up"
        | "line_down"
        | "half_page_up"
        | "half_page_down"
        | "page_up"
        | "page_down",
    ) => {
      controller.performanceNavigationInput?.(
        action ??
          (direction === "up"
            ? "wheel_up"
            : direction === "down"
              ? "wheel_down"
              : "other"),
      )
      const viewport =
        latest.current.runtime?.getSnapshot().transcript.viewport ??
        latest.current.transcript.viewport
      const intentRevision = latest.current.runtime?.getViewportIntentRevision()
      if (
        queuedIntentRevision.current !== undefined
          ? queuedIntentRevision.current !== intentRevision
          : queuedViewport.current && queuedViewport.current !== viewport
      ) {
        pendingScrollRows.current = []
        pendingCursor.current = undefined
        pendingNativeScroll.current = false
        pendingNativeDirection.current = undefined
        coldContinuation.current = false
      }
      queuedViewport.current = viewport
      queuedIntentRevision.current = intentRevision
      if (rows === undefined) {
        pendingNativeScroll.current = true
        pendingNativeDirection.current = direction
      } else pendingScrollRows.current.push({ rows, cursor })
      pendingRestore.current = false
      renderer.requestRender()
    },
    [controller, renderer],
  )

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
      const key = blockKey(target)
      const blockRow =
        frame.geometry.rowByBlockKey[key] ?? frame.window.topSpacerRows
      const localRow =
        frame.geometry.byBlockKey[key]?.points[point.graphemeOffset]?.row ?? 0
      const renderable = scrollbox.getRenderable(
        transcriptBlockRenderableId(target),
      )
      // A cold root must be placed far enough into view for its descendants
      // to receive native layout, even when its height is still estimated.
      if (renderable)
        scrollbox.scrollBy(
          renderable.screenY -
            scrollbox.viewport.screenY +
            localRow -
            preferredScreenRow,
          "step",
        )
      else
        scrollbox.scrollTo(
          Math.max(0, blockRow + localRow - preferredScreenRow),
        )
      if (
        renderable &&
        !frame.geometry.byBlockKey[key]?.points[point.graphemeOffset]
      )
        invalidateRenderedBlock(renderable)
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
          (measuredLayout.current?.materializedBlocks !==
            current.frame.window.blocks ||
            (measuredLayout.current &&
              !measuredPoint(
                measuredLayout.current,
                current.transcript.viewport.point,
              ))) &&
          (prepositionedTarget.current?.blocks !==
            current.frame.window.blocks ||
            prepositionedTarget.current.point.itemId !==
              current.transcript.viewport.point.itemId ||
            prepositionedTarget.current.point.graphemeOffset !==
              current.transcript.viewport.point.graphemeOffset ||
            prepositionedTarget.current.preferredScreenRow !==
              current.transcript.viewport.preferredScreenRow ||
            prepositionedTarget.current.intentRevision !==
              current.runtime.getViewportIntentRevision())
        ) {
          prepositionedTarget.current = {
            blocks: current.frame.window.blocks,
            point: current.transcript.viewport.point,
            preferredScreenRow: current.transcript.viewport.preferredScreenRow,
            intentRevision: current.runtime.getViewportIntentRevision(),
          }
          const beforePreposition = scrollbox.scrollTop
          prepositionWindowForPoint(
            current.frame,
            current.transcript.viewport.point,
            current.transcript.viewport.preferredScreenRow,
          )
          // Placement changed; refresh native descendant coordinates before
          // accepting any block-local measurement from this window.
          if (scrollbox.scrollTop !== beforePreposition) return
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
      currentMeasuredLayout.current = next
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
          (geometryChanged || lastScrollTop.current === scrollbox.scrollTop) &&
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
    const prepare = () => {
      const scrollbox = scrollRef.current
      if (!scrollbox) return
      const viewport =
        latest.current.runtime?.getSnapshot().transcript.viewport ??
        latest.current.transcript.viewport
      const superseded =
        queuedIntentRevision.current !== undefined
          ? queuedIntentRevision.current !==
            latest.current.runtime?.getViewportIntentRevision()
          : queuedViewport.current && queuedViewport.current !== viewport
      if (superseded) {
        pendingScrollRows.current = []
        pendingCursor.current = undefined
        pendingNativeScroll.current = false
        pendingNativeDirection.current = undefined
        coldContinuation.current = false
      }
      queuedViewport.current = undefined
      queuedIntentRevision.current = undefined
      const wasNativeScroll = pendingNativeScroll.current
      if (pendingNativeScroll.current) {
        const displacement = scrollbox.scrollTop - lastScrollTop.current
        pendingScrollRows.current.push({
          rows:
            displacement === 0 && pendingNativeDirection.current === "down"
              ? 1
              : displacement,
        })
        scrollbox.scrollTo(lastScrollTop.current)
        pendingNativeScroll.current = false
        pendingNativeDirection.current = undefined
        if (!pendingScrollRows.current.length) pendingAnchor.current = true
      }
      let coldBoundaryCrossed = coldContinuation.current
      coldContinuation.current = false
      const advance = () => {
        const prior = measuredLayout.current
        const top = scrollbox.viewport.screenY
        // Keep each key's cursor-follow boundary even when input arrives in a
        // burst; the queued moves are still resolved in this layout pass.
        const intent = pendingScrollRows.current.shift() ?? { rows: 0 }
        const requested = intent.rows
        const frame = latest.current.frame
        const coherent =
          prior &&
          (!frame ||
            (prior.materializedBlocks === frame.window.blocks &&
              prior.geometry === frame.geometry))
        const maxStep = Math.min(
          Math.abs(requested),
          Math.max(1, Math.floor(scrollbox.viewport.height / 2)),
        )
        let anchoredStep = 0
        if (coherent) {
          for (const point of visibleMeasuredPoints(prior, {
            screenY: Math.min(top, top + Math.sign(requested) * maxStep),
            height: maxStep + 1,
          })) {
            const delta = point.screenY - top
            if (
              !point.hidden &&
              Math.sign(delta) === Math.sign(requested) &&
              Math.abs(delta) <= maxStep &&
              Math.abs(delta) > Math.abs(anchoredStep)
            )
              anchoredStep = delta
          }
        }
        const step = anchoredStep || Math.sign(requested) * maxStep
        const cursor =
          latest.current.runtime?.getSnapshot().transcript.cursor ??
          latest.current.transcript.cursor
        const cursorPoint =
          cursor && prior ? measuredPoint(prior, cursor) : undefined
        scrollbox.stickyScroll = false
        const oldTop = scrollbox.scrollTop
        scrollbox.scrollBy(step, "step")
        const moved = scrollbox.scrollTop - oldTop
        const remaining = requested - moved
        if (
          requested > 0 &&
          scrollbox.scrollTop >=
            Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height)
        ) {
          // The current downward intent is complete at the tail. Keep later
          // queued keys so an opposite-direction key in the same batch runs.
          pendingCursor.current = undefined
          pendingAnchor.current = false
          pendingRestore.current = false
          scrollbox.stickyScroll = true
          const viewport =
            latest.current.runtime?.getSnapshot().transcript.viewport ??
            latest.current.transcript.viewport
          if (viewport.kind === "point")
            flushSync(() => controller.transcript({ type: "viewport.tail" }))
          return
        }
        if (moved !== 0 && remaining !== 0)
          pendingScrollRows.current.unshift({
            ...intent,
            rows: remaining,
          })
        if (moved === 0 && requested !== 0 && latest.current.runtime) {
          const runtime = latest.current.runtime
          const runtimeFrame = runtime.getSnapshot()
          const viewport = runtimeFrame.transcript.viewport
          const viewportPoint =
            viewport.kind === "point"
              ? viewport.point
              : runtimeFrame.transcript.cursor
          const preferredScreenRow =
            viewport.kind === "point"
              ? viewport.preferredScreenRow
              : scrollbox.viewport.height - 1
          const hasHistory =
            requested < 0
              ? runtimeFrame.window.topSpacerRows > 0
              : runtimeFrame.window.bottomSpacerRows > 0
          if (hasHistory && viewportPoint) {
            coldBoundaryCrossed = true
            const owning = runtimeFrame.window.blocks.find((block) => {
              if (
                !("projection" in block) ||
                block.key.itemId !== viewportPoint.itemId
              )
                return false
              const range = blockGraphemeRange(block)
              return (
                viewportPoint.graphemeOffset >= range.from &&
                (viewportPoint.graphemeOffset < range.to ||
                  (range.to === block.projection.sourceSpans.length &&
                    viewportPoint.graphemeOffset === range.to))
              )
            })
            const key = owning ? blockKey(owning) : undefined
            const start =
              key === undefined
                ? undefined
                : runtimeFrame.geometry.rowByBlockKey[key]
            const local =
              key === undefined
                ? undefined
                : runtimeFrame.geometry.byBlockKey[key]?.points[
                    viewportPoint.graphemeOffset
                  ]?.row
            const indexedRow =
              start !== undefined && local !== undefined
                ? start + local - preferredScreenRow
                : requested < 0
                  ? runtimeFrame.window.topSpacerRows
                  : runtimeFrame.window.topSpacerRows +
                    runtimeFrame.window.blocks.reduce(
                      (rows, block) =>
                        rows +
                        (runtimeFrame.geometry.byBlockKey[blockKey(block)]
                          ?.rows ?? 1),
                      0,
                    )
            const destination = runtime.scrollDestinationAtRow(
              indexedRow + requested,
            )
            const order = transcriptOrderIndex(runtimeFrame.transcript.order)
            const originIndex = order.get(viewportPoint.itemId)
            const targetIndex =
              destination && order.get(destination.point.itemId)
            const semanticMovement =
              originIndex === undefined || targetIndex === undefined
                ? 0
                : targetIndex - originIndex ||
                  destination!.point.graphemeOffset -
                    viewportPoint.graphemeOffset
            const rowMovement = destination
              ? destination.preferredScreenRow - preferredScreenRow
              : 0
            // A cold block may only have an estimated height and a fallback
            // point at its beginning. Accept a semantic move or a same-point
            // screen-row move only when it preserves the requested direction;
            // native measurement will choose the final visible cursor.
            const safeDirection =
              semanticMovement * requested > 0 ||
              (semanticMovement === 0 && rowMovement * requested < 0)
            if (destination && safeDirection) {
              if (intent.cursor && cursorPoint)
                pendingCursor.current = {
                  row: Math.max(
                    0,
                    Math.min(
                      scrollbox.viewport.height - 1,
                      cursorPoint.screenY - top,
                    ),
                  ),
                  column: cursorPoint.screenX - scrollbox.viewport.screenX,
                }
              pendingAnchor.current = false
              pendingRestore.current = true
              flushSync(() =>
                controller.transcript({
                  type: "viewport.anchor",
                  ...destination,
                }),
              )
              return
            }
          }
          // A native edge with no earlier or later semantic point consumes this
          // key. Keeping it queued would prevent the next opposite-direction
          // key from running when no further native frame is scheduled.
          return
        }
        if (intent.cursor && cursorPoint) {
          const translatedRow =
            cursorPoint.screenY -
            top -
            (intent.cursor === "clamp" ? scrollbox.scrollTop - oldTop : 0)
          // A visible cursor keeps its exact logical offset, even when multiple
          // offsets (such as a newline boundary) share one rendered cell.
          if (
            intent.cursor === "follow" ||
            translatedRow < 0 ||
            translatedRow >= scrollbox.viewport.height
          )
            pendingCursor.current = {
              row: Math.max(
                0,
                Math.min(scrollbox.viewport.height - 1, translatedRow),
              ),
              column: cursorPoint.screenX - scrollbox.viewport.screenX,
            }
        }
        pendingAnchor.current = true
        pendingRestore.current = false
        flushSync(() => captureScrolledAnchor())
      }
      // Capture manual intent against the previous coherent layout before any
      // simultaneous content change can replace its geometry.
      if (
        wasNativeScroll &&
        pendingScrollRows.current.length &&
        !pendingRestore.current &&
        measuredLayout.current
      )
        advance()
      // Keep the measured hot window's existing single-frame semantics. A
      // crossing into an unmounted window can require many native layout
      // passes; prepare a bounded number after that crossing, then paint the
      // newly mounted neighborhood before continuing on the next frame.
      let coldPreparationPasses = 0
      let deferredColdPreparation = false
      for (let pass = 0; pass < 128; pass++) {
        if (coldBoundaryCrossed && coldPreparationPasses++ >= 32) {
          const runtimeFrame = latest.current.runtime?.getSnapshot()
          const layout = measuredLayout.current
          const coherent =
            layout?.materializedBlocks === runtimeFrame?.window.blocks &&
            layout?.geometry === runtimeFrame?.geometry
          const visiblePoint =
            layout &&
            coherent &&
            visibleMeasuredPoints(layout, scrollbox.viewport).some(
              (point) => !point.hidden,
            )
          const visibleRoot =
            visiblePoint &&
            runtimeFrame?.window.blocks.some((block) => {
              if (!("projection" in block)) return false
              const root = scrollbox.getRenderable(
                transcriptBlockRenderableId(block),
              )
              return (
                root &&
                root.height > 0 &&
                root.screenY <
                  scrollbox.viewport.screenY + scrollbox.viewport.height &&
                root.screenY + root.height > scrollbox.viewport.screenY
              )
            })
          if (
            coherent &&
            layout &&
            pendingRestore.current &&
            runtimeFrame?.transcript.viewport.kind === "point"
          ) {
            const viewport = runtimeFrame.transcript.viewport
            const anchor = measuredPoint(layout, viewport.point)
            if (anchor) {
              const displacement =
                anchor.screenY -
                scrollbox.viewport.screenY -
                viewport.preferredScreenRow
              if (displacement) scrollbox.scrollBy(displacement, "step")
              else pendingRestore.current = false
            }
          }
          if (
            visibleRoot &&
            !pendingAnchor.current &&
            !pendingCursor.current &&
            !pendingRestore.current
          ) {
            deferredColdPreparation = true
            break
          }
        }
        const before = latest.current.runtime?.getSnapshot()
        const top = scrollbox.scrollTop
        flushSync(() => {
          prepareNativeTranscriptLayout(renderer)
          measure()
        })
        if (
          before?.window.blocks !==
          latest.current.runtime?.getSnapshot().window.blocks
        )
          coldBoundaryCrossed = true
        const settled =
          before === latest.current.runtime?.getSnapshot() &&
          top === scrollbox.scrollTop &&
          !pendingAnchor.current &&
          !pendingRestore.current
        if (!settled) continue
        if (pendingCursor.current && measuredLayout.current) {
          const desired = pendingCursor.current
          pendingCursor.current = undefined
          const candidates = visibleMeasuredPoints(
            measuredLayout.current,
            scrollbox.viewport,
          ).filter((point) => !point.hidden)
          let target: (typeof candidates)[number] | undefined
          let distance = Infinity
          for (const point of candidates) {
            const rowDistance = Math.abs(
              point.screenY - scrollbox.viewport.screenY - desired.row,
            )
            const columnDistance = Math.abs(
              point.screenX - scrollbox.viewport.screenX - desired.column,
            )
            const score = rowDistance * (renderer.width + 1) + columnDistance
            if (score < distance) {
              target = point
              distance = score
            }
          }
          if (target) {
            const cursor =
              latest.current.runtime?.getSnapshot().transcript.cursor ??
              latest.current.transcript.cursor
            if (
              cursor?.itemId !== target.itemId ||
              cursor.graphemeOffset !== target.graphemeOffset
            ) {
              const point = {
                itemId: target.itemId,
                graphemeOffset: target.graphemeOffset,
              }
              flushSync(() =>
                controller.transcript({
                  type: "cursor.move",
                  target: point,
                  preferredScreenRow:
                    target.screenY - scrollbox.viewport.screenY,
                  extend: false,
                }),
              )
              continue
            }
          }
        }
        if (!pendingScrollRows.current.length || pass >= 112) break
        // Consume the largest displacement whose rows are already measured.
        // Cold remainder is resolved after the next neighborhood is prepared.
        advance()
      }
      if (pendingScrollRows.current.length || deferredColdPreparation) {
        coldContinuation.current = deferredColdPreparation
        queuedViewport.current =
          latest.current.runtime?.getSnapshot().transcript.viewport ??
          latest.current.transcript.viewport
        queuedIntentRevision.current =
          latest.current.runtime?.getViewportIntentRevision()
        renderer.requestRender()
      }
    }
    const frameCallback = async () => prepare()
    prepareScroll.current = prepare
    renderer.setFrameCallback(frameCallback)
    renderer.requestRender()
    return () => {
      if (prepareScroll.current === prepare) prepareScroll.current = undefined
      renderer.removeFrameCallback(frameCallback)
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
  const flushManualScroll = useCallback(() => {
    if (pendingScrollRows.current.length || pendingCursor.current)
      prepareScroll.current?.()
  }, [])
  return {
    flushManualScroll,
    enterVisibleTranscript,
    layout,
    measuredLayout: currentMeasuredLayout,
    onManualScroll,
  }
}
