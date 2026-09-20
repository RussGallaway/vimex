import type { SyntaxStyle } from "@opentui/core"
import type { ConversationItem } from "@vimex/conversation"
import type { TranscriptItemFragment } from "@vimex/transcript"
import { FileChange } from "./FileChange"
import { MarkdownMessage } from "./MarkdownMessage"
import { ReasoningBlock } from "./ReasoningBlock"
import { ToolCall } from "./ToolCall"
import { AgentActivity } from "./AgentActivity"

export function TranscriptNode(props: { item: ConversationItem; sourceItem?: ConversationItem; folded: boolean; syntax: SyntaxStyle; blockId?: string; fragment?: TranscriptItemFragment }) {
  switch (props.item.kind) {
    case "user": return <MarkdownMessage item={props.item} syntax={props.syntax} blockId={props.blockId} />
    case "assistant": return <MarkdownMessage item={props.item} syntax={props.syntax} blockId={props.blockId} />
    case "reasoning": return <ReasoningBlock item={props.item} folded={props.folded} syntax={props.syntax} />
    case "edit": return <FileChange item={props.item}
      sourceItem={props.sourceItem?.kind === "edit" ? props.sourceItem : undefined}
      folded={props.folded} syntax={props.syntax} blockId={props.blockId} fragment={props.fragment} />
    case "agent": return <AgentActivity item={props.item} folded={props.folded} />
    case "command": case "tool": case "unknown": return <ToolCall item={props.item} folded={props.folded}
      blockId={props.blockId} fragment={props.fragment} />
    default: return unreachable(props.item)
  }
}

function unreachable(item: never): never { throw new Error(`Unsupported transcript item: ${String(item)}`) }
