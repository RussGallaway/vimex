import type { ReactNode } from "react"
import type { WorkbenchState } from "@vimex/workbench"
import { emberTide } from "../theme"
import { ActivityIndicator } from "../activity/ActivityIndicator"

export function FullscreenShell(props: {
  paneLabel?: "MAIN" | "SIDE"
  title?: string
  parentTitle?: string
  connection: WorkbenchState["connection"]
  working: boolean
  activityLabel?: string
  activityStartedAt?: number
  waiting?: boolean
  presentationVisible?: boolean
  transcript: ReactNode
  commandLine?: ReactNode
  notice?: ReactNode
  composer: ReactNode
  statusline: ReactNode
  overlay?: ReactNode
}) {
  const dot = props.connection === "connected" ? emberTide.sage : props.connection === "connecting" ? emberTide.amber : emberTide.red
  return <box id="vimex-app" width="100%" height="100%" flexDirection="column" backgroundColor={emberTide.background}>
    <box height={2} flexShrink={0} flexDirection="row" alignItems="center" gap={2} paddingX={2}>
      <box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden"><text flexShrink={0} fg={emberTide.amber}><b>{props.paneLabel ?? "VIMEX"}</b></text><text flexShrink={0} fg={emberTide.textMuted}>/</text>{props.parentTitle ? <text id="agent-context-badge" flexShrink={0} fg={emberTide.background} bg={emberTide.blueBright}><b> SUBAGENT </b></text> : null}<text id="thread-title" minWidth={0} flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={emberTide.text}>{props.title ?? "new session"}</text></box>
      <box id="connection-status" flexDirection="row" gap={1} flexShrink={0}>{props.presentationVisible !== false && (props.working || props.waiting) ? <ActivityIndicator active={props.working && !props.waiting && props.connection === "connected"} label={props.activityLabel ?? "Working"} startedAt={props.activityStartedAt} tone={props.waiting ? "waiting" : "working"} /> : null}<text fg={dot}>● {props.connection}</text></box>
    </box>
    {props.parentTitle ? <box id="agent-parent-context" height={1} flexShrink={0} paddingX={2} flexDirection="row" gap={1}>
      <text flexShrink={0} fg={emberTide.textMuted}>Parent:</text>
      <text minWidth={0} flexGrow={1} wrapMode="none" truncate fg={emberTide.textSoft}>{props.parentTitle}</text>
      <text flexShrink={0} fg={emberTide.blueBright}>\ parent</text>
    </box> : null}
    {props.transcript}{props.notice}{props.composer}{props.commandLine ?? props.statusline}{props.overlay}
  </box>
}
