export type HerdrLifecycleState = "idle" | "working" | "blocked" | "unknown"

const source = "vimex"
const agent = "codex"

export function lifecycleCommand(paneId: string, sequence: number, state: HerdrLifecycleState, threadId?: string): string[] {
  return [
    "pane", "report-agent", paneId, "--source", source, "--agent", agent, "--seq", String(sequence), "--state", state,
    ...(threadId ? ["--agent-session-id", threadId] : []),
  ]
}

export function sessionCommand(paneId: string, sequence: number, threadId: string): string[] {
  return ["pane", "report-agent-session", paneId, "--source", source, "--agent", agent, "--seq", String(sequence), "--agent-session-id", threadId]
}

export function releaseCommand(paneId: string, sequence: number): string[] {
  return ["pane", "release-agent", paneId, "--source", source, "--agent", agent, "--seq", String(sequence)]
}
