import type { ThreadSummary } from "@vimex/conversation"
import type { WorkbenchState } from "./workbench-state"

/** Lifecycle data exposed to integrations such as Herdr. */
export interface WorkbenchLifecycleSnapshot {
  readonly summary?: ThreadSummary
  readonly connection: WorkbenchState["connection"]
  readonly pendingApprovals: number
}

export function captureWorkbenchLifecycle(state: WorkbenchState): WorkbenchLifecycleSnapshot {
  const summary = state.activeThreadId ? state.summaries[state.activeThreadId] : undefined
  const pendingApprovals = summary ? state.approvals.order.reduce((count, id) => count + (state.approvals.byId[id]?.threadId === summary.id ? 1 : 0), 0) : 0
  return Object.freeze({ summary, connection: state.connection, pendingApprovals })
}

/**
 * Token counts are payload metadata, not lifecycle. They ride along with the
 * next semantic report instead of turning token cadence into observer cadence.
 */
export function workbenchLifecycleSignature(value: WorkbenchLifecycleSnapshot): string {
  const summary = value.summary
  return JSON.stringify([
    summary?.id,
    summary?.title,
    summary?.cwd,
    summary?.model,
    summary?.reasoningEffort,
    summary?.gitBranch,
    summary?.status,
    value.connection,
    value.pendingApprovals,
  ])
}

/** Fast relevance gate which deliberately excludes context/token metadata. */
export function workbenchLifecycleChanged(before: WorkbenchState, after: WorkbenchState): boolean {
  if (before.activeThreadId !== after.activeThreadId || before.connection !== after.connection) return true
  const id = after.activeThreadId
  const left = id ? before.summaries[id] : undefined
  const right = id ? after.summaries[id] : undefined
  if (left?.id !== right?.id || left?.title !== right?.title || left?.cwd !== right?.cwd || left?.model !== right?.model
    || left?.reasoningEffort !== right?.reasoningEffort || left?.gitBranch !== right?.gitBranch || left?.status !== right?.status) return true
  return before.approvals !== after.approvals
}
