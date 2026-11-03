import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core"
import type { ThreadId } from "@vimex/conversation"
import {
  graphemes,
  type TranscriptFrame,
  type UrlCandidate,
} from "@vimex/transcript"
import type { TranscriptPresentationId } from "@vimex/workbench"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import type { VimexUiController } from "../contracts"
import type { TranscriptLayout } from "../transcript/layout"
import type { LinkAction } from "./LinkActionsBar"
import { linkAtMouse, sameLink, unmodifiedLeftMouse } from "./link-pointer"

export function useTranscriptLinks(options: {
  controller: VimexUiController
  threadId?: ThreadId
  machineId: string
  presentationId: TranscriptPresentationId
  frame: TranscriptFrame
  layout: RefObject<TranscriptLayout | undefined>
  scrollRef: RefObject<ScrollBoxRenderable | null>
  enabled: boolean
  keyboardFocused: boolean
}) {
  const { frame, threadId, presentationId, controller } = options
  const [hovered, setHovered] = useState<
    | {
        candidate: UrlCandidate
        threadId: ThreadId
        ownerKey: string
        scrollTop: number
      }
    | undefined
  >()
  const [dismissed, setDismissed] = useState<string | undefined>()
  const pressed = useRef<
    | { candidate: UrlCandidate; x: number; y: number; ownerKey: string }
    | undefined
  >(undefined)
  const revision = frame.displayedCanonicalRevision
  const ownerKey = `${options.machineId}:${threadId}:${frame.canonicalGeneration}:${revision}`
  useEffect(() => {
    pressed.current = undefined
    setHovered(undefined)
    setDismissed(undefined)
  }, [ownerKey, options.enabled])
  const hit = useCallback(
    (event: MouseEvent) =>
      options.enabled
        ? linkAtMouse(
            frame,
            options.layout.current,
            options.scrollRef.current,
            event.x,
            event.y,
          )
        : undefined,
    [options.enabled, frame, options.layout, options.scrollRef],
  )
  const remember = useCallback(
    (candidate: UrlCandidate) => {
      if (!threadId) return
      setDismissed(undefined)
      setHovered((previous) =>
        previous &&
        previous.threadId === threadId &&
        previous.ownerKey === ownerKey &&
        previous.scrollTop === (options.scrollRef.current?.scrollTop ?? 0) &&
        sameLink(previous.candidate, candidate)
          ? previous
          : {
              candidate,
              threadId,
              ownerKey,
              scrollTop: options.scrollRef.current?.scrollTop ?? 0,
            },
      )
    },
    [threadId, ownerKey, options.scrollRef],
  )
  const cursor = frame.transcript.cursor
  const projection = cursor && frame.transcript.projectionById[cursor.itemId]
  const cursorLink =
    options.keyboardFocused &&
    cursor &&
    projection?.links.find(
      (link) =>
        cursor.graphemeOffset >= link.from && cursor.graphemeOffset < link.to,
    )
  const keyboard = useMemo(
    () =>
      cursorLink && cursor && projection
        ? {
            itemId: cursor.itemId,
            url: cursorLink.url,
            text: graphemes(projection.plain)
              .slice(cursorLink.from, cursorLink.to)
              .join(""),
            from: { itemId: cursor.itemId, graphemeOffset: cursorLink.from },
            to: { itemId: cursor.itemId, graphemeOffset: cursorLink.to },
          }
        : undefined,
    [cursorLink, cursor?.itemId, projection],
  )
  const candidate = options.enabled
    ? hovered &&
      hovered.threadId === threadId &&
      hovered.ownerKey === ownerKey &&
      hovered.scrollTop === (options.scrollRef.current?.scrollTop ?? 0)
      ? hovered.candidate
      : keyboard
    : undefined
  const key = candidate
    ? `${candidate.itemId}:${candidate.from.graphemeOffset}:${candidate.url}`
    : undefined
  const activate = useCallback(
    (candidate: UrlCandidate, action: LinkAction) => {
      if (!threadId || !options.enabled) return
      controller.transcript({
        type: "link.action",
        action,
        candidate,
        presentationId,
        threadId,
        displayedCanonicalRevision: revision,
        machineId: options.machineId,
        canonicalGeneration: frame.canonicalGeneration,
      })
    },
    [
      threadId,
      options.enabled,
      controller,
      presentationId,
      revision,
      options.machineId,
      frame.canonicalGeneration,
    ],
  )
  const clear = useCallback(() => {
    pressed.current = undefined
    setHovered(undefined)
  }, [])
  const onMouseMove = useCallback(
    (event: MouseEvent) => {
      const found = hit(event)
      if (found) remember(found)
    },
    [hit, remember],
  )
  const onMouseDown = useCallback(
    (event: MouseEvent) => {
      pressed.current = undefined
      if (!unmodifiedLeftMouse(event)) return
      const found = hit(event)
      if (!found) {
        setHovered(undefined)
        return
      }
      remember(found)
      pressed.current = { candidate: found, x: event.x, y: event.y, ownerKey }
    },
    [hit, remember, ownerKey],
  )
  const onMouseDrag = useCallback(() => {
    pressed.current = undefined
  }, [])
  const onMouseUp = useCallback(
    (event: MouseEvent) => {
      const down = pressed.current
      pressed.current = undefined
      if (
        !down ||
        !unmodifiedLeftMouse(event) ||
        down.ownerKey !== ownerKey ||
        event.x !== down.x ||
        event.y !== down.y ||
        !sameLink(down.candidate, hit(event))
      )
        return
      activate(down.candidate, "open")
    },
    [hit, activate, ownerKey],
  )
  return {
    candidate: dismissed === key ? undefined : candidate,
    onAction: (action: LinkAction) => {
      if (candidate) activate(candidate, action)
    },
    dismiss: () => {
      setDismissed(key)
      setHovered(undefined)
    },
    clear,
    onMouseMove,
    onMouseDown,
    onMouseDrag,
    onMouseUp,
  }
}
