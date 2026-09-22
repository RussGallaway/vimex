import type { ConversationItem } from "./item"
import type { ItemId, ThreadId, TurnId } from "./identifiers"
import type { Turn } from "./turn"
export type TurnOutcome = Exclude<Turn["status"], "running">
export type ConversationEvent =
  | {
      type: "turn.started"
      threadId: ThreadId
      turnId: TurnId
      startedAt?: number
    }
  | {
      type: "turn.completed"
      threadId: ThreadId
      turnId: TurnId
      outcome: TurnOutcome
      startedAt?: number
      completedAt?: number
      durationMs?: number
    }
  | { type: "item.started"; threadId: ThreadId; item: ConversationItem }
  | { type: "item.delta"; threadId: ThreadId; itemId: ItemId; delta: string }
  | { type: "item.completed"; threadId: ThreadId; item: ConversationItem }
