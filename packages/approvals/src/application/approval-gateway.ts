import type { ThreadId, TurnId } from "@vimex/conversation"

export interface UserQuestionRequest {
  id: string
  threadId: ThreadId
  turnId: TurnId
  questions: readonly {
    id: string
    header: string
    question: string
    allowOther: boolean
    secret: boolean
    options?: readonly { label: string; description: string }[]
  }[]
}
export interface ApprovalGateway {
  resolveApproval(id: string, choice: string): Promise<void>
  respondToQuestions?(
    id: string,
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): Promise<void>
}
