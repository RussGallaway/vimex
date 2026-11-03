import type { WorkbenchState } from "./workbench-state"

export interface PowerSnapshot {
  enabled: boolean
  supported: boolean
  active: boolean
  error?: string
}
export interface PowerControl {
  getSnapshot(): PowerSnapshot
  subscribe(listener: () => void): () => void
  setRequired(required: boolean): void
  setEnabled(enabled: boolean): Promise<void>
  dispose(): void
}
/** Only the currently connected local runtime is observed; remote work is independent. */
export function needsLocalWakefulness(state: WorkbenchState): boolean {
  if (
    (state.machine?.id ?? "local") !== "local" ||
    state.machineChanging ||
    state.connection !== "connected"
  )
    return false
  return Object.values(state.workspaces).some(
    (workspace) =>
      Boolean(workspace.conversation.activeTurnId) ||
      Boolean(workspace.pendingSubmissions?.length) ||
      workspace.composer.outbox.some((message) => message.status === "sending"),
  )
}
