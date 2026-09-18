import { itemId, turnId, type ConversationItem } from "@vimex/conversation"

/** Deterministic transcript fixtures shared by domain and renderer tests. */
export function assistantMessage(id: string, markdown: string, status: "running" | "complete" = "complete"): ConversationItem {
  return { id: itemId(id), turnId: turnId("turn"), kind: "assistant", markdown, status }
}
