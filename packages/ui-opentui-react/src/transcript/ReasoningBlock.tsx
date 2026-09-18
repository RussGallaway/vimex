import type { SyntaxStyle } from "@opentui/core"
import { emberTide } from "../theme"
import { MarkdownMessage, type MarkdownConversationItem } from "./MarkdownMessage"

export function ReasoningBlock(props: { item: MarkdownConversationItem; folded: boolean; syntax: SyntaxStyle }) {
  return props.folded
    ? <box height={1} flexDirection="row" gap={1} backgroundColor={emberTide.backgroundRaised} paddingX={1}>
        <text fg={emberTide.textMuted}>◇</text><text fg={emberTide.textSoft}>Reasoning</text><text fg={emberTide.textMuted}>[closed]</text>
      </box>
    : <MarkdownMessage item={props.item} syntax={props.syntax} />
}
