import type { ItemId } from "../domain/identifiers"
import type { ConversationState } from "../domain/thread"

/** Resolve the user message starting the selected completed turn. */
export function forkBoundary(conversation: ConversationState, selected?: ItemId) {
  const order = conversation.turnIds.flatMap(id => conversation.turns[id]?.itemIds ?? [])
  const index = selected ? order.indexOf(selected) : order.length - 1
  for (let i = index; i >= 0; i--) {
    const item = conversation.items[order[i]!]
    if (item?.kind !== "user") continue
    const turn = conversation.turns[item.turnId]
    if (!turn || turn.status === "running") return undefined
    return { threadId: conversation.threadId, itemId: item.id, turnId: item.turnId, preview: item.markdown }
  }
  return undefined
}
