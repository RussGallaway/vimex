import type { Approval } from "@vimex/approvals"
import type { SubmissionIntent } from "@vimex/composer"
import type { ItemId, ThreadId } from "@vimex/conversation"
import type { InteractionCommand } from "@vimex/interaction"
import type { LogicalPoint } from "@vimex/transcript"

export type TranscriptAction =
  | { type: "cursor.move"; target: LogicalPoint; preferredScreenRow: number; extend: boolean }
  | { type: "selection.begin"; shape: "character" | "line" }
  | { type: "selection.clear" }
  | { type: "viewport.scroll"; direction: "up" | "down"; amount: "line" | "half-page" }
  | { type: "viewport.tail" }
  | { type: "fold.set"; itemId: ItemId; folded: boolean }
  | { type: "fold.all"; folded: boolean }
  | { type: "copy"; format: "plain" | "source" }
  | { type: "url.open"; url?: string }
  | { type: "fork"; itemId?: ItemId }

export interface WorkbenchActions {
  dispatchInteraction(command: InteractionCommand): void
  changeDraft(text: string, cursorOffset: number): void
  submit(intent: SubmissionIntent): void
  transcript(command: TranscriptAction): void
  openThread(threadId: ThreadId): void
  resolveApproval(approvalId: Approval["id"], choiceId: string): void
  executeCommand(line: string): void
  interrupt(): void
  retryOutgoing(id: string): void
  copyText(text: string): void
}
