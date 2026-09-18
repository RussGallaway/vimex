import type { ScrollBoxRenderable, SyntaxStyle } from "@opentui/core"
import type { ConversationItem } from "@vimex/conversation"
import type { InteractionState } from "@vimex/interaction"
import type { TranscriptState } from "@vimex/transcript"
import type { RefObject } from "react"
import { selectedRangeForItem } from "./layout"
import { emberTide } from "../theme"
import { TranscriptNode } from "./TranscriptNode"

export function TranscriptViewport(props: {
  items: readonly ConversationItem[]
  state: TranscriptState
  interaction: InteractionState
  syntax: SyntaxStyle
  scrollRef: RefObject<ScrollBoxRenderable | null>
}) {
  const cursorId = props.state.cursor?.itemId
  return (
    <scrollbox
      id="transcript"
      ref={props.scrollRef}
      flexGrow={1}
      minHeight={0}
      stickyScroll
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
          <box
            id={`transcript-item:${item.id}`}
            key={item.id}
            flexShrink={0}
            marginBottom={1}
            border={["left"]}
            borderColor={selected ? emberTide.amber : current ? emberTide.blueBright : emberTide.borderMuted}
            paddingLeft={2}
            backgroundColor={item.kind === "user" ? emberTide.backgroundPanel : emberTide.background}
          >
            <TranscriptNode item={item} folded={folded} syntax={props.syntax} />
          </box>
        )
      })}
    </scrollbox>
  )
}
