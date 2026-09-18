import { LinearScrollAccel, type ScrollBoxRenderable, type SyntaxStyle } from "@opentui/core"
import type { ConversationItem } from "@vimex/conversation"
import type { InteractionState } from "@vimex/interaction"
import type { TranscriptState } from "@vimex/transcript"
import { memo, useMemo, type RefObject } from "react"
import { selectedRangeForItem } from "./layout"
import { emberTide } from "../theme"
import { TranscriptNode } from "./TranscriptNode"

export function TranscriptViewport(props: {
  items: readonly ConversationItem[]
  state: TranscriptState
  interaction: InteractionState
  syntax: SyntaxStyle
  scrollRef: RefObject<ScrollBoxRenderable | null>
  onManualScroll?: () => void
}) {
  // Terminal wheel events already encode movement; deterministic deltas avoid
  // accelerating trackpad bursts into large, unexpected viewport jumps.
  const scrollAcceleration = useMemo(() => new LinearScrollAccel(), [])
  const cursorId = props.state.cursor?.itemId
  return (
    <scrollbox
      id="transcript"
      ref={props.scrollRef}
      flexGrow={1}
      minHeight={0}
      stickyScroll={props.state.viewport.kind === "tail"}
      scrollAcceleration={scrollAcceleration}
      onMouseScroll={(event) => {
        if (event.scroll?.direction !== "up" && event.scroll?.direction !== "down") return
        if (event.modifiers.shift) return
        // Disable native edge reattachment immediately, including a wheel-down
        // at the bottom. Only an explicit follow action may attach the tail.
        if (props.scrollRef.current) props.scrollRef.current.stickyScroll = false
        props.onManualScroll?.()
        event.stopPropagation()
      }}
      stickyStart="bottom"
      viewportCulling
      contentOptions={{ paddingX: 2, paddingY: 1 }}
      verticalScrollbarOptions={{
        visible: false,
        trackOptions: { foregroundColor: emberTide.border, backgroundColor: emberTide.background },
      }}
    >
      {props.items.length === 0 ? (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={emberTide.textMuted}>Start a conversation</text>
        </box>
      ) : null}
      {props.items.map((item) => {
        const folded = Boolean(props.state.folded[item.id])
        const current = cursorId === item.id && props.interaction.surface === "transcript"
        const selected = Boolean(selectedRangeForItem(props.state, item.id))
        return (
          <TranscriptRow key={item.id} item={item} folded={folded} current={current} selected={selected} syntax={props.syntax} />
        )
      })}
    </scrollbox>
  )
}


// Stable historical rows skip Markdown reconciliation during typing and scrolling.
const TranscriptRow = memo(function TranscriptRow(props: {
  item: ConversationItem; folded: boolean; current: boolean; selected: boolean; syntax: SyntaxStyle
}) {
  return (
    <box id={`transcript-item:${props.item.id}`} flexShrink={0} marginBottom={1}
      border={["left"]} borderColor={props.selected ? emberTide.amber : props.current ? emberTide.blueBright : emberTide.borderMuted}
      paddingLeft={2} backgroundColor={props.item.kind === "user" ? emberTide.backgroundPanel : emberTide.background}>
      <TranscriptNode item={props.item} folded={props.folded} syntax={props.syntax} />
    </box>
  )
})
