import type { ThreadGoal, GoalUpdate } from "../domain/thread-goal"
import type { ConversationEvent } from "../domain/events"
import type { ItemId, ThreadId, TurnId } from "../domain/identifiers"
import type { ThreadSummary } from "../domain/thread"

export interface SessionSnapshot {
  summary: ThreadSummary
  events: readonly ConversationEvent[]
}
export interface ThreadSettingChange {
  model?: string
  effort?: string
  cwd?: string
  permissions?: string
  approvalPolicy?: "on-request" | "never"
  approvalsReviewer?: "user" | "auto_review"
}
export interface AgentRelationship {
  parentId: ThreadId
  childId: ThreadId
  itemId: ItemId
  relation: "spawned" | "activity" | "target"
  agentPath?: string
}
export type ConversationInput =
  | { type: "text"; text: string }
  | { type: "image"; path: string }
  | { type: "mention"; name: string; path: string }
  | { type: "skill"; name: string; path: string }

export type MentionKind = "file" | "skill" | "plugin"
export type MentionSearchKind = MentionKind | "grep"
export interface MentionCandidate {
  kind: MentionKind
  name: string
  path: string
  detail?: string
  /** Bounded text preview for picker surfaces; omitted for non-file entries. */
  preview?: string
}

export interface BackgroundTerminal {
  threadId: ThreadId
  itemId: ItemId
  processId: string
  command: string
  cwd: string
  osPid: number | null
  cpuPercent: number | null
  rssKb: number | null
}

/** Conversation capabilities required by client use cases, independent of transport. */
export interface ConversationGateway {
  searchMentions?(
    query: string,
    kind: MentionSearchKind,
    cwd: string,
  ): Promise<readonly MentionCandidate[]>
  listBackgroundTerminals?(id: ThreadId): Promise<readonly BackgroundTerminal[]>
  terminateBackgroundTerminal?(
    id: ThreadId,
    processId: string,
  ): Promise<boolean>
  compactThread?(id: ThreadId): Promise<void>
  shellCommand?(id: ThreadId, command: string): Promise<void>
  getGoal?(id: ThreadId): Promise<ThreadGoal | null>
  setGoal?(id: ThreadId, update: GoalUpdate): Promise<ThreadGoal>
  clearGoal?(id: ThreadId): Promise<boolean>
  forkSideThread?(id: ThreadId): Promise<SessionSnapshot>
  retireThread?(id: ThreadId): Promise<void>
  listThreads(): Promise<readonly ThreadSummary[]>
  startThread(cwd: string, model?: string): Promise<SessionSnapshot>
  resumeThread(id: ThreadId): Promise<SessionSnapshot>
  forkThread(id: ThreadId, through: TurnId): Promise<SessionSnapshot>
  startTurn(
    id: ThreadId,
    text: string,
    clientMessageId: string,
    input?: readonly ConversationInput[],
    onRequestSent?: () => void,
  ): Promise<readonly ConversationEvent[]>
  steerTurn(
    id: ThreadId,
    turn: TurnId,
    text: string,
    clientMessageId: string,
    input?: readonly ConversationInput[],
    onRequestSent?: () => void,
  ): Promise<void>
  interruptTurn(id: ThreadId, turn: TurnId): Promise<void>
  renameThread(id: ThreadId, name: string): Promise<void>
  updateSettings(id: ThreadId, settings: ThreadSettingChange): Promise<void>
}
