import { usePaneGeometry } from "../side-chat/pane-geometry"
import type { UrlCandidate } from "@vimex/transcript"
import { emberTide } from "../theme"
import { LinkActionButton } from "./LinkActionButton"

export type LinkAction = "open" | "copy-address" | "copy-text"
export function LinkActionsBar(props: {
  candidate: UrlCandidate
  onAction(action: LinkAction): void
  onClose(): void
}) {
  const compact = usePaneGeometry().width < 60
  return (
    <box
      id="link-actions-bar"
      height={1}
      flexShrink={0}
      flexDirection="row"
      gap={1}
      paddingX={1}
      backgroundColor={emberTide.backgroundPanel}
    >
      <text
        minWidth={0}
        flexGrow={1}
        wrapMode="none"
        truncate
        fg={emberTide.textMuted}
      >
        {props.candidate.url}
      </text>
      <LinkActionButton
        id="link-open"
        label="Open"
        onActivate={() => props.onAction("open")}
      />
      <LinkActionButton
        id="link-copy-address"
        label={compact ? "Copy" : "Copy link"}
        onActivate={() => props.onAction("copy-address")}
      />
      <LinkActionButton
        id="link-copy-text"
        label={compact ? "Text" : "Copy text"}
        onActivate={() => props.onAction("copy-text")}
      />
      <LinkActionButton
        id="link-dismiss"
        label="×"
        onActivate={props.onClose}
      />
    </box>
  )
}
