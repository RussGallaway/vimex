import type { AvailableModel } from "./model-catalog"
import type { DisplayPreferences } from "./display-preferences"
import { createConversation, type AgentRelationship, type ConversationEvent, type ConversationState, type ItemId, type ThreadId, type ThreadSummary, type TurnId } from "@vimex/conversation"
import { initialTranscript, type UrlCandidate, type TranscriptCommand, type TranscriptRevealRequest, type TranscriptState, type ViewportAnchor } from "@vimex/transcript"
import { initialComposer, type ComposerState, type SubmissionIntent } from "@vimex/composer"
import { initialInteraction, type InteractionCommand, type InteractionState } from "@vimex/interaction"
import { initialApprovals, type Approval, type ApprovalsState, type UserQuestionRequest } from "@vimex/approvals"
export interface ThreadWorkspace {
  conversation: ConversationState
  /** Changes when the canonical lineage is rebuilt for the same thread id. */
  canonicalGeneration: number
  /** Monotonic canonical conversation revision for presentation guards. */
  canonicalRevision: number
  transcript: TranscriptState
  composer: ComposerState
  interaction: InteractionState
}
export interface PendingFork { threadId: ThreadId; itemId: ItemId; turnId: TurnId; preview: string }
export interface WorkbenchState {
  compactingThreads: Readonly<Record<string, import("./compaction").CompactionStatus>>
  sideChats: Readonly<Record<string, import("./side-chat").SideChat>>
  retiredSideThreadIds: readonly ThreadId[]
  interruptingTurns: Readonly<Record<string, TurnId>>
  availableModels?: readonly AvailableModel[]
  modelCatalogError?: string
  preferences?: DisplayPreferences
  pendingFork?: PendingFork
  urlChoices?: readonly UrlCandidate[]
  urlChoiceOwner?: Readonly<{ threadId: ThreadId; presentationId: import("./workbench-actions").TranscriptPresentationId;
    displayedCanonicalRevision: number; scope: "selection" | "current-item" }>
  activeThreadId?: ThreadId
  favoriteThreadIds: readonly ThreadId[]
  threadOrder: readonly ThreadId[]
  summaries: Readonly<Record<string, ThreadSummary>>
  workspaces: Readonly<Record<string, ThreadWorkspace>>
  approvals: ApprovalsState
  questions: Readonly<Record<string, UserQuestionRequest>>
  agentRelationships: readonly AgentRelationship[]
  connection: "connecting" | "connected" | "disconnected" | "error"
  error?: string
}

export type WorkbenchEffect =
  | { type: "conversation.turn.start"; threadId: ThreadId; text: string; clientMessageId: string }
  | { type: "conversation.turn.steer"; threadId: ThreadId; text: string; clientMessageId: string }
  | { type: "approval.resolve"; approvalId: string; choiceId: string }
  | { type: "conversation.thread.fork"; threadId: ThreadId; throughTurnId: TurnId }
  | { type: "clipboard.write"; text: string }
  | { type: "url.open"; url: string }
  | { type: "viewport.restore"; threadId: ThreadId; anchor: ViewportAnchor }

export interface WorkbenchTransition { state: WorkbenchState; effects: readonly WorkbenchEffect[] }

type TranscriptNavigationCommand = Extract<TranscriptCommand, {
  type: "search.set" | "search.jump" | "jump.to" | "mark.jump" | "cursor.reveal"
}>

export type WorkbenchCommand =
  | { type: "compaction.observed"; observation: import("./compaction").CompactionObservation }
  | { type: "turn.interrupt.requested"; threadId: ThreadId; turnId: TurnId }
  | { type: "turn.interrupt.failed"; threadId: ThreadId; turnId: TurnId }
  | { type: "connection.changed"; connection: WorkbenchState["connection"]; error?: string }
  | { type: "thread.open"; summary: ThreadSummary }
  | { type: "thread.register"; summary: ThreadSummary }
  | { type: "thread.switch"; threadId: ThreadId }
  | { type: "thread.favorite.toggle"; threadId: ThreadId }
  | { type: "thread.close"; threadId: ThreadId }
  | { type: "thread.fork.request"; threadId: ThreadId; throughTurnId: TurnId }
  | { type: "thread.fork.completed"; sourceThreadId: ThreadId; throughTurnId: TurnId; summary: ThreadSummary }
  | { type: "thread.summary.patch"; threadId: ThreadId; patch: Partial<Omit<ThreadSummary, "id">> }
  | { type: "conversation.event"; event: ConversationEvent }
  | { type: "interaction.command"; threadId?: ThreadId; command: InteractionCommand }
  | { type: "transcript.command"; threadId?: ThreadId; command: TranscriptCommand }
  | { type: "transcript.navigate"; threadId?: ThreadId; command: TranscriptNavigationCommand; focusMode?: "normal" | "visual"; revealReason?: TranscriptRevealRequest["reason"] }
  | { type: "transcript.yank"; threadId: ThreadId; text: string; shape: "character" | "line" }
  | { type: "url.picker"; threadId: ThreadId; choices?: readonly UrlCandidate[]; owner?: WorkbenchState["urlChoiceOwner"]; url?: string }
  | { type: "composer.change"; threadId?: ThreadId; text: string; cursorOffset?: number }
  | { type: "composer.submit"; threadId?: ThreadId; intent: SubmissionIntent; clientMessageId: string }
  | { type: "composer.ack"; threadId: ThreadId; clientMessageId: string; turnId?: TurnId }
  | { type: "composer.fail"; threadId: ThreadId; clientMessageId: string; reason: string }
  | { type: "composer.retry"; threadId?: ThreadId; clientMessageId: string }
  | { type: "approval.received"; approval: Approval }
  | { type: "approval.resolve"; approvalId: string; choiceId: string }
  | { type: "approval.resolved"; approvalId: string }
  | { type: "approval.failed"; approvalId: string; error: string }
  | { type: "question.received"; request: UserQuestionRequest }
  | { type: "question.resolved"; id: string }
  | { type: "agent.link"; link: AgentRelationship }

export const initialWorkbench = (): WorkbenchState => ({
  compactingThreads: {}, sideChats: {}, retiredSideThreadIds: [], interruptingTurns: {}, favoriteThreadIds: [], threadOrder: [], summaries: {}, workspaces: {}, approvals: initialApprovals(), questions: {}, agentRelationships: [], connection: "connecting",
})
export function createWorkspace(id: ThreadId, canonicalGeneration = 0): ThreadWorkspace {
  return { conversation: createConversation(id), canonicalGeneration, canonicalRevision: 0, transcript: initialTranscript(), composer: initialComposer(), interaction: initialInteraction() }
}
export function openThread(state: WorkbenchState, summary: ThreadSummary): WorkbenchState {
  return {
    ...state,
    activeThreadId: summary.id,
    threadOrder: state.summaries[summary.id] ? state.threadOrder : [summary.id, ...state.threadOrder],
    summaries: { ...state.summaries, [summary.id]: summary },
    workspaces: { ...state.workspaces, [summary.id]: state.workspaces[summary.id] ?? createWorkspace(summary.id) },
  }
}
export function updateWorkspace(state: WorkbenchState, id: ThreadId, update: (workspace: ThreadWorkspace) => ThreadWorkspace): WorkbenchState {
  const workspace = state.workspaces[id]
  if (!workspace) return state
  const next = update(workspace)
  return next === workspace ? state : { ...state, workspaces: { ...state.workspaces, [id]: next } }
}
export function activeWorkspace(state: WorkbenchState): ThreadWorkspace | undefined {
  return state.activeThreadId ? state.workspaces[state.activeThreadId] : undefined
}
export function targetThread(state: WorkbenchState, requested?: ThreadId): ThreadId | undefined { return requested ?? state.activeThreadId }
export function done(state: WorkbenchState, ...effects: WorkbenchEffect[]): WorkbenchTransition { return { state, effects } }
