import type { ConversationItem, ThreadId } from "@vimex/conversation"
import type { WorkbenchState } from "./workbench-state"

export interface LiveActivity { working: boolean; label?: string }

function labelFor(item: ConversationItem | undefined): string {
  if (item?.kind === "reasoning") return "Thinking"
  if (item?.kind === "assistant") return "Responding"
  if (item?.kind === "command" || item?.kind === "tool") return "Running tool"
  if (item?.kind === "edit") return "Editing"
  return "Waiting for Codex"
}

/** Runtime turn state is authoritative; thread summaries and item events can lag it. */
export function liveActivity(state: WorkbenchState, threadId: ThreadId | undefined = state.activeThreadId): LiveActivity {
  const conversation = threadId ? state.workspaces[threadId]?.conversation : undefined
  const turnId = conversation?.activeTurnId
  if (!threadId || !conversation || !turnId) return { working: false }
  if (state.interruptingTurns[threadId] === turnId) return { working: true, label: "Stopping" }
  const turn = conversation.turns[turnId]
  const ids = turn?.itemIds ?? []
  for (let index = ids.length - 1; index >= 0; index--) {
    const item = conversation.items[ids[index]!]
    if (item?.status === "running" && item.kind !== "user") return { working: true, label: labelFor(item) }
  }
  return { working: true, label: labelFor(undefined) }
}
