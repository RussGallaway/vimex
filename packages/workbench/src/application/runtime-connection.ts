import type { Approval, UserQuestionRequest } from "@vimex/approvals"
import type { AgentRelationship, ConversationEvent, ThreadId, ThreadSummary } from "@vimex/conversation"

/** Normalized observations consumed by the workbench projector. */
export type RuntimeEvent =
  | { type: "question.requested"; request: UserQuestionRequest }
  | { type: "question.resolved"; id: string }
  | { type: "subagent.link"; link: AgentRelationship }
  | { type: "conversation"; event: ConversationEvent }
  | { type: "summary"; summary: ThreadSummary }
  | { type: "metadata"; threadId: ThreadId; patch: Partial<Omit<ThreadSummary, "id">> }
  | { type: "approval"; approval: Approval }
  | { type: "approval.resolved"; id: string }
  | { type: "disconnected"; message: string }
  | { type: "notice"; message: string }

export interface RuntimeConnection {
  connect(): Promise<void>
  restart(): Promise<void>
  subscribe(listener: (event: RuntimeEvent) => void): () => void
  close(): Promise<void>
}
