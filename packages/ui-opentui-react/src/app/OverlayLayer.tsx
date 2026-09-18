import type { Approval } from "@vimex/approvals"
import type { UserQuestionRequest } from "@vimex/approvals"
import { useBindings } from "@opentui/keymap/react"
import { useTerminalDimensions } from "@opentui/react"
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import type { ThreadId, ThreadSummary } from "@vimex/conversation"
import type { Overlay } from "@vimex/interaction"
import type { AvailableModel, WorkbenchState } from "@vimex/workbench"
import type { UrlCandidate } from "@vimex/transcript"
import { useRef, type RefObject } from "react"
import { AgentsOverlay, type AgentNavigationRow } from "../agents/AgentsOverlay"
import { ApprovalOverlay } from "../approvals/ApprovalOverlay"
import { ForkOverlay } from "../fork/ForkOverlay"
import { QuestionOverlay } from "../questions/QuestionOverlay"
import { ModelsOverlay } from "../models/ModelsOverlay"
import { SessionsOverlay } from "../sessions/SessionsOverlay"
import type { SessionRow } from "../sessions/session-search"
import { emberTide } from "../theme"
import { UrlsOverlay } from "../urls/UrlsOverlay"
import { OverlayFrame } from "./OverlayFrame"

function HelpOverlay() {
  const dimensions = useTerminalDimensions()
  const helpRef = useRef<ScrollBoxRenderable>(null)
  useBindings(() => ({ priority: 250, bindings: [
    ...["j", "down", "ctrl+e"].map(key => ({ key, cmd: () => helpRef.current?.scrollBy(1, "step") })),
    ...["k", "up", "ctrl+y"].map(key => ({ key, cmd: () => helpRef.current?.scrollBy(-1, "step") })),
    { key: "ctrl+d", cmd: () => helpRef.current?.scrollBy(0.5, "viewport") },
    { key: "ctrl+u", cmd: () => helpRef.current?.scrollBy(-0.5, "viewport") },
    { key: "g", cmd: () => helpRef.current?.scrollTo(0) },
    { key: "shift+g", cmd: () => helpRef.current?.scrollTo(helpRef.current.scrollHeight) },
  ] }), [])
  const groups = [
    ["Modes", "i insert   v visual   : command   esc normal"], ["Move", "h/j/k/l cursor   0/$ line   gg/G transcript"],
    ["Scroll", "ctrl-y/e line   ctrl-u/d half page   ctrl-b/f page"], ["Act", "y copy   gx open URL   f fork   ctrl-c interrupt"],
    ["Fold", "za toggle   zo open   zc close   zR/zM all"], ["Views", "s sessions   a approvals   :help"],
    ["Focus", "ctrl-k transcript   ctrl-j composer   ctrl-w k/j aliases"],
    ["Composer", "h/j/k/l  w/b  0/$  x/dd  u/ctrl-r  i/a/I/A  v select"],
    ["Menus", "j/k choose   i search   esc normal/close"],
    ["Send", "enter send   ctrl-enter steer   shift-enter newline"],
  ] as const
  return <OverlayFrame title="Vimex keys" width={82}>
    <scrollbox id="help-scroll" ref={helpRef} height={Math.min(19, Math.max(1, Math.floor(dimensions.height * 0.85) - 5))}>
    {groups.map(([title, detail]) => <box key={title} flexDirection="row" marginBottom={1}>
      <text width={12} flexShrink={0} fg={emberTide.amber}><b>{title}</b></text><text fg={emberTide.textSoft}>{detail}</text>
    </box>)}
    </scrollbox>
    <text height={1} fg={emberTide.textMuted} wrapMode="none" truncate>j/k scroll · esc close</text>
  </OverlayFrame>
}

export function OverlayLayer(props: {
  overlay: Overlay
  models?: readonly AvailableModel[]
  modelCatalogError?: string
  modelPicker: { stage: "models" } | { stage: "efforts"; modelId: string }
  sessions: readonly SessionRow[]
  sessionQuery: string
  sessionSearchEditing?: boolean
  onSessionSearchEditing?(editing: boolean): void
  onSessionMove?(delta: number): void
  sessionSearchRef: RefObject<InputRenderable | null>
  onSessionQuery(value: string): void
  onSessionRename(id: ThreadId, title: string): void
  onSessionFavorite(id: ThreadId): void
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
  return <box position="absolute" top={0} left={0} right={0} bottom={0} alignItems="center" justifyContent="center" zIndex={40} backgroundColor="#0d0f12d8">
    {props.overlay === "sessions" ? <SessionsOverlay searchEditing={props.sessionSearchEditing} onSearchEditing={props.onSessionSearchEditing} onMove={props.onSessionMove} onRename={props.onSessionRename} onFavorite={props.onSessionFavorite} rows={props.sessions} query={props.sessionQuery} searchRef={props.sessionSearchRef} onQuery={props.onSessionQuery} onSubmit={props.onActivate} active={props.activeThreadId} selected={props.selected} />
      : props.overlay === "approvals" ? <ApprovalOverlay approval={props.approval} selected={props.selected} />
      : props.overlay === "questions" ? <QuestionOverlay request={props.question} questionIndex={props.questionIndex} optionIndex={props.selected}
          answers={props.answers} inputRef={props.questionInputRef} onInput={props.onQuestionInput} onSubmit={props.onActivate} />
      : props.overlay === "fork" ? <ForkOverlay pending={props.pendingFork} />
      : props.overlay === "agents" ? <AgentsOverlay rows={props.agents} summaries={props.summaries} selected={props.selected} />
      : props.overlay === "urls" ? <UrlsOverlay choices={props.urls} selected={props.selected} />
      : props.overlay === "models" ? <ModelsOverlay models={props.models} error={props.modelCatalogError} selected={props.selected} picker={props.modelPicker} />
      : props.overlay === "help" ? <HelpOverlay />
      : <OverlayFrame title={props.overlay} width={72}><text fg={emberTide.textMuted}>This view is not available yet.</text></OverlayFrame>}
  </box>
}
