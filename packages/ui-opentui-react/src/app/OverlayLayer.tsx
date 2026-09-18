import type { Approval } from "@vimex/approvals"
import type { ThreadId, ThreadSummary } from "@vimex/conversation"
import type { Overlay } from "@vimex/interaction"
import { ApprovalOverlay } from "../approvals/ApprovalOverlay"
import { SessionsOverlay } from "../sessions/SessionsOverlay"
import { emberTide } from "../theme"
import { OverlayFrame } from "./OverlayFrame"

function HelpOverlay() {
  const groups = [
    ["Modes", "i insert   v visual   : command   esc normal"], ["Move", "h/j/k/l cursor   0/$ line   gg/G transcript"],
    ["Scroll", "ctrl-y/e line   ctrl-u/d half page"], ["Act", "y copy   gx open URL   f fork   ctrl-c interrupt"],
    ["Fold", "za toggle   zo open   zc close   zR/zM all"], ["Views", "s sessions   a approvals   ? help"],
    ["Focus", "ctrl-w k transcript   ctrl-w j composer   counts supported"],
    ["Composer", "h/j/k/l  w/b  0/$  x/dd  u/ctrl-r  i/a/I/A  v select"],
    ["Send", "alt-enter send   ctrl-enter steer   shift-enter newline"],
  ] as const
  return <OverlayFrame title="Vimex keys" width={82}>
    {groups.map(([title, detail]) => <box key={title} flexDirection="row" marginBottom={1}>
      <text width={12} flexShrink={0} fg={emberTide.amber}><b>{title}</b></text><text fg={emberTide.textSoft}>{detail}</text>
    </box>)}
    <text fg={emberTide.textMuted}>Press esc or ? to close</text>
  </OverlayFrame>
}

export function OverlayLayer(props: { overlay: Overlay; threads: readonly ThreadId[]; summaries: Readonly<Record<string, ThreadSummary>>; activeThreadId?: ThreadId; approval?: Approval; selected: number }) {
  if (!props.overlay) return null
  return <box position="absolute" top={0} left={0} right={0} bottom={0} zIndex={40} backgroundColor="#0d0f12d8">
    {props.overlay === "sessions" ? <SessionsOverlay threads={props.threads} summaries={props.summaries} active={props.activeThreadId} selected={props.selected} />
      : props.overlay === "approvals" ? <ApprovalOverlay approval={props.approval} selected={props.selected} />
      : props.overlay === "help" ? <HelpOverlay />
      : <OverlayFrame title={props.overlay} width={72}><text fg={emberTide.textMuted}>This view is not available yet.</text></OverlayFrame>}
  </box>
}
