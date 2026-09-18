import type { ReactNode } from "react"
import type { WorkbenchState } from "@vimex/workbench"
import { emberTide } from "../theme"

export function FullscreenShell(props: {
  title?: string
  connection: WorkbenchState["connection"]
  working: boolean
  transcript: ReactNode
  commandLine?: ReactNode
  composer: ReactNode
  statusline: ReactNode
  overlay?: ReactNode
}) {
  const dot = props.connection === "connected" ? emberTide.sage : props.connection === "connecting" ? emberTide.amber : emberTide.red
  return <box id="vimex-app" width="100%" height="100%" flexDirection="column" backgroundColor={emberTide.background}>
    <box height={2} flexShrink={0} flexDirection="row" alignItems="center" justifyContent="space-between" paddingX={2}>
      <box flexDirection="row" gap={1}><text fg={emberTide.amber}><b>VIMEX</b></text><text fg={emberTide.textMuted}>/</text><text fg={emberTide.text}>{props.title ?? "new session"}</text></box>
      <box flexDirection="row" gap={1}>{props.working ? <text fg={emberTide.blueBright}>◌ working</text> : null}<text fg={dot}>●</text></box>
    </box>
    {props.transcript}{props.commandLine}{props.composer}{props.statusline}{props.overlay}
  </box>
}
