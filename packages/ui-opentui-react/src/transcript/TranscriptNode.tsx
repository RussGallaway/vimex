import type { SyntaxStyle } from "@opentui/core"
import type { ConversationItem } from "@vimex/conversation"
import { FileChange } from "./FileChange"
import { MarkdownMessage } from "./MarkdownMessage"
import { ReasoningBlock } from "./ReasoningBlock"
import { ToolCall } from "./ToolCall"

export function TranscriptNode(props: { item: ConversationItem; folded: boolean; syntax: SyntaxStyle }) {
  switch (props.item.kind) {
    case "user": return <MarkdownMessage item={props.item} syntax={props.syntax} />
    case "assistant": return <MarkdownMessage item={props.item} syntax={props.syntax} />
    case "reasoning": return <ReasoningBlock item={props.item} folded={props.folded} syntax={props.syntax} />
    case "edit": return <FileChange item={props.item} folded={props.folded} syntax={props.syntax} />
    case "command": case "tool": case "unknown": return <ToolCall item={props.item} folded={props.folded} />
  }
}
