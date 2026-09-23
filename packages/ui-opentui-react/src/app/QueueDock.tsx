import type { ScrollBoxRenderable } from "@opentui/core"
import type { OutgoingMessage } from "@vimex/composer"
import { usePaneGeometry } from "../side-chat/pane-geometry"
import { emberTide } from "../theme"
import { useEffect, useRef, type RefObject } from "react"

function preview(message: OutgoingMessage): string {
  const text = message.text.replace(/\s+/gu, " ").trim()
  return (
    text || message.images?.map((image) => image.label).join(", ") || "[image]"
  )
}

function queueSizing(height: number) {
  const compact = height < 16
  return {
    compact,
    rowCount: compact ? 1 : height < 20 ? 2 : 3,
    detailHeight: compact ? 1 : height < 20 ? 2 : 3,
  }
}

export function queueDockHeight(
  terminalHeight: number,
  messageCount: number,
  focused: boolean,
): number {
  if (messageCount === 0) return 0
  if (!focused) return 1
  const { compact, rowCount, detailHeight } = queueSizing(terminalHeight)
  return Math.min(messageCount, rowCount) + detailHeight + (compact ? 1 : 2)
}

export function QueueDock(props: {
  messages: readonly OutgoingMessage[]
  selectedId?: string
  confirmRemoveId?: string
  notice?: string
  visible?: boolean
  detailScrollRef: RefObject<ScrollBoxRenderable | null>
}) {
  const dimensions = usePaneGeometry()
  const previousSelection = useRef(props.selectedId)
  const selectedIndex = props.messages.findIndex(
    (message) => message.id === props.selectedId,
  )
  const selected =
    selectedIndex >= 0 ? props.messages[selectedIndex] : undefined
  const { compact, rowCount, detailHeight } = queueSizing(dimensions.height)
  const first = Math.max(
    0,
    Math.min(selectedIndex - rowCount + 1, props.messages.length - rowCount),
  )
  const visible = props.messages.slice(first, first + rowCount)

  useEffect(() => {
    if (previousSelection.current === props.selectedId) return
    previousSelection.current = props.selectedId
    props.detailScrollRef.current?.scrollTo(0)
  }, [props.detailScrollRef, props.selectedId])

  if (props.visible === false || props.messages.length === 0) return null
  if (!selected)
    return (
      <box
        id="queue-dock"
        height={1}
        flexShrink={0}
        flexDirection="row"
        gap={1}
        paddingX={2}
        backgroundColor={emberTide.backgroundPanel}
      >
        <text flexShrink={0} fg={emberTide.blueBright}>
          {dimensions.width < 28
            ? `${props.messages.length}q`
            : `${props.messages.length} queued`}
        </text>
        <text
          flexGrow={1}
          minWidth={0}
          wrapMode="none"
          truncate
          fg={emberTide.textSoft}
        >
          {dimensions.width < 52 ? "" : "latest: "}
          {preview(props.messages[props.messages.length - 1]!)}
        </text>
        {dimensions.width >= 52 ? (
          <text flexShrink={0} fg={emberTide.textMuted}>
            ctrl-k view
          </text>
        ) : null}
      </box>
    )

  return (
    <box
      id="queue-dock"
      height={queueDockHeight(dimensions.height, props.messages.length, true)}
      flexShrink={0}
      flexDirection="column"
      gap={0}
      paddingX={2}
      backgroundColor={emberTide.backgroundPanel}
    >
      {compact ? null : (
        <text height={1} flexShrink={0} fg={emberTide.blueBright}>
          QUEUE · {props.messages.length} total
        </text>
      )}
      {visible.map((message, index) => (
        <box
          key={message.id}
          height={1}
          flexShrink={0}
          flexDirection="row"
          gap={1}
        >
          <text
            height={1}
            flexShrink={0}
            fg={
              message.id === selected.id ? emberTide.amber : emberTide.textMuted
            }
          >
            {message.id === selected.id ? ">" : " "}
            {first + index + 1}.
          </text>
          <text
            flexGrow={1}
            height={1}
            minWidth={0}
            wrapMode="none"
            truncate
            fg={
              message.id === selected.id ? emberTide.text : emberTide.textSoft
            }
          >
            {preview(message)}
          </text>
          {message.intent === "steer" ? (
            <text height={1} flexShrink={0} fg={emberTide.amber}>
              steer
            </text>
          ) : null}
        </box>
      ))}
      <scrollbox
        id="queue-detail"
        ref={props.detailScrollRef}
        height={detailHeight}
        maxHeight={detailHeight}
        flexShrink={0}
        backgroundColor={emberTide.backgroundRaised}
      >
        <text fg={emberTide.text} wrapMode="word">
          {selected.text || "[image-only message]"}
        </text>
        {selected.images?.map((image) => (
          <text key={image.id} fg={emberTide.textMuted}>
            {image.label}
          </text>
        ))}
      </scrollbox>
      <text
        id="queue-hint"
        height={1}
        flexShrink={0}
        fg={props.confirmRemoveId ? emberTide.red : emberTide.textMuted}
        wrapMode="none"
        truncate
      >
        {props.confirmRemoveId
          ? "Remove this queued message? y yes · n no"
          : (props.notice ??
            "ctrl-k/j move · e unqueue · x remove · ctrl-u/d read")}
      </text>
    </box>
  )
}
