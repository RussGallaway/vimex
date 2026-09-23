import { usePaneGeometry } from "../side-chat/pane-geometry"
import type { SyntaxStyle } from "@opentui/core"
import type { ConversationItem } from "@vimex/conversation"
import type { TranscriptItemFragment } from "@vimex/transcript"
import { emberTide } from "../theme"
import { itemStatusGlyph } from "./item-status"
import { diffFiletype, diffSummary } from "./diff-summary"

export function FileChange(props: {
  item: Extract<ConversationItem, { kind: "edit" }>
  sourceItem?: Extract<ConversationItem, { kind: "edit" }>
  folded: boolean
  syntax: SyntaxStyle
  blockId?: string
  fragment?: TranscriptItemFragment
}) {
  const { width } = usePaneGeometry()
  const { item } = props
  const sourceItem = props.sourceItem ?? item
  const suffix =
    props.blockId && props.blockId !== "root" ? `:${props.blockId}` : ""
  const fragmented =
    props.fragment?.kind === "edit-header" ||
    props.fragment?.kind === "edit-file"
  const firstFragment = !props.fragment || props.fragment.index === 0
  const finalFragment =
    !props.fragment || props.fragment.index === props.fragment.count - 1
  // A later patch delta may outpace metadata. Always display the exact current patch.
  const changes =
    fragmented && item.changes
      ? item.changes
      : item.changes
            ?.map((change) => change.patch)
            .filter(Boolean)
            .join("\n") === item.patch
        ? item.changes!
        : [
            {
              path: item.title,
              patch: item.patch,
              action: undefined,
              movePath: undefined,
            },
          ]
  const summary = firstFragment ? diffSummary(sourceItem.patch) : undefined
  return (
    <box
      backgroundColor={emberTide.backgroundRaised}
      paddingX={1}
      paddingTop={props.folded || !firstFragment ? 0 : 1}
      paddingBottom={props.folded || !finalFragment ? 0 : 1}
    >
      {firstFragment ? (
        <box
          id={`decoration:edit-header:${item.id}${suffix}`}
          height={1}
          flexDirection="row"
          gap={1}
        >
          <text flexShrink={0} fg={emberTide.textMuted}>
            {props.folded ? "▸" : "▾"}
          </text>
          <text
            flexShrink={0}
            fg={item.status === "error" ? emberTide.red : emberTide.blueBright}
          >
            {itemStatusGlyph[item.status]}
          </text>
          <text
            fg={emberTide.text}
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            wrapMode="none"
            truncate
          >
            {sourceItem.changes && sourceItem.changes.length > 1
              ? `${sourceItem.changes.length} files changed`
              : sourceItem.title}
          </text>
          {summary ? (
            <text
              flexShrink={0}
              fg={emberTide.textMuted}
            >{`+${summary.added} −${summary.removed}`}</text>
          ) : null}
        </box>
      ) : null}
      {!props.folded
        ? changes.map((change, index) => {
            const counts = diffSummary(change.patch)
            return (
              <box key={`${index}:${change.path}`}>
                {item.changes ? (
                  <box
                    id={`decoration:edit-file:${item.id}${suffix}:${index}`}
                    flexDirection="row"
                    gap={1}
                  >
                    <text
                      flexGrow={1}
                      flexShrink={1}
                      minWidth={0}
                      wrapMode="none"
                      truncate
                      fg={emberTide.text}
                    >
                      {change.movePath
                        ? `${change.path} → ${change.movePath}`
                        : change.path}
                    </text>
                    <text flexShrink={0} fg={emberTide.textMuted}>
                      {[
                        change.movePath ? "rename" : change.action,
                        counts ? `+${counts.added} −${counts.removed}` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </text>
                  </box>
                ) : null}
                {change.patch ? (
                  <diff
                    id={
                      index === 0
                        ? `diff:${item.id}${suffix}`
                        : `diff:${item.id}${suffix}:${index}`
                    }
                    diff={change.patch}
                    view={width >= 120 ? "split" : "unified"}
                    filetype={diffFiletype(change.movePath ?? change.path)}
                    syntaxStyle={props.syntax}
                    showLineNumbers
                    wrapMode="word"
                    width="100%"
                    fg={emberTide.textSoft}
                    addedBg={emberTide.diffAdded}
                    removedBg={emberTide.diffRemoved}
                    contextBg={emberTide.diffContext}
                    addedSignColor={emberTide.diffAddedBright}
                    removedSignColor={emberTide.diffRemovedBright}
                    lineNumberFg={emberTide.textMuted}
                    lineNumberBg={emberTide.diffContext}
                    addedLineNumberBg={emberTide.diffAdded}
                    removedLineNumberBg={emberTide.diffRemoved}
                  />
                ) : (
                  <text
                    id={`decoration:edit-empty:${item.id}${suffix}:${index}`}
                    fg={emberTide.textMuted}
                  >
                    No textual diff available.
                  </text>
                )}
              </box>
            )
          })
        : null}
    </box>
  )
}
