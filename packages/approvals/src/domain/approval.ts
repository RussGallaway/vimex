import type { ThreadId, TurnId } from "@vimex/conversation"
export interface ApprovalChoice { id: string; label: string }
export interface Approval {
  id: string; threadId: ThreadId; turnId?: TurnId; kind: "command" | "file-change" | "permissions" | "legacy"
  title: string; detail: string; choices: readonly ApprovalChoice[]; status: "pending" | "resolving" | "resolved" | "failed"; error?: string
}
