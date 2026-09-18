import type { ConversationItem } from "./item"
import type { ThreadId, TurnId } from "./identifiers"
import type { ConversationState } from "./thread"
import type { Turn } from "./turn"
export function forkConversation(state: ConversationState, nextThreadId: ThreadId, throughTurnId: TurnId): ConversationState | undefined {
  const boundary = state.turnIds.indexOf(throughTurnId)
  if (boundary < 0 || state.turns[throughTurnId]?.status === "running") return undefined
  const turnIds = state.turnIds.slice(0, boundary + 1)
  const turns: Record<string, Turn> = {}; const items: Record<string, ConversationItem> = {}
  for (const id of turnIds) {
    const turn = state.turns[id]; if (!turn) continue
    turns[id] = { ...turn, itemIds: [...turn.itemIds] }
    for (const item of turn.itemIds) { const value = state.items[item]; if (value) items[item] = { ...value } }
  }
  return { threadId: nextThreadId, turnIds, turns, items }
}
