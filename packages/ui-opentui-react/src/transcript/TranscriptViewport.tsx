import { LinearScrollAccel, type ScrollBoxRenderable, type SyntaxStyle } from "@opentui/core"
import type { ConversationItem } from "@vimex/conversation"
import type { InteractionState } from "@vimex/interaction"
import type { TranscriptState, TranscriptWindow } from "@vimex/transcript"
import { memo, useMemo, type RefObject } from "react"
import { selectedRangeForItem } from "./layout"
import { emberTide } from "../theme"
import { TranscriptNode } from "./TranscriptNode"
import { TurnActivity } from "./TurnActivity"

export function TranscriptViewport(props: {
  window: TranscriptWindow
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
      {!props.window.blocks.length ? (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={emberTide.textMuted}>Start a conversation</text>
        </box>
      ) : null}
      {props.window.topSpacerRows > 0 ? <box id="transcript-top-spacer" height={props.window.topSpacerRows} flexShrink={0} /> : null}
      {props.window.blocks.map((block, index) => {
        if ("turn" in block) return <TurnActivity key={`turn:${block.key.turnId}`} turn={block.turn} />
        if (!("item" in block)) return null
        const folded = Boolean(props.state.folded[block.key.itemId])
        const current = cursorId === block.key.itemId && props.interaction.surface === "transcript"
        const selected = Boolean(selectedRangeForItem(props.state, block.key.itemId))
        const next = props.window.blocks[index + 1]
        const followedByActivity = Boolean(next && "turn" in next && next.key.turnId === block.turnId)
        return <TranscriptRow key={`item:${block.key.itemId}:${block.key.blockId}`} item={block.item} folded={folded} current={current} selected={selected} followedByActivity={followedByActivity} syntax={props.syntax} />
      })}
      {props.window.bottomSpacerRows > 0 ? <box id="transcript-bottom-spacer" height={props.window.bottomSpacerRows} flexShrink={0} /> : null}
    </scrollbox>
  )
}

// Stable historical rows skip Markdown reconciliation during typing and scrolling.
const TranscriptRow = memo(function TranscriptRow(props: {
  item: ConversationItem
  folded: boolean
  current: boolean
  selected: boolean
  followedByActivity: boolean
  syntax: SyntaxStyle
}) {
  return (
    <box id={`transcript-item:${props.item.id}`} flexShrink={0} marginBottom={props.followedByActivity ? 0 : 1}
      border={["left"]} borderColor={props.selected ? emberTide.amber : props.current ? emberTide.blueBright : emberTide.borderMuted}
      paddingLeft={2} paddingRight={props.item.kind === "user" ? 2 : 0} paddingY={props.item.kind === "user" ? 1 : 0} backgroundColor={props.item.kind === "user" ? emberTide.backgroundPanel : emberTide.background}>
      <TranscriptNode item={props.item} folded={props.folded} syntax={props.syntax} />
    </box>
  )
})
