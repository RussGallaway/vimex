import type { WorkbenchState } from "./workbench-state"

export interface StartupReadiness {
  readonly shellReady: true
  readonly connectionReady: boolean
  readonly sessionBound: boolean
}

export function captureStartupReadiness(
  state: WorkbenchState,
): StartupReadiness {
  return {
    shellReady: true,
    connectionReady: state.connection === "connected",
    sessionBound:
      Boolean(state.activeThreadId) && state.provisionalThreadIds.length === 0,
  }
}
