import type { Approval } from "@vimex/approvals"
import type { SubmissionIntent } from "@vimex/composer"
import type { ItemId, ThreadId } from "@vimex/conversation"
import type { InteractionCommand } from "@vimex/interaction"
import type { LogicalPoint } from "@vimex/transcript"

export type TranscriptAction =
  | { type: "navigate"; motion: "block-next" | "block-previous" | "message-next" | "message-previous" | "url-next" | "url-previous" | "first-content" | "word-next" | "word-previous" | "word-end" | "WORD-next" | "WORD-previous" | "WORD-end"; count?: number }
  | { type: "search"; query: string; direction: "forward" | "backward" }
  | { type: "search.next"; reverse?: boolean; count?: number }
  | { type: "selection.swap" }
  | { type: "reference" }
  | { type: "cursor.move"; target: LogicalPoint; preferredScreenRow: number; extend: boolean }
  | { type: "jump"; target: LogicalPoint; preferredScreenRow?: number; extend?: boolean; origin?: LogicalPoint; originPreferredScreenRow?: number }
  | { type: "jump.back" }
  | { type: "jump.forward" }
  | { type: "mark.set"; name: string }
  | { type: "mark.jump"; name: string }
  | { type: "selection.begin"; shape: "character" | "line" }
  | { type: "selection.clear" }
  | { type: "viewport.scroll"; direction: "up" | "down"; amount: "line" | "half-page" | "page" }
  | { type: "viewport.tail" }
  | { type: "viewport.anchor"; point: LogicalPoint; preferredScreenRow: number }
  | { type: "fold.set"; itemId: ItemId; folded: boolean }
  | { type: "fold.all"; folded: boolean }
  | { type: "copy"; format: "plain" | "source" }
  | { type: "url.open"; url?: string }
  | { type: "fork"; itemId?: ItemId }

export interface WorkbenchActions {
  sideChat(action: import("./side-chat").SideChatAction, question?: string): void
  anchorThread(threadId: ThreadId, point: LogicalPoint, preferredScreenRow: number): void
  dispatchInteraction(command: InteractionCommand): void
  changeDraft(text: string, cursorOffset: number): void
  submit(intent: SubmissionIntent): void
  transcript(command: TranscriptAction): void
  answerQuestions(id: string, answers: Readonly<Record<string, string | readonly string[]>>): void
  openChildThread(id: ThreadId): void
  returnToParent(): void
  cycleAgent(direction: "previous" | "next"): void
  requestFork(itemId?: ItemId): void
  confirmFork(): void
  cancelFork(): void
  restart(): void
  openThread(threadId: ThreadId): void
  renameThread(threadId: ThreadId, title: string): void
  toggleFavorite(threadId: ThreadId): void
  resolveApproval(approvalId: Approval["id"], choiceId: string): void
  executeCommand(line: string): void
  executeNamedCommand(name: string): void
  interrupt(): void
  retryOutgoing(id: string): void
  copyText(text: string): void
}
