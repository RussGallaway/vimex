import type { ConversationEvent } from "./events"
import type { ConversationItem } from "./item"
import type { ThreadId } from "./identifiers"
import type { ConversationState } from "./thread"
import { conversationItemAt, persistentConversationItems, setConversationItem, type ConversationItemRecordDiagnostics } from "./conversation-items"
export function createConversation(thread: ThreadId): ConversationState {
  return { threadId: thread, turnIds: [], turns: {}, items: persistentConversationItems() }
}
function appendDelta(item: ConversationItem, delta: string): ConversationItem {
  switch (item.kind) {
    case "user": case "assistant": case "reasoning": return { ...item, markdown: item.markdown + delta }
    case "edit": return { ...item, patch: item.patch + delta }
    case "command": case "tool": case "agent": case "unknown": return { ...item, detail: item.detail + delta }
  }
}
function reduce(
  state: ConversationState,
  event: ConversationEvent,
  diagnostics?: ConversationItemRecordDiagnostics,
  writeItem: typeof setConversationItem = setConversationItem,
): ConversationState {
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
      const existing = conversationItemAt(state.items, event.item.id, diagnostics)
      const linked = turn.itemIds.includes(event.item.id)
      return { ...state, turnIds: state.turns[event.item.turnId] ? state.turnIds : [...state.turnIds, event.item.turnId], turns: { ...state.turns, [event.item.turnId]: { ...turn, itemIds: linked ? turn.itemIds : [...turn.itemIds, event.item.id] } }, items: writeItem(state.items, existing && existing.status !== "running" ? existing : event.item, diagnostics) }
    }
    case "item.delta": {
      const current = conversationItemAt(state.items, event.itemId, diagnostics)
      return !current || current.status !== "running" ? state : { ...state, items: writeItem(state.items, appendDelta(current, event.delta), diagnostics) }
    }
    case "item.completed": {
      const existing = conversationItemAt(state.items, event.item.id, diagnostics)
      const turn = state.turns[event.item.turnId] ?? { id: event.item.turnId, status: "running" as const, itemIds: [] }
      const linked = turn.itemIds.includes(event.item.id)
      if (existing && existing.status !== "running" && linked) return state
      return { ...state, turnIds: state.turns[event.item.turnId] ? state.turnIds : [...state.turnIds, event.item.turnId], turns: { ...state.turns, [event.item.turnId]: { ...turn, itemIds: linked ? turn.itemIds : [...turn.itemIds, event.item.id] } }, items: writeItem(state.items, existing && existing.status !== "running" ? existing : event.item, diagnostics) }
    }
  }
}

export function reduceConversation(state: ConversationState, event: ConversationEvent): ConversationState {
  return reduce(state, event)
}

/** Instrumented reducer entry point kept separate so Array.reduce cannot pass its numeric index as diagnostics. */
export function reduceConversationWithDiagnostics(
  state: ConversationState,
  event: ConversationEvent,
  diagnostics: ConversationItemRecordDiagnostics,
): ConversationState {
  return reduce(state, event, diagnostics)
}

function denseSetConversationItem(
  value: Readonly<Record<string, ConversationItem>>,
  item: ConversationItem,
): Readonly<Record<string, ConversationItem>> {
  if (Object.hasOwn(value, item.id) && value[item.id] === item) return value
  const next = Object.assign(Object.create(null), value) as Record<string, ConversationItem>
  next[item.id] = item
  return Object.freeze(next)
}

/** Dense full-copy semantic oracle retained as the reference for the incremental item record. */
export function reduceConversationReference(state: ConversationState, event: ConversationEvent): ConversationState {
  return reduce(state, event, undefined, denseSetConversationItem)
}
