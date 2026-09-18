import type { ConversationEvent } from "../domain/events"
import type { ItemId, ThreadId, TurnId } from "../domain/identifiers"
import type { ThreadSummary } from "../domain/thread"

export interface SessionSnapshot { summary: ThreadSummary; events: readonly ConversationEvent[] }
export interface ThreadSettingChange { model?: string; effort?: string; cwd?: string }
export interface AgentRelationship { parentId: ThreadId; childId: ThreadId; itemId: ItemId; relation: "spawned" | "activity" | "target"; agentPath?: string }

/** Conversation capabilities required by client use cases, independent of transport. */
export interface ConversationGateway {
  listThreads(): Promise<readonly ThreadSummary[]>
  startThread(cwd: string, model?: string): Promise<SessionSnapshot>
  resumeThread(id: ThreadId): Promise<SessionSnapshot>
  forkThread(id: ThreadId, through: TurnId): Promise<SessionSnapshot>
  startTurn(id: ThreadId, text: string, clientMessageId: string): Promise<readonly ConversationEvent[]>
  steerTurn(id: ThreadId, turn: TurnId, text: string, clientMessageId: string): Promise<void>
  interruptTurn(id: ThreadId, turn: TurnId): Promise<void>
  renameThread(id: ThreadId, name: string): Promise<void>
  updateSettings(id: ThreadId, settings: ThreadSettingChange): Promise<void>
}
