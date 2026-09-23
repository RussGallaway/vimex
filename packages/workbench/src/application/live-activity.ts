import type { ThreadId } from "@vimex/conversation"
import type { WorkbenchState } from "./workbench-state"

export interface LiveActivity {
  working: boolean
  label?: string
  startedAt?: number
}

/** Runtime turn state is authoritative; thread summaries and item events can lag it. */
export function liveActivity(
  state: WorkbenchState,
  threadId: ThreadId | undefined = state.activeThreadId,
): LiveActivity {
  const conversation = threadId
    ? state.workspaces[threadId]?.conversation
    : undefined
  const turnId = conversation?.activeTurnId
  const turn = turnId ? conversation?.turns[turnId] : undefined
  if (threadId && turnId && state.interruptingTurns[threadId] === turnId)
    return { working: true, label: "Stopping", startedAt: turn?.startedAt }
  if (threadId && state.compactingThreads[threadId])
    return { working: true, label: "Compacting", startedAt: turn?.startedAt }
  if (!threadId || !conversation || !turnId) return { working: false }
  if (
    turn?.itemIds.some((id) => {
      const item = conversation.items[id]
      return (
        item?.kind === "agent" &&
        item.action === "wait" &&
        item.status === "running"
      )
    })
  )
    return {
      working: true,
      label: "Waiting for agents",
      startedAt: turn.startedAt,
    }
  return { working: true, label: "Working", startedAt: turn?.startedAt }
}
