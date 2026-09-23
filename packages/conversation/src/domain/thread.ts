import type { ConversationItem } from "./item"
import type { ThreadId, TurnId } from "./identifiers"
import type { Turn } from "./turn"
export interface ConversationState {
  threadId: ThreadId
  turnIds: readonly TurnId[]
  turns: Readonly<Record<string, Turn>>
  items: Readonly<Record<string, ConversationItem>>
  activeTurnId?: TurnId
}
export interface ThreadSummary {
  goal?: import("./thread-goal").ThreadGoal | null
  id: ThreadId
  title: string
  titleSource?: "name" | "preview" | "untitled"
  parentThreadId?: ThreadId
  model: string
  reasoningEffort: string
  cwd: string
  gitBranch?: string
  updatedAt?: number
  contextUsed?: number
  contextLimit?: number
  status: "idle" | "working" | "blocked" | "disconnected"
}

/** Keep the first-message fallback safe for single-line session chrome. */
export function previewTitle(message: string, limit = 80): string {
  const normalized = message.replace(/\s+/gu, " ").trim()
  if (!normalized) return "Untitled thread"
  const characters = Array.from(normalized)
  return characters.length > limit
    ? `${characters.slice(0, limit).join("")}…`
    : normalized
}
