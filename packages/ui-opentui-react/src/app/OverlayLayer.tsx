import type { Approval } from "@vimex/approvals"
import type { UserQuestionRequest } from "@vimex/approvals"
import type { InputRenderable } from "@opentui/core"
import type { ThreadId, ThreadSummary } from "@vimex/conversation"
import type { Overlay } from "@vimex/interaction"
import type { WorkbenchState } from "@vimex/workbench"
import type { UrlCandidate } from "@vimex/transcript"
import type { RefObject } from "react"
import { AgentsOverlay, type AgentNavigationRow } from "../agents/AgentsOverlay"
import { ApprovalOverlay } from "../approvals/ApprovalOverlay"
import { ForkOverlay } from "../fork/ForkOverlay"
import { QuestionOverlay } from "../questions/QuestionOverlay"
import { SessionsOverlay } from "../sessions/SessionsOverlay"
import type { SessionRow } from "../sessions/session-search"
import { emberTide } from "../theme"
import { UrlsOverlay } from "../urls/UrlsOverlay"
import { OverlayFrame } from "./OverlayFrame"

function HelpOverlay() {
  const groups = [
    ["Modes", "i insert   v visual   : command   esc normal"], ["Move", "h/j/k/l cursor   0/$ line   gg/G transcript"],
    ["Scroll", "ctrl-y/e line   ctrl-u/d half page   ctrl-b/f page"], ["Act", "y copy   gx open URL   f fork   ctrl-c interrupt"],
    ["Fold", "za toggle   zo open   zc close   zR/zM all"], ["Views", "s sessions   a approvals   :help"],
    ["Focus", "ctrl-w k transcript   ctrl-w j composer   counts supported"],
    ["Composer", "h/j/k/l  w/b  0/$  x/dd  u/ctrl-r  i/a/I/A  v select"],
    ["Send", "enter send   ctrl-enter steer   shift-enter newline"],
  ] as const
  return <OverlayFrame title="Vimex keys" width={82}>
    {groups.map(([title, detail]) => <box key={title} flexDirection="row" marginBottom={1}>
      <text width={12} flexShrink={0} fg={emberTide.amber}><b>{title}</b></text><text fg={emberTide.textSoft}>{detail}</text>
    </box>)}
    <text fg={emberTide.textMuted}>Press esc to close</text>
  </OverlayFrame>
}

export function OverlayLayer(props: {
  overlay: Overlay
  sessions: readonly SessionRow[]
  sessionQuery: string
  sessionSearchRef: RefObject<InputRenderable | null>
  onSessionQuery(value: string): void
  summaries: Readonly<Record<string, ThreadSummary>>
  activeThreadId?: ThreadId
  approval?: Approval
  question?: UserQuestionRequest
  questionIndex: number
  answers: Readonly<Record<string, string | readonly string[]>>
  questionInputRef: RefObject<InputRenderable | null>
  onQuestionInput(value: string): void
  onActivate(): void
  pendingFork?: WorkbenchState["pendingFork"]
  agents: readonly AgentNavigationRow[]
  urls: readonly UrlCandidate[]
  selected: number
}) {
  if (!props.overlay) return null
  return <box position="absolute" top={0} left={0} right={0} bottom={0} zIndex={40} backgroundColor="#0d0f12d8">
    {props.overlay === "sessions" ? <SessionsOverlay rows={props.sessions} query={props.sessionQuery} searchRef={props.sessionSearchRef} onQuery={props.onSessionQuery} onSubmit={props.onActivate} active={props.activeThreadId} selected={props.selected} />
      : props.overlay === "approvals" ? <ApprovalOverlay approval={props.approval} selected={props.selected} />
      : props.overlay === "questions" ? <QuestionOverlay request={props.question} questionIndex={props.questionIndex} optionIndex={props.selected}
          answers={props.answers} inputRef={props.questionInputRef} onInput={props.onQuestionInput} onSubmit={props.onActivate} />
      : props.overlay === "fork" ? <ForkOverlay pending={props.pendingFork} />
      : props.overlay === "agents" ? <AgentsOverlay rows={props.agents} summaries={props.summaries} selected={props.selected} />
      : props.overlay === "urls" ? <UrlsOverlay choices={props.urls} selected={props.selected} />
      : props.overlay === "help" ? <HelpOverlay />
      : <OverlayFrame title={props.overlay} width={72}><text fg={emberTide.textMuted}>This view is not available yet.</text></OverlayFrame>}
  </box>
}
