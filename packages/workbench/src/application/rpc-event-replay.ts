import type { ConversationEvent, ConversationState, ItemId } from "@vimex/conversation"

/**
 * RPC event arrays can race the same turn's live notifications. Items already
 * seen live are protected from older snapshots, while distinct returned items
 * remain admissible even when their turn has already started.
 */
export function createRpcEventReplay(conversation: ConversationState) {
  const protectedItems = new Set<ItemId>(Object.keys(conversation.items) as ItemId[])
  return (current: ConversationState, event: ConversationEvent): boolean => {
    if (event.threadId !== current.threadId) return false
    switch (event.type) {
      case "turn.started": {
        const turn = current.turns[event.turnId]
        return !turn || (turn.startedAt === undefined && event.startedAt !== undefined)
      }
      case "turn.completed": {
        const turn = current.turns[event.turnId]
        return !turn || turn.status === "running"
          || (turn.startedAt === undefined && event.startedAt !== undefined)
          || (turn.completedAt === undefined && event.completedAt !== undefined)
          || (turn.durationMs === undefined && event.durationMs !== undefined)
      }
      case "item.started": return !current.items[event.item.id]
      case "item.completed": return !protectedItems.has(event.item.id)
      case "item.delta": return !protectedItems.has(event.itemId) && Boolean(current.items[event.itemId])
    }
  }
}
