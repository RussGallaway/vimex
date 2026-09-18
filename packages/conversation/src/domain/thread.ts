import type { ConversationItem } from "./item"
import type { ThreadId, TurnId } from "./identifiers"
import type { Turn } from "./turn"
export interface ConversationState { threadId: ThreadId; turnIds: readonly TurnId[]; turns: Readonly<Record<string, Turn>>; items: Readonly<Record<string, ConversationItem>>; activeTurnId?: TurnId }
export interface ThreadSummary { id: ThreadId; title: string; model: string; reasoningEffort: string; cwd: string; gitBranch?: string; contextUsed?: number; contextLimit?: number; status: "idle" | "working" | "blocked" | "disconnected" }
