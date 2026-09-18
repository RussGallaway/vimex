import type { SyntaxStyle } from "@opentui/core"
import type { ConversationItem } from "@vimex/conversation"
import { emberTide } from "../theme"

export type MarkdownConversationItem = Extract<ConversationItem, { markdown: string }>

export function MarkdownMessage(props: { item: MarkdownConversationItem; syntax: SyntaxStyle }) {
  return <markdown id={`markdown:${props.item.id}`} content={props.item.markdown} syntaxStyle={props.syntax}
    streaming={props.item.status === "running"} internalBlockMode="top-level" tableOptions={{ style: "grid" }} conceal
    fg={props.item.kind === "reasoning" ? emberTide.textMuted : emberTide.textSoft}
    bg={props.item.kind === "user" ? emberTide.backgroundPanel : emberTide.background} />
}
