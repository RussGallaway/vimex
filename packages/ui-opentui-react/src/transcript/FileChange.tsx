import { usePaneGeometry } from "../side-chat/pane-geometry"
import type { SyntaxStyle } from "@opentui/core"
import type { ConversationItem } from "@vimex/conversation"
import { emberTide } from "../theme"
import { itemStatusGlyph } from "./item-status"
import { diffFiletype, diffSummary } from "./diff-summary"

export function FileChange(props: { item: Extract<ConversationItem, { kind: "edit" }>; folded: boolean; syntax: SyntaxStyle }) {
  const { width } = usePaneGeometry()
  const { item } = props
  // A later patch delta may outpace metadata. Always display the exact current patch.
  const changes = item.changes?.map(change => change.patch).filter(Boolean).join("\n") === item.patch
    ? item.changes! : [{ path: item.title, patch: item.patch, action: undefined, movePath: undefined }]
  const summary = diffSummary(item.patch)
  return <box backgroundColor={emberTide.backgroundRaised} paddingX={1} paddingY={1}>
    <box id={`decoration:edit-header:${item.id}`} height={1} flexDirection="row" gap={1}>
      <text flexShrink={0} fg={emberTide.textMuted}>{props.folded ? "▸" : "▾"}</text>
      <text flexShrink={0} fg={item.status === "error" ? emberTide.red : emberTide.blueBright}>{itemStatusGlyph[item.status]}</text>
      <text fg={emberTide.text} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate>{changes.length > 1 ? `${changes.length} files changed` : item.title}</text>
      {summary ? <text flexShrink={0} fg={emberTide.textMuted}>{`+${summary.added} −${summary.removed}`}</text> : null}
    </box>
    {!props.folded ? changes.map((change, index) => {
      const counts = diffSummary(change.patch)
      return <box key={`${index}:${change.path}`}>
        {item.changes ? <box id={`decoration:edit-file:${item.id}:${index}`} flexDirection="row" gap={1}>
          <text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate fg={emberTide.text}>{change.movePath ? `${change.path} → ${change.movePath}` : change.path}</text>
          <text flexShrink={0} fg={emberTide.textMuted}>{[change.movePath ? "rename" : change.action, counts ? `+${counts.added} −${counts.removed}` : ""].filter(Boolean).join(" · ")}</text>
        </box> : null}
        {change.patch ? <diff id={index === 0 ? `diff:${item.id}` : `diff:${item.id}:${index}`} diff={change.patch} view={width >= 120 ? "split" : "unified"} filetype={diffFiletype(change.movePath ?? change.path)} syntaxStyle={props.syntax}
          showLineNumbers wrapMode="word" width="100%" fg={emberTide.textSoft} addedBg={emberTide.diffAdded}
          removedBg={emberTide.diffRemoved} contextBg={emberTide.diffContext} addedSignColor={emberTide.diffAddedBright}
          removedSignColor={emberTide.diffRemovedBright} lineNumberFg={emberTide.textMuted} lineNumberBg={emberTide.diffContext}
          addedLineNumberBg={emberTide.diffAdded} removedLineNumberBg={emberTide.diffRemoved} /> : <text id={`decoration:edit-empty:${item.id}:${index}`} fg={emberTide.textMuted}>No textual diff available.</text>}
      </box>
    }) : null}
  </box>
}
