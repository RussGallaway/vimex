import type { ConversationItem } from "@vimex/conversation"
import { emberTide } from "../theme"
import { itemStatusGlyph } from "./item-status"

export function ToolCall(props: { item: Extract<ConversationItem, { kind: "command" | "tool" | "unknown" }>; folded: boolean }) {
  return <box backgroundColor={emberTide.backgroundRaised} paddingX={1} paddingY={1}>
    <box height={1} flexDirection="row" gap={1}>
      <text fg={props.item.status === "error" ? emberTide.red : emberTide.sage}>{itemStatusGlyph[props.item.status]}</text>
      <text fg={emberTide.text}>{props.item.title}</text><text fg={emberTide.textMuted}>{props.folded ? "[closed]" : "[open]"}</text>
    </box>
    {!props.folded && props.item.detail ? <text fg={emberTide.textMuted}>{props.item.detail}</text> : null}
  </box>
}
