import type { ConversationItem, ItemStatus } from "./item"
import type { ConversationState } from "./thread"

/**
 * Item completion can trail the authoritative turn completion notification.
 * Settle presentation without mutating the raw item, so a later final payload
 * can still replace the streamed content.
 */
export function effectiveItemStatus(conversation: ConversationState, item: ConversationItem): ItemStatus {
  if (item.status !== "running") return item.status
  const turn = conversation.turns[item.turnId]
  if (!turn || turn.status === "running") return item.status
  if (turn.status === "interrupted") return "interrupted"
  if (turn.status === "failed") return "error"
  return "complete"
}
