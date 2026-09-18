import type { WorkbenchState } from "@vimex/workbench"
import { OverlayFrame } from "../app/OverlayFrame"
import { emberTide } from "../theme"

export function ForkOverlay(props: { pending?: WorkbenchState["pendingFork"] }) {
  return <OverlayFrame title="Fork session" width={84}>
    {props.pending ? <>
      <text fg={emberTide.amber}><b>Create a new session through the completed turn beginning with this message?</b></text>
      <box marginTop={1} paddingX={1} paddingY={1} backgroundColor={emberTide.backgroundPanel}>
        <text fg={emberTide.textSoft} wrapMode="word">{props.pending.preview}</text>
      </box>
      <text marginTop={1} fg={emberTide.textMuted}>enter confirm · esc cancel</text>
    </> : <text fg={emberTide.textMuted}>No fork is pending</text>}
  </OverlayFrame>
}
