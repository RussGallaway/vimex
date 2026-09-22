import type { SyntaxStyle } from "@opentui/core"
import { emberTide } from "../theme"
import {
  MarkdownMessage,
  type MarkdownConversationItem,
} from "./MarkdownMessage"

export function ReasoningBlock(props: {
  item: MarkdownConversationItem
  folded: boolean
  syntax: SyntaxStyle
}) {
  const running = props.item.status === "running"
  const summary = props.item.markdown
    .trim()
    .match(/^\*\*([^*\n]+)\*\*(?:\r?\n|$)/)?.[1]
    ?.trim()
  return (
    <box flexDirection="column">
      <box
        height={1}
        flexDirection="row"
        gap={1}
        backgroundColor={emberTide.backgroundRaised}
        paddingX={1}
      >
        <text
          id={`decoration:fold:${props.item.id}`}
          flexShrink={0}
          fg={emberTide.textMuted}
        >
          {props.folded ? "▸" : "▾"}
        </text>
        <box
          id={`decoration:phase:${props.item.id}`}
          flexShrink={0}
          flexDirection="row"
          gap={1}
        >
          <text fg={running ? emberTide.blueBright : emberTide.textMuted}>
            {running ? "⋯" : "◇"}
          </text>
          <text fg={emberTide.textSoft}>
            {running ? "Thinking" : "Reasoning"}
          </text>
        </box>
        {props.folded && summary ? (
          <text
            fg={emberTide.textMuted}
            flexShrink={1}
            minWidth={0}
            wrapMode="none"
            truncate
          >
            {summary}
          </text>
        ) : null}
      </box>
      {!props.folded ? (
        <MarkdownMessage item={props.item} syntax={props.syntax} />
      ) : null}
    </box>
  )
}
