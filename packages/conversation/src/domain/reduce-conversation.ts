import type { ConversationEvent } from "./events"
import type { ConversationItem } from "./item"
import type { ThreadId } from "./identifiers"
import type { ConversationState } from "./thread"
import {
  conversationItemAt,
  persistentConversationItems,
  setConversationItem,
  type ConversationItemRecordDiagnostics,
} from "./conversation-items"
import {
  appendConversationTurnId,
  appendTurnItemId,
  persistentConversationTurnIds,
  persistentTurnItemIds,
  turnItemIdsHave,
  createConversationStructureDiagnostics,
  type ConversationStructureDiagnostics,
} from "./conversation-id-sequences"
import {
  conversationTurnAt,
  persistentConversationTurns,
  setConversationTurn,
} from "./conversation-turns"
import type { ItemId, TurnId } from "./identifiers"
import type { Turn } from "./turn"

export type ConversationReductionDiagnostics =
  ConversationItemRecordDiagnostics & Partial<ConversationStructureDiagnostics>

export function createConversationReductionDiagnostics(): ConversationItemRecordDiagnostics &
  ConversationStructureDiagnostics {
  return {
    conversationItemRecordNormalizations: 0,
    conversationItemRecordNormalizationItemVisits: 0,
    conversationItemRecordLookups: 0,
    conversationItemRecordLookupNodeVisits: 0,
    conversationItemRecordUpdates: 0,
    conversationItemRecordNodeVisits: 0,
    conversationItemRecordNodesCopied: 0,
    ...createConversationStructureDiagnostics(),
  }
}

export function createConversation(thread: ThreadId): ConversationState {
  return {
    threadId: thread,
    turnIds: persistentConversationTurnIds(),
    turns: persistentConversationTurns(),
    items: persistentConversationItems(),
  }
}
function appendDelta(item: ConversationItem, delta: string): ConversationItem {
  switch (item.kind) {
    case "user":
    case "assistant":
    case "reasoning":
      return { ...item, markdown: item.markdown + delta }
    case "edit":
      return { ...item, patch: item.patch + delta }
    case "command":
    case "tool":
    case "agent":
    case "unknown":
      return { ...item, detail: item.detail + delta }
  }
}
function reduce(
  state: ConversationState,
  event: ConversationEvent,
  diagnostics: ConversationReductionDiagnostics | undefined,
  storage: ConversationStorage,
): ConversationState {
  if (event.threadId !== state.threadId) return state
  switch (event.type) {
    case "turn.started": {
      const exists = storage.turnAt(state.turns, event.turnId, diagnostics)
      if (exists && exists.status !== "running") {
        if (exists.startedAt !== undefined || event.startedAt === undefined)
          return state
        return {
          ...state,
          turns: storage.writeTurn(
            state.turns,
            { ...exists, startedAt: event.startedAt },
            diagnostics,
          ),
        }
      }
      if (
        exists &&
        state.activeTurnId !== undefined &&
        state.activeTurnId !== event.turnId
      ) {
        if (exists.startedAt !== undefined || event.startedAt === undefined)
          return state
        return {
          ...state,
          turns: storage.writeTurn(
            state.turns,
            { ...exists, startedAt: event.startedAt },
            diagnostics,
          ),
        }
      }
      if (
        exists &&
        state.activeTurnId === event.turnId &&
        (exists.startedAt !== undefined || event.startedAt === undefined)
      )
        return state
      const turn = exists
        ? { ...exists, startedAt: exists.startedAt ?? event.startedAt }
        : {
            id: event.turnId,
            status: "running" as const,
            itemIds: storage.emptyItemIds(),
            startedAt: event.startedAt,
          }
      return {
        ...state,
        activeTurnId: event.turnId,
        turnIds: exists
          ? state.turnIds
          : storage.appendTurnId(state.turnIds, event.turnId, diagnostics),
        turns: storage.writeTurn(state.turns, turn, diagnostics),
      }
    }
    case "turn.completed": {
      const current = storage.turnAt(state.turns, event.turnId, diagnostics)
      if (current && current.status !== "running") {
        const turn = {
          ...current,
          startedAt: current.startedAt ?? event.startedAt,
          completedAt: current.completedAt ?? event.completedAt,
          durationMs: current.durationMs ?? event.durationMs,
        }
        const changed =
          turn.startedAt !== current.startedAt ||
          turn.completedAt !== current.completedAt ||
          turn.durationMs !== current.durationMs
        if (!changed && state.activeTurnId !== event.turnId) return state
        return {
          ...state,
          activeTurnId:
            state.activeTurnId === event.turnId
              ? undefined
              : state.activeTurnId,
          turns: changed
            ? storage.writeTurn(state.turns, turn, diagnostics)
            : state.turns,
        }
      }
      const turn = current ?? {
        id: event.turnId,
        status: event.outcome,
        itemIds: storage.emptyItemIds(),
      }
      return {
        ...state,
        activeTurnId:
          state.activeTurnId === event.turnId ? undefined : state.activeTurnId,
        turnIds: current
          ? state.turnIds
          : storage.appendTurnId(state.turnIds, event.turnId, diagnostics),
        turns: storage.writeTurn(
          state.turns,
          {
            ...turn,
            status: event.outcome,
            startedAt: turn.startedAt ?? event.startedAt,
            completedAt: event.completedAt ?? turn.completedAt,
            durationMs: event.durationMs ?? turn.durationMs,
          },
          diagnostics,
        ),
      }
    }
    case "item.started": {
      const existingTurn = storage.turnAt(
        state.turns,
        event.item.turnId,
        diagnostics,
      )
      const turn = existingTurn ?? {
        id: event.item.turnId,
        status: "running" as const,
        itemIds: storage.emptyItemIds(),
      }
      const existing = storage.itemAt(state.items, event.item.id, diagnostics)
      const linked = storage.hasItemId(turn.itemIds, event.item.id, diagnostics)
      return {
        ...state,
        turnIds: existingTurn
          ? state.turnIds
          : storage.appendTurnId(state.turnIds, event.item.turnId, diagnostics),
        turns: storage.writeTurn(
          state.turns,
          {
            ...turn,
            itemIds: linked
              ? turn.itemIds
              : storage.appendItemId(turn.itemIds, event.item.id, diagnostics),
          },
          diagnostics,
        ),
        items: storage.writeItem(
          state.items,
          existing && existing.status !== "running" ? existing : event.item,
          diagnostics,
        ),
      }
    }
    case "item.delta": {
      const current = storage.itemAt(state.items, event.itemId, diagnostics)
      return !current || current.status !== "running"
        ? state
        : {
            ...state,
            items: storage.writeItem(
              state.items,
              appendDelta(current, event.delta),
              diagnostics,
            ),
          }
    }
    case "item.completed": {
      const existing = storage.itemAt(state.items, event.item.id, diagnostics)
      const existingTurn = storage.turnAt(
        state.turns,
        event.item.turnId,
        diagnostics,
      )
      const turn = existingTurn ?? {
        id: event.item.turnId,
        status: "running" as const,
        itemIds: storage.emptyItemIds(),
      }
      const linked = storage.hasItemId(turn.itemIds, event.item.id, diagnostics)
      if (existing && existing.status !== "running" && linked) return state
      return {
        ...state,
        turnIds: existingTurn
          ? state.turnIds
          : storage.appendTurnId(state.turnIds, event.item.turnId, diagnostics),
        turns: storage.writeTurn(
          state.turns,
          {
            ...turn,
            itemIds: linked
              ? turn.itemIds
              : storage.appendItemId(turn.itemIds, event.item.id, diagnostics),
          },
          diagnostics,
        ),
        items: storage.writeItem(
          state.items,
          existing && existing.status !== "running" ? existing : event.item,
          diagnostics,
        ),
      }
    }
  }
}

interface ConversationStorage {
  turnAt(
    value: Readonly<Record<string, Turn>>,
    turnId: TurnId,
    diagnostics?: ConversationReductionDiagnostics,
  ): Turn | undefined
  writeTurn(
    value: Readonly<Record<string, Turn>>,
    turn: Turn,
    diagnostics?: ConversationReductionDiagnostics,
  ): Readonly<Record<string, Turn>>
  appendTurnId(
    value: readonly TurnId[],
    turnId: TurnId,
    diagnostics?: ConversationReductionDiagnostics,
  ): readonly TurnId[]
  emptyItemIds(): readonly ItemId[]
  hasItemId(
    value: readonly ItemId[],
    itemId: ItemId,
    diagnostics?: ConversationReductionDiagnostics,
  ): boolean
  appendItemId(
    value: readonly ItemId[],
    itemId: ItemId,
    diagnostics?: ConversationReductionDiagnostics,
  ): readonly ItemId[]
  itemAt(
    value: Readonly<Record<string, ConversationItem>>,
    itemId: ItemId,
    diagnostics?: ConversationReductionDiagnostics,
  ): ConversationItem | undefined
  writeItem(
    value: Readonly<Record<string, ConversationItem>>,
    item: ConversationItem,
    diagnostics?: ConversationReductionDiagnostics,
  ): Readonly<Record<string, ConversationItem>>
}

const persistentStorage: ConversationStorage = {
  turnAt: conversationTurnAt,
  writeTurn: setConversationTurn,
  appendTurnId: appendConversationTurnId,
  emptyItemIds: persistentTurnItemIds,
  hasItemId: turnItemIdsHave,
  appendItemId: appendTurnItemId,
  itemAt: conversationItemAt,
  writeItem: setConversationItem,
}

export function reduceConversation(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  return reduce(state, event, undefined, persistentStorage)
}

/** Instrumented reducer entry point kept separate so Array.reduce cannot pass its numeric index as diagnostics. */
export function reduceConversationWithDiagnostics(
  state: ConversationState,
  event: ConversationEvent,
  diagnostics: ConversationReductionDiagnostics,
): ConversationState {
  return reduce(state, event, diagnostics, persistentStorage)
}

function denseSetConversationItem(
  value: Readonly<Record<string, ConversationItem>>,
  item: ConversationItem,
): Readonly<Record<string, ConversationItem>> {
  if (Object.hasOwn(value, item.id) && value[item.id] === item) return value
  const next = Object.assign(Object.create(null), value) as Record<
    string,
    ConversationItem
  >
  next[item.id] = item
  return Object.freeze(next)
}

function denseSetConversationTurn(
  value: Readonly<Record<string, Turn>>,
  turn: Turn,
): Readonly<Record<string, Turn>> {
  if (Object.hasOwn(value, turn.id) && value[turn.id] === turn) return value
  const next = Object.assign(Object.create(null), value) as Record<string, Turn>
  next[turn.id] = turn
  return Object.freeze(next)
}

const denseStorage: ConversationStorage = {
  turnAt: (value, id) => (Object.hasOwn(value, id) ? value[id] : undefined),
  writeTurn: (value, turn) => denseSetConversationTurn(value, turn),
  appendTurnId: (value, id) => Object.freeze([...value, id]),
  emptyItemIds: () => Object.freeze([]),
  hasItemId: (value, id) => value.includes(id),
  appendItemId: (value, id) => Object.freeze([...value, id]),
  itemAt: (value, id) => (Object.hasOwn(value, id) ? value[id] : undefined),
  writeItem: (value, item) => denseSetConversationItem(value, item),
}

/** Dense full-copy semantic oracle retained as the reference for incremental canonical storage. */
export function reduceConversationReference(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  return reduce(state, event, undefined, denseStorage)
}
