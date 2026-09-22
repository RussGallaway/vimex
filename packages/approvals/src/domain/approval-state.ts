import type { Approval } from "./approval"
export interface ApprovalsState {
  order: readonly string[]
  byId: Readonly<Record<string, Approval>>
}
export const initialApprovals = (): ApprovalsState => ({ order: [], byId: {} })
export function receiveApproval(
  state: ApprovalsState,
  approval: Approval,
): ApprovalsState {
  return {
    order: state.byId[approval.id]
      ? state.order
      : [...state.order, approval.id],
    byId: { ...state.byId, [approval.id]: approval },
  }
}
export function resolvingApproval(
  state: ApprovalsState,
  id: string,
): ApprovalsState {
  const approval = state.byId[id]
  return approval
    ? {
        ...state,
        byId: {
          ...state.byId,
          [id]: { ...approval, status: "resolving", error: undefined },
        },
      }
    : state
}
export function resolveApproval(
  state: ApprovalsState,
  id: string,
): ApprovalsState {
  if (!state.byId[id]) return state
  const next = { ...state.byId }
  delete next[id]
  return { order: state.order.filter((current) => current !== id), byId: next }
}
export function failApproval(
  state: ApprovalsState,
  id: string,
  error: string,
): ApprovalsState {
  const approval = state.byId[id]
  return approval
    ? {
        ...state,
        byId: { ...state.byId, [id]: { ...approval, status: "failed", error } },
      }
    : state
}
export type ApprovalCommand =
  | { type: "approval.received"; approval: Approval }
  | { type: "approval.resolving"; id: string }
  | { type: "approval.resolved"; id: string }
  | { type: "approval.failed"; id: string; error: string }
export function reduceApprovals(
  state: ApprovalsState,
  command: ApprovalCommand,
): ApprovalsState {
  switch (command.type) {
    case "approval.received":
      return receiveApproval(state, command.approval)
    case "approval.resolving":
      return resolvingApproval(state, command.id)
    case "approval.resolved":
      return resolveApproval(state, command.id)
    case "approval.failed":
      return failApproval(state, command.id, command.error)
  }
}
