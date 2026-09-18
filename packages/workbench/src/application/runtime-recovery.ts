import type { WorkbenchState } from "./workbench-state"

const uncertain = "Delivery was not confirmed before the runtime disconnected; retry explicitly to resend"

/** Invalidates transport-scoped state without replaying any uncertain request. */
export function invalidateRuntimeState(state: WorkbenchState): WorkbenchState {
  return {
    ...state,
    compactingThreads: {},
    approvals: { order: [], byId: {} },
    questions: {},
    workspaces: Object.fromEntries(Object.entries(state.workspaces).map(([id, workspace]) => [id, {
      ...workspace,
      composer: {
        ...workspace.composer,
        outbox: workspace.composer.outbox.map(message => message.status === "failed" ? message : {
          ...message,
          status: "failed" as const,
          reason: uncertain,
        }),
      },
    }])),
  }
}
