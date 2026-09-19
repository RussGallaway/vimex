import type { ThreadId } from "@vimex/conversation"
import type { InteractionState } from "@vimex/interaction"
import type { DisplayPreferences } from "./display-preferences"
import { liveActivity, type LiveActivity } from "./live-activity"
import { currentSideChat, sideChatForChild, type SideChat } from "./side-chat"
import type { TranscriptPresentationId } from "./workbench-actions"
import type { ThreadWorkspace, WorkbenchState } from "./workbench-state"

export interface WorkbenchLayoutSnapshot {
  readonly activeThreadId?: ThreadId
  readonly side?: SideChat
  readonly sideThreadReady: boolean
  readonly overlay?: InteractionState["overlay"]
  readonly theme?: DisplayPreferences["theme"]
  readonly parentActivity: LiveActivity
}

/** Cached selection input shared by every publication derived from one state. */
export interface WorkbenchPublicationContext {
  readonly activeThreadId?: ThreadId
  readonly sideChats: WorkbenchState["sideChats"]
  readonly candidate?: SideChat
  readonly side?: SideChat
  readonly sideThreadReady: boolean
}

/** Narrow cached publications consumed by the production React bridge. */
export interface WorkbenchPublicationHost {
  getLayoutSnapshot(): WorkbenchLayoutSnapshot
  subscribeLayout(listener: () => void): () => void
  getPresentationSnapshot(presentationId: TranscriptPresentationId): WorkbenchState
  subscribePresentation(presentationId: TranscriptPresentationId, listener: () => void): () => void
}

export function captureWorkbenchPublicationContext(state: WorkbenchState, previous?: WorkbenchPublicationContext): WorkbenchPublicationContext {
  const reuse = previous !== undefined && previous.activeThreadId === state.activeThreadId && previous.sideChats === state.sideChats
  const candidate = reuse ? previous.candidate : currentSideChat(state)
  const ready = Boolean(candidate?.threadId && state.workspaces[candidate.threadId])
  const side = candidate && state.workspaces[candidate.parentId]
    && (candidate.status === "creating" || ready) ? candidate : undefined
  return Object.freeze({ activeThreadId: state.activeThreadId, sideChats: state.sideChats, candidate, side, sideThreadReady: Boolean(side && ready) })
}

export function threadForPresentation(state: WorkbenchState, presentationId: TranscriptPresentationId, context = captureWorkbenchPublicationContext(state)): ThreadId | undefined {
  const { side } = context
  return presentationId === "main" ? side?.parentId ?? state.activeThreadId : side?.threadId
}

export function captureWorkbenchLayout(state: WorkbenchState, context = captureWorkbenchPublicationContext(state)): WorkbenchLayoutSnapshot {
  const { side, sideThreadReady } = context
  const active = state.activeThreadId
  const snapshot: WorkbenchLayoutSnapshot = {
    activeThreadId: active,
    side,
    sideThreadReady,
    overlay: active ? state.workspaces[active]?.interaction.overlay : undefined,
    theme: state.preferences?.theme,
    parentActivity: liveActivity(state, side?.parentId),
  }
  return Object.freeze(snapshot)
}

export function workbenchLayoutChanged(before: WorkbenchState, after: WorkbenchState,
  beforeContext = captureWorkbenchPublicationContext(before),
  afterContext = captureWorkbenchPublicationContext(after, beforeContext)): boolean {
  if (before.activeThreadId !== after.activeThreadId || before.preferences?.theme !== after.preferences?.theme) return true
  const active = after.activeThreadId
  if ((active ? before.workspaces[active]?.interaction.overlay : undefined) !== (active ? after.workspaces[active]?.interaction.overlay : undefined)) return true
  if (beforeContext.side !== afterContext.side || beforeContext.sideThreadReady !== afterContext.sideThreadReady) return true
  const leftActivity = liveActivity(before, beforeContext.side?.parentId), rightActivity = liveActivity(after, afterContext.side?.parentId)
  return leftActivity.working !== rightActivity.working || leftActivity.label !== rightActivity.label || leftActivity.startedAt !== rightActivity.startedAt
}

function activeTurnChanged(before: ThreadWorkspace | undefined, after: ThreadWorkspace | undefined): boolean {
  const leftId = before?.conversation.activeTurnId, rightId = after?.conversation.activeTurnId
  if (leftId !== rightId) return true
  return (leftId ? before?.conversation.turns[leftId]?.startedAt : undefined) !== (rightId ? after?.conversation.turns[rightId]?.startedAt : undefined)
}

function pendingApproval(state: WorkbenchState, id: ThreadId | undefined) {
  if (!id) return undefined
  return state.approvals.order.map(approvalId => state.approvals.byId[approvalId])
    .find(approval => approval?.threadId === id && (approval.status === "pending" || approval.status === "failed"))
}

function pendingQuestion(state: WorkbenchState, id: ThreadId | undefined) {
  return id ? Object.values(state.questions).find(question => question.threadId === id) : undefined
}

function parentLink(state: WorkbenchState, id: ThreadId | undefined) {
  return id ? state.agentRelationships.find(link => link.childId === id) : undefined
}

function sideForThread(state: WorkbenchState, id: ThreadId | undefined): SideChat | undefined {
  return sideChatForChild(state, id)
}

/**
 * A presentation publication ignores canonical transcript content: the owned
 * TranscriptRuntime publishes that independently. It changes only for state
 * consumed by the surrounding pane, composer, status, or active overlays.
 */
export function workbenchPresentationChanged(before: WorkbenchState, after: WorkbenchState, presentationId: TranscriptPresentationId,
  beforeContext = captureWorkbenchPublicationContext(before),
  afterContext = captureWorkbenchPublicationContext(after, beforeContext)): boolean {
  const leftId = threadForPresentation(before, presentationId, beforeContext), rightId = threadForPresentation(after, presentationId, afterContext)
  if (leftId !== rightId) return true
  if (before.preferences !== after.preferences || before.connection !== after.connection) return true
  const leftInteractive = before.activeThreadId === leftId && (presentationId === "main" || Boolean(leftId))
  const rightInteractive = after.activeThreadId === rightId && (presentationId === "main" || Boolean(rightId))
  if (leftInteractive !== rightInteractive) return true
  if (rightInteractive && before.error !== after.error) return true
  if (before.approvals !== after.approvals && before.approvals.order.length !== after.approvals.order.length) return true
  if (before.questions !== after.questions && Object.keys(before.questions).length !== Object.keys(after.questions).length) return true
  const left = leftId ? before.workspaces[leftId] : undefined
  const right = rightId ? after.workspaces[rightId] : undefined
  if (!left || !right) return left !== right
  if (left.composer !== right.composer || left.interaction !== right.interaction
    || left.transcript.unseenEntries !== right.transcript.unseenEntries || activeTurnChanged(left, right)) return true
  if (before.summaries[leftId!] !== after.summaries[rightId!]
    || before.compactingThreads[leftId!] !== after.compactingThreads[rightId!]
    || before.interruptingTurns[leftId!] !== after.interruptingTurns[rightId!]) return true

  if (before.sideChats !== after.sideChats && sideForThread(before, leftId) !== sideForThread(after, rightId)) return true
  if (before.agentRelationships !== after.agentRelationships) {
    const leftParent = parentLink(before, leftId), rightParent = parentLink(after, rightId)
    if (leftParent !== rightParent || right?.interaction.overlay === "agents") return true
  }
  if (before.summaries !== after.summaries) {
    const leftParent = parentLink(before, leftId), rightParent = parentLink(after, rightId)
    const leftParentSummary = leftParent ? before.summaries[leftParent.parentId] : undefined
    const rightParentSummary = rightParent ? after.summaries[rightParent.parentId] : undefined
    if (leftParentSummary !== rightParentSummary) return true
  }

  if (before.approvals !== after.approvals && pendingApproval(before, leftId) !== pendingApproval(after, rightId)) return true
  if (before.questions !== after.questions && pendingQuestion(before, leftId) !== pendingQuestion(after, rightId)) return true

  if (!rightInteractive) return false
  if (before.availableModels !== after.availableModels || before.modelCatalogError !== after.modelCatalogError
    || before.threadOrder !== after.threadOrder || before.pendingFork !== after.pendingFork || before.urlChoices !== after.urlChoices
  ) return true
  if ((right.interaction.overlay === "sessions" || right.interaction.overlay === "agents") && before.summaries !== after.summaries) return true
  if (right.interaction.overlay === "sessions" && before.favoriteThreadIds !== after.favoriteThreadIds) return true
  return false
}

export function captureWorkbenchPresentation(state: WorkbenchState, presentationId: TranscriptPresentationId,
  context = captureWorkbenchPublicationContext(state)): WorkbenchState {
  return Object.freeze({ ...state, activeThreadId: threadForPresentation(state, presentationId, context) })
}
