import type { ThreadSummary } from "@vimex/conversation"
import type { HerdrConnection } from "./lifecycle-reporter"

export interface HerdrMetadata {
  connection: HerdrConnection
  pendingApprovals: number
  summary?: ThreadSummary
}

export function metadataCommand(
  paneId: string,
  sequence: number,
  metadata: HerdrMetadata,
): string[] {
  const summary = metadata.summary
  return [
    "pane",
    "report-metadata",
    paneId,
    "--source",
    "vimex",
    "--agent",
    "codex",
    "--seq",
    String(sequence),
    "--display-agent",
    "Vimex",
    "--title",
    summary?.title ?? "Vimex",
    "--token",
    `connection=${metadata.connection}`,
    "--token",
    `thread=${summary?.id ?? ""}`,
    "--token",
    `model=${summary?.model ?? ""}`,
    "--token",
    `thinking=${summary?.reasoningEffort ?? ""}`,
    "--token",
    `cwd=${summary?.cwd ?? ""}`,
    "--token",
    `branch=${summary?.gitBranch ?? ""}`,
    "--token",
    `context_used=${summary?.contextUsed ?? ""}`,
    "--token",
    `context_limit=${summary?.contextLimit ?? ""}`,
    "--token",
    `approvals=${metadata.pendingApprovals}`,
  ]
}
