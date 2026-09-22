import type { ApprovalGateway } from "@vimex/approvals"
import type { RuntimeEvent } from "@vimex/workbench"
import type { CodexAppServerClient } from "./capabilities/codex-app-server-client"
import type { CodexAdapterEvent } from "./mapping/map-notification"

/** Owns request-id correlation for application approval and question ports. */
export class CodexApprovalGateway implements ApprovalGateway {
  private generation = 0
  private readonly questionIds = new Map<string, string | number>()
  private readonly approvalIds = new Map<string, string | number>()

  constructor(private readonly client: () => CodexAppServerClient) {}

  handle(event: CodexAdapterEvent): RuntimeEvent[] | undefined {
    switch (event.type) {
      case "userInput.requested": {
        const id = opaqueId(event.requestId)
        this.questionIds.set(id, event.requestId)
        return [
          {
            type: "question.requested",
            request: {
              id,
              threadId: event.threadId,
              turnId: event.turnId,
              questions: event.questions,
            },
          },
        ]
      }
      case "approval.requested":
        this.approvalIds.set(event.approval.id, event.requestId)
        return [{ type: "approval", approval: event.approval }]
      case "approval.cancelled": {
        const events: RuntimeEvent[] = []
        const approvalId = this.approvalId(event.requestId)
        if (approvalId) {
          this.approvalIds.delete(approvalId)
          events.push({ type: "approval.resolved", id: approvalId })
        }
        const questionId = opaqueId(event.requestId)
        if (this.questionIds.delete(questionId))
          events.push({ type: "question.resolved", id: questionId })
        return events
      }
      case "approval.resolved": {
        const questionId = opaqueId(event.requestId)
        if (this.questionIds.delete(questionId))
          return [{ type: "question.resolved", id: questionId }]
        const id = this.approvalId(event.requestId) ?? opaqueId(event.requestId)
        this.approvalIds.delete(id)
        return [{ type: "approval.resolved", id }]
      }
      default:
        return undefined
    }
  }

  async respondToQuestions(
    id: string,
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): Promise<void> {
    const original = this.questionIds.get(id)
    if (original === undefined)
      throw new Error("This question is no longer pending")
    const generation = this.generation
    await this.client().respondToUserInput(original, answers)
    if (generation === this.generation) this.questionIds.delete(id)
  }

  async resolveApproval(id: string, choice: string): Promise<void> {
    const original = this.approvalIds.get(id)
    if (original === undefined)
      throw new Error("This approval is no longer pending")
    await this.client().resolveApproval(original, choice)
  }

  /** Invalidates connection-scoped requests before a new app-server generation starts. */
  invalidatePending(): RuntimeEvent[] {
    this.generation++
    const events: RuntimeEvent[] = [
      ...this.approvalIds
        .keys()
        .map((id) => ({ type: "approval.resolved" as const, id })),
      ...this.questionIds
        .keys()
        .map((id) => ({ type: "question.resolved" as const, id })),
    ]
    this.approvalIds.clear()
    this.questionIds.clear()
    return events
  }

  private approvalId(requestId: string | number): string | undefined {
    return [...this.approvalIds].find(([, raw]) => raw === requestId)?.[0]
  }
}

function opaqueId(id: string | number): string {
  return `${typeof id}:${id}`
}
