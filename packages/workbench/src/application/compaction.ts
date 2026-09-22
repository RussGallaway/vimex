import type { ConversationEvent, ThreadId, TurnId } from "@vimex/conversation"
import type { WorkbenchState } from "./workbench-state"

export interface CompactionStatus {
  readonly requestId?: string
  readonly phase: "requested" | "running"
  readonly turnId?: TurnId
}
export type CompactionObservation = {
  threadId: ThreadId
  phase: "started" | "completed" | "failed"
  turnId?: TurnId
  error?: string
}

/** Compaction is asynchronous: an RPC acknowledgement never settles this state. */
export function observeCompaction(
  state: WorkbenchState,
  observation: CompactionObservation,
): WorkbenchState {
  const previous = state.compactingThreads[observation.threadId]
  const turn =
    observation.turnId &&
    state.workspaces[observation.threadId]?.conversation.turns[
      observation.turnId
    ]
  // Delayed events from an already settled turn cannot claim a fresh request.
  if (previous?.phase === "requested" && turn && turn.status !== "running")
    return state
  if (observation.phase === "started") {
    if (state.retiredSideThreadIds.includes(observation.threadId)) return state
    if (
      previous?.turnId &&
      observation.turnId &&
      previous.turnId !== observation.turnId
    )
      return state
    if (turn && turn.status !== "running") return state
    return {
      ...state,
      compactingThreads: {
        ...state.compactingThreads,
        [observation.threadId]: {
          requestId: previous?.requestId,
          phase: "running",
          turnId: observation.turnId,
        },
      },
    }
  }
  if (
    !previous ||
    (previous.turnId &&
      observation.turnId &&
      previous.turnId !== observation.turnId)
  )
    return state
  const compactingThreads = { ...state.compactingThreads }
  delete compactingThreads[observation.threadId]
  return {
    ...state,
    compactingThreads,
    ...(observation.error ? { error: observation.error } : {}),
  }
}

export function observeCompactionTurn(
  state: WorkbenchState,
  event: ConversationEvent,
): WorkbenchState {
  const pending = state.compactingThreads[event.threadId]
  if (!pending) return state
  if (event.type === "turn.started" && !pending.turnId)
    return observeCompaction(state, {
      threadId: event.threadId,
      turnId: event.turnId,
      phase: "started",
    })
  if (event.type === "turn.completed" && pending.turnId === event.turnId)
    return observeCompaction(state, {
      threadId: event.threadId,
      turnId: event.turnId,
      phase: "completed",
    })
  return state
}

export function compactionBlockReason(
  state: WorkbenchState,
  id: ThreadId,
): string | undefined {
  const workspace = state.workspaces[id]
  if (!workspace) return "Open a session before compacting"
  if (state.connection !== "connected")
    return "Connect to Codex before compacting"
  if (
    workspace.conversation.activeTurnId ||
    workspace.composer.outbox.some((message) => message.status !== "failed")
  )
    return "Wait for the current turn and pending messages before compacting"
  return undefined
}
