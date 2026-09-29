import type { ThreadId } from "@vimex/conversation"
import type { WorkbenchState } from "./workbench-state"

/** Moves local draft state onto a server-backed workspace exactly once. */
export function bindProvisionalWorkspace(
  state: WorkbenchState,
  provisionalId: ThreadId,
  threadId: ThreadId,
): WorkbenchState {
  if (provisionalId === threadId) return state
  if (!state.provisionalThreadIds.includes(provisionalId)) return state
  const provisional = state.workspaces[provisionalId]
  const real = state.workspaces[threadId]
  if (!provisional || !real) return state
  const summaries = { ...state.summaries }
  delete summaries[provisionalId]
  const workspaces = { ...state.workspaces }
  delete workspaces[provisionalId]
  workspaces[threadId] = {
    ...real,
    composer: provisional.composer,
    interaction: provisional.interaction,
  }
  return {
    ...state,
    activeThreadId:
      state.activeThreadId === provisionalId ? threadId : state.activeThreadId,
    provisionalThreadIds: state.provisionalThreadIds.filter(
      (id) => id !== provisionalId,
    ),
    threadOrder: state.threadOrder.filter((id) => id !== provisionalId),
    summaries,
    workspaces,
  }
}
