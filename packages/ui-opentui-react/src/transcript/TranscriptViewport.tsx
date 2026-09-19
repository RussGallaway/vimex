import { LinearScrollAccel, type ScrollBoxRenderable, type SyntaxStyle } from "@opentui/core"
import type { ConversationItem, Turn, TurnId } from "@vimex/conversation"
import type { InteractionState } from "@vimex/interaction"
import type { TranscriptState } from "@vimex/transcript"
import { Fragment, memo, useMemo, type RefObject } from "react"
import { selectedRangeForItem } from "./layout"
import { emberTide } from "../theme"
import { TranscriptNode } from "./TranscriptNode"
import { hasTurnActivity, TurnActivity } from "./TurnActivity"

export function TranscriptViewport(props: {
  items: readonly ConversationItem[]
  hiddenTurnIds?: readonly string[]
  turns?: Readonly<Record<string, Turn>>
  turnIds?: readonly TurnId[]
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
  const emptyTurnPlacement = useMemo(() => {
    const before: Record<string, Turn[]> = {}
    const trailing: Turn[] = []
    const visible = new Set(props.state.order)
    const hiddenTurns = new Set(props.hiddenTurnIds)
    let pending: Turn[] = []
    for (const id of props.turnIds ?? []) {
      const turn = props.turns?.[id]
      if (!turn) continue
      const firstVisible = turn.itemIds.find(itemId => visible.has(itemId))
      if (firstVisible) {
        if (pending.length) before[firstVisible] = pending
        pending = []
      } else if (hasTurnActivity(turn) && !hiddenTurns.has(id)) pending.push(turn)
    }
    trailing.push(...pending)
    return { before, trailing }
  }, [props.hiddenTurnIds, props.state.order, props.turnIds, props.turns])
  const hasContent = props.items.length > 0 || Object.keys(emptyTurnPlacement.before).length > 0 || emptyTurnPlacement.trailing.length > 0
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
      {!hasContent ? (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={emberTide.textMuted}>Start a conversation</text>
        </box>
      ) : null}
      {props.items.map((item, index) => {
        const folded = Boolean(props.state.folded[item.id])
        const current = cursorId === item.id && props.interaction.surface === "transcript"
        const selected = Boolean(selectedRangeForItem(props.state, item.id))
        const turn = props.turns?.[item.turnId]
        const completesTurn = props.items[index + 1]?.turnId !== item.turnId
        const showTurnActivity = Boolean(turn && completesTurn && hasTurnActivity(turn))
        return (
          <Fragment key={item.id}>
            {emptyTurnPlacement.before[item.id]?.map(empty => <TurnActivity key={empty.id} turn={empty} />)}
            <TranscriptRow item={item} folded={folded} current={current} selected={selected} followedByActivity={showTurnActivity} syntax={props.syntax} />
            {turn && showTurnActivity ? <TurnActivity turn={turn} /> : null}
          </Fragment>
        )
      })}
      {emptyTurnPlacement.trailing.map(turn => <TurnActivity key={turn.id} turn={turn} />)}
    </scrollbox>
  )
}


// Stable historical rows skip Markdown reconciliation during typing and scrolling.
const TranscriptRow = memo(function TranscriptRow(props: {
  item: ConversationItem; folded: boolean; current: boolean; selected: boolean; followedByActivity: boolean; syntax: SyntaxStyle
}) {
  return (
    <box id={`transcript-item:${props.item.id}`} flexShrink={0} marginBottom={props.followedByActivity ? 0 : 1}
      border={["left"]} borderColor={props.selected ? emberTide.amber : props.current ? emberTide.blueBright : emberTide.borderMuted}
      paddingLeft={2} paddingRight={props.item.kind === "user" ? 2 : 0} paddingY={props.item.kind === "user" ? 1 : 0} backgroundColor={props.item.kind === "user" ? emberTide.backgroundPanel : emberTide.background}>
      <TranscriptNode item={props.item} folded={props.folded} syntax={props.syntax} />
    </box>
  )
})
