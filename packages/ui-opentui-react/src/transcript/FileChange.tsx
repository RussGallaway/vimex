import { useTerminalDimensions } from "@opentui/react"
import type { SyntaxStyle } from "@opentui/core"
import type { ConversationItem } from "@vimex/conversation"
import { emberTide } from "../theme"
import { itemStatusGlyph } from "./item-status"

export function FileChange(props: { item: Extract<ConversationItem, { kind: "edit" }>; folded: boolean; syntax: SyntaxStyle }) {
  const { width } = useTerminalDimensions()
  const filetype = props.item.title.split(".").at(-1) ?? "text"
  return <box backgroundColor={emberTide.backgroundRaised} paddingX={1} paddingY={1}>
    <box height={1} flexDirection="row" gap={1}>
      <text fg={props.item.status === "error" ? emberTide.red : emberTide.blueBright}>{itemStatusGlyph[props.item.status]}</text>
      <text fg={emberTide.text}>{props.item.title}</text><text fg={emberTide.textMuted}>{props.folded ? "[closed]" : "[open]"}</text>
    </box>
    {!props.folded && props.item.patch ? <diff id={`diff:${props.item.id}`} diff={props.item.patch} view={width >= 120 ? "split" : "unified"} filetype={filetype} syntaxStyle={props.syntax}
      showLineNumbers wrapMode="word" width="100%" fg={emberTide.textSoft} addedBg={emberTide.diffAdded}
      removedBg={emberTide.diffRemoved} contextBg={emberTide.diffContext} addedSignColor={emberTide.diffAddedBright}
      removedSignColor={emberTide.diffRemovedBright} lineNumberFg={emberTide.textMuted} lineNumberBg={emberTide.diffContext}
      addedLineNumberBg={emberTide.diffAdded} removedLineNumberBg={emberTide.diffRemoved} /> : null}
  </box>
}
