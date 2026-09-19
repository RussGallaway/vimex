import type { ConversationItem } from "@vimex/conversation"
import { emberTide } from "../theme"
import { itemStatusGlyph } from "./item-status"

export function ToolCall(props: { item: Extract<ConversationItem, { kind: "command" | "tool" | "unknown" }>; folded: boolean }) {
  const running = props.item.status === "running"
  const executionCommand = props.item.kind === "command" ? props.item.executionCommand : undefined
  return <box backgroundColor={emberTide.backgroundRaised} paddingX={1} paddingY={props.folded ? 0 : 1}>
    <box height={1} flexDirection="row" gap={1}>
      <text id={`decoration:fold:${props.item.id}`} flexShrink={0} fg={emberTide.textMuted}>{props.folded ? "▸" : "▾"}</text>
      <text id={`decoration:status:${props.item.id}`} flexShrink={0} fg={running ? emberTide.blueBright : props.item.status === "error" ? emberTide.red : emberTide.sage}>{running ? "⋯" : itemStatusGlyph[props.item.status]}</text>
      {running ? <text id={`decoration:phase:${props.item.id}`} flexShrink={0} fg={emberTide.textSoft}>{props.item.kind === "command" ? "Running" : "Calling"}</text> : null}
      <text fg={emberTide.text} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate>{props.item.title}</text>
      {props.item.durationMs !== undefined ? <text id={`decoration:duration:${props.item.id}`} flexShrink={0} fg={emberTide.textMuted}>{props.item.durationMs < 1000 ? `${props.item.durationMs}ms` : `${(props.item.durationMs / 1000).toFixed(1)}s`}</text> : null}
    </box>
    {!props.folded ? <>
      {executionCommand ? <box marginTop={1}>
        <text id={`decoration:command-label:${props.item.id}`} fg={emberTide.textMuted}>Command</text>
        <text id={`command-source:${props.item.id}`} fg={emberTide.text} wrapMode="word">{executionCommand}</text>
      </box> : null}
      {props.item.detail ? <box marginTop={1}>
        <text id={`decoration:output-label:${props.item.id}`} fg={emberTide.textMuted}>Output</text>
        <text id={`tool-output:${props.item.id}`} fg={emberTide.textMuted} wrapMode="word">{props.item.detail}</text>
      </box> : null}
    </> : null}
  </box>
}
