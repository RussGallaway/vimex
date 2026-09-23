import type { ItemId, ThreadId, TurnId } from "./identifiers"
export type ItemStatus = "running" | "complete" | "error" | "interrupted"
export type ItemActivityFamily = "web-research" | "read" | "provider"
export interface ItemActivity {
  family: ItemActivityFamily
  /** Human-readable provider name supplied or normalized at the adapter boundary. */
  label?: string
}
export type AgentCoordinationAction =
  | "spawn"
  | "send-input"
  | "send-message"
  | "follow-up"
  | "resume"
  | "wait"
  | "interrupt"
  | "close"
  | "list"
export type AgentAction = AgentCoordinationAction | "activity"
export type AgentActivityKind =
  "started" | "interacted" | "interrupted" | "completed"
export type AgentStateStatus =
  | "pending"
  | "running"
  | "interrupted"
  | "complete"
  | "error"
  | "closed"
  | "missing"
export interface AgentState {
  threadId: ThreadId
  status: AgentStateStatus
  message?: string
}
type AgentItemBase = {
  id: ItemId
  turnId: TurnId
  kind: "agent"
  detail: string
  agentThreadIds: readonly ThreadId[]
  status: ItemStatus
  durationMs?: number
  /** Derived task progress for spawn rows; separate from the tool call's status. */
  childTasks?: readonly AgentState[]
}
export type AgentItem =
  | (AgentItemBase & {
      action: AgentCoordinationAction
      senderThreadId?: ThreadId
      agentStates?: readonly AgentState[]
      activity?: undefined
      agentPath?: undefined
    })
  | (AgentItemBase & {
      action: "activity"
      activity: AgentActivityKind
      agentPath: string
      senderThreadId?: undefined
      agentStates?: undefined
    })
export type ConversationItem = { durationMs?: number } & (
  | {
      id: ItemId
      turnId: TurnId
      kind: "user" | "assistant" | "reasoning"
      markdown: string
      status: ItemStatus
    }
  | {
      id: ItemId
      turnId: TurnId
      kind: "command" | "tool"
      title: string
      detail: string
      executionCommand?: string
      userInitiated?: boolean
      activity?: ItemActivity
      status: ItemStatus
    }
  | {
      id: ItemId
      turnId: TurnId
      kind: "edit"
      title: string
      patch: string
      changes?: readonly {
        path: string
        action: "add" | "delete" | "update"
        movePath?: string
        patch: string
      }[]
      status: ItemStatus
    }
  | AgentItem
  | {
      id: ItemId
      turnId: TurnId
      kind: "unknown"
      title: string
      detail: string
      status: ItemStatus
      transcript?: "diagnostic"
    }
)
