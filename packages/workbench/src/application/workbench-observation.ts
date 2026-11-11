import type { ThreadSummary, Turn } from "@vimex/conversation"
import type { WorkbenchState } from "./workbench-state"

/** Lifecycle data exposed to integrations such as Herdr. */
export interface WorkbenchLifecycleSnapshot {
  /** Stable application target; withheld while a machine transition is pending. */
  readonly resumeTarget?: {
    readonly machine: string
    readonly cwd: string
    readonly thread?: string
    readonly draftId?: string
    readonly model?: string
  }
  readonly summary?: ThreadSummary
  readonly connection: WorkbenchState["connection"]
  readonly pendingApprovals: number
  /** Unresolved user questions for the active thread; absent in older observers. */
  readonly pendingQuestions?: number
  /** Active turn, or the latest settled turn. Never includes transcript content. */
  readonly turn?: Readonly<Pick<Turn, "id" | "status">>
}

export function captureWorkbenchLifecycle(
  state: WorkbenchState,
): WorkbenchLifecycleSnapshot {
  const summary = state.activeThreadId
    ? state.summaries[state.activeThreadId]
    : undefined
  const pendingApprovals = summary
    ? state.approvals.order.reduce(
        (count, id) =>
          count + (state.approvals.byId[id]?.threadId === summary.id ? 1 : 0),
        0,
      )
    : 0
  const turn = lifecycleTurn(state)
  return Object.freeze({
    resumeTarget:
      summary && !state.machineChanging
        ? Object.freeze({
            machine: state.machine?.id ?? "local",
            cwd: summary.cwd,
            ...(state.provisionalThreadIds.includes(summary.id)
              ? { draftId: summary.id }
              : { thread: summary.id }),
            ...(summary.model ? { model: summary.model } : {}),
          })
        : undefined,
    summary,
    connection: state.connection,
    pendingApprovals,
    pendingQuestions: summary
      ? Object.values(state.questions).filter(
          (request) => request.threadId === summary.id,
        ).length
      : 0,
    turn: turn
      ? Object.freeze({ id: turn.id, status: turn.status })
      : undefined,
  })
}

/**
 * Token counts are payload metadata, not lifecycle. They ride along with the
 * next semantic report instead of turning token cadence into observer cadence.
 */
export function workbenchLifecycleSignature(
  value: WorkbenchLifecycleSnapshot,
): string {
  const summary = value.summary
  return JSON.stringify([
    value.resumeTarget,
    summary?.id,
    summary?.title,
    summary?.cwd,
    summary?.model,
    summary?.reasoningEffort,
    summary?.gitBranch,
    summary?.status,
    value.connection,
    value.pendingApprovals,
    value.pendingQuestions ?? 0,
    value.turn?.id,
    value.turn?.status,
  ])
}

/** Fast relevance gate which deliberately excludes context/token metadata. */
export function workbenchLifecycleChanged(
  before: WorkbenchState,
  after: WorkbenchState,
): boolean {
  if (
    before.activeThreadId !== after.activeThreadId ||
    before.machine?.id !== after.machine?.id ||
    before.machineChanging !== after.machineChanging ||
    before.provisionalThreadIds !== after.provisionalThreadIds ||
    before.connection !== after.connection
  )
    return true
  const id = after.activeThreadId
  const left = id ? before.summaries[id] : undefined
  const right = id ? after.summaries[id] : undefined
  if (
    left?.id !== right?.id ||
    left?.title !== right?.title ||
    left?.cwd !== right?.cwd ||
    left?.model !== right?.model ||
    left?.reasoningEffort !== right?.reasoningEffort ||
    left?.gitBranch !== right?.gitBranch ||
    left?.status !== right?.status
  )
    return true
  if (
    before.approvals !== after.approvals ||
    before.questions !== after.questions
  )
    return true
  const previousTurn = lifecycleTurn(before)
  const nextTurn = lifecycleTurn(after)
  return (
    previousTurn?.id !== nextTurn?.id ||
    previousTurn?.status !== nextTurn?.status
  )
}

function lifecycleTurn(state: WorkbenchState): Turn | undefined {
  const conversation = state.activeThreadId
    ? state.workspaces[state.activeThreadId]?.conversation
    : undefined
  const id = conversation?.activeTurnId ?? conversation?.turnIds.at(-1)
  return id ? conversation?.turns[id] : undefined
}
