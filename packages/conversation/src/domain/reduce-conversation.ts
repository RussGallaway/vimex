import type { ConversationEvent } from "./events"
import type { ConversationItem } from "./item"
import type { ThreadId } from "./identifiers"
import type { ConversationState } from "./thread"
export function createConversation(thread: ThreadId): ConversationState { return { threadId: thread, turnIds: [], turns: {}, items: {} } }
function appendDelta(item: ConversationItem, delta: string): ConversationItem {
  switch (item.kind) {
    case "user": case "assistant": case "reasoning": return { ...item, markdown: item.markdown + delta }
    case "edit": return { ...item, patch: item.patch + delta }
    case "command": case "tool": case "agent": case "unknown": return { ...item, detail: item.detail + delta }
  }
}
export function reduceConversation(state: ConversationState, event: ConversationEvent): ConversationState {
  if (event.threadId !== state.threadId) return state
  switch (event.type) {
    case "turn.started": {
      const exists = state.turns[event.turnId]
      if (exists && exists.status !== "running") {
        if (exists.startedAt !== undefined || event.startedAt === undefined) return state
        return { ...state, turns: { ...state.turns, [event.turnId]: { ...exists, startedAt: event.startedAt } } }
      }
      if (exists && state.activeTurnId !== undefined && state.activeTurnId !== event.turnId) {
        if (exists.startedAt !== undefined || event.startedAt === undefined) return state
        return { ...state, turns: { ...state.turns, [event.turnId]: { ...exists, startedAt: event.startedAt } } }
      }
      if (exists && state.activeTurnId === event.turnId && (exists.startedAt !== undefined || event.startedAt === undefined)) return state
      const turn = exists ? { ...exists, startedAt: exists.startedAt ?? event.startedAt } : { id: event.turnId, status: "running" as const, itemIds: [], startedAt: event.startedAt }
      return { ...state, activeTurnId: event.turnId, turnIds: exists ? state.turnIds : [...state.turnIds, event.turnId], turns: { ...state.turns, [event.turnId]: turn } }
    }
    case "turn.completed": {
      const current = state.turns[event.turnId]
      if (current && current.status !== "running") {
        const turn = {
          ...current,
          startedAt: current.startedAt ?? event.startedAt,
          completedAt: current.completedAt ?? event.completedAt,
          durationMs: current.durationMs ?? event.durationMs,
        }
        const changed = turn.startedAt !== current.startedAt || turn.completedAt !== current.completedAt || turn.durationMs !== current.durationMs
        if (!changed && state.activeTurnId !== event.turnId) return state
        return { ...state, activeTurnId: state.activeTurnId === event.turnId ? undefined : state.activeTurnId, turns: changed ? { ...state.turns, [event.turnId]: turn } : state.turns }
      }
      const turn = current ?? { id: event.turnId, status: event.outcome, itemIds: [] }
      return { ...state, activeTurnId: state.activeTurnId === event.turnId ? undefined : state.activeTurnId, turnIds: current ? state.turnIds : [...state.turnIds, event.turnId], turns: { ...state.turns, [event.turnId]: { ...turn, status: event.outcome, startedAt: turn.startedAt ?? event.startedAt, completedAt: event.completedAt ?? turn.completedAt, durationMs: event.durationMs ?? turn.durationMs } } }
    }
    case "item.started": {
      const turn = state.turns[event.item.turnId] ?? { id: event.item.turnId, status: "running" as const, itemIds: [] }
      const existing = state.items[event.item.id]
      const linked = turn.itemIds.includes(event.item.id)
      return { ...state, turnIds: state.turns[event.item.turnId] ? state.turnIds : [...state.turnIds, event.item.turnId], turns: { ...state.turns, [event.item.turnId]: { ...turn, itemIds: linked ? turn.itemIds : [...turn.itemIds, event.item.id] } }, items: { ...state.items, [event.item.id]: existing && existing.status !== "running" ? existing : event.item } }
    }
    case "item.delta": {
      const current = state.items[event.itemId]
      return !current || current.status !== "running" ? state : { ...state, items: { ...state.items, [event.itemId]: appendDelta(current, event.delta) } }
    }
    case "item.completed": {
      const existing = state.items[event.item.id]
      const turn = state.turns[event.item.turnId] ?? { id: event.item.turnId, status: "running" as const, itemIds: [] }
      const linked = turn.itemIds.includes(event.item.id)
      if (existing && existing.status !== "running" && linked) return state
      return { ...state, turnIds: state.turns[event.item.turnId] ? state.turnIds : [...state.turnIds, event.item.turnId], turns: { ...state.turns, [event.item.turnId]: { ...turn, itemIds: linked ? turn.itemIds : [...turn.itemIds, event.item.id] } }, items: { ...state.items, [event.item.id]: existing && existing.status !== "running" ? existing : event.item } }
    }
  }
}
