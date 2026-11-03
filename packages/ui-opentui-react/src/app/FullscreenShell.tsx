import type { ReactNode } from "react"
import type { WorkbenchState } from "@vimex/workbench"
import { machineIcon } from "../machines/machine-icon"
import { emberTide } from "../theme"

export function FullscreenShell(props: {
  threadRole?: "PARENT" | "CHILD" | "SIDE"
  title?: string
  parentTitle?: string
  connection: WorkbenchState["connection"]
  machine?: WorkbenchState["machine"]
  destination?: WorkbenchState["machine"]
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
  const connection = props.destination ? "connecting" : props.connection
  const machine = props.destination ?? props.machine
  const label = machine
    ? `${machineIcon(machine.id)} ${machine.label ?? machine.id}`
    : undefined
  const status = props.destination
    ? `connecting to ${label}…`
    : `${connection}${label && connection !== "connected" ? ` · ${label}` : ""}`
  const dot =
    connection === "connected"
      ? emberTide.sage
      : connection === "connecting"
        ? emberTide.amber
        : emberTide.red
  return (
    <box
      id="vimex-app"
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={emberTide.background}
    >
      <box
        height={2}
        flexShrink={0}
        flexDirection="row"
        alignItems="center"
        gap={2}
        paddingX={2}
      >
        <box
          flexDirection="row"
          gap={1}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          overflow="hidden"
        >
          <text flexShrink={0} fg={emberTide.amber}>
            <b>VIMEX</b>
          </text>
          <text flexShrink={0} fg={emberTide.textMuted}>
            /
          </text>
          {props.threadRole ? (
            <text
              id="agent-context-badge"
              flexShrink={0}
              fg={emberTide.textInverse ?? emberTide.background}
              bg={emberTide.blueBright}
            >
              <b> {props.threadRole} </b>
            </text>
          ) : null}
          <text
            id="thread-title"
            minWidth={0}
            flexGrow={1}
            flexShrink={1}
            wrapMode="none"
            truncate
            fg={emberTide.text}
          >
            {props.title ?? "new session"}
          </text>
        </box>
        <box
          id="connection-status"
          flexDirection="row"
          gap={1}
          flexShrink={0}
          maxWidth="65%"
          minWidth={0}
        >
          <text fg={dot} minWidth={0} flexShrink={1} wrapMode="none" truncate>
            ● {status}
          </text>
        </box>
      </box>
      {props.parentTitle ? (
        <box
          id="agent-parent-context"
          height={1}
          flexShrink={0}
          paddingX={2}
          flexDirection="row"
          gap={1}
        >
          <text flexShrink={0} fg={emberTide.textMuted}>
            Parent:
          </text>
          <text
            minWidth={0}
            flexGrow={1}
            wrapMode="none"
            truncate
            fg={emberTide.textSoft}
          >
            {props.parentTitle}
          </text>
          <text flexShrink={0} fg={emberTide.blueBright}>
            {props.threadRole === "SIDE"
              ? "\\ Focus parent"
              : "\\ Back to parent"}
          </text>
        </box>
      ) : null}
      {props.transcript}
      {props.notice}
      {props.composer}
      <box id="composer-status-gap" height={1} flexShrink={0} />
      {props.commandLine ?? props.statusline}
      {props.overlay}
    </box>
  )
}
