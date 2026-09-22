import type { Approval } from "@vimex/approvals"
import type { SubmissionIntent } from "@vimex/composer"
import type { ItemId, ThreadId } from "@vimex/conversation"
import type { InteractionCommand } from "@vimex/interaction"
import type {
  LogicalPoint,
  TranscriptRuntime,
  UrlCandidate,
} from "@vimex/transcript"

export type TranscriptPresentationId = "main" | "side"
export interface TranscriptPresentationHost {
  transcriptRuntime(
    presentationId: TranscriptPresentationId,
  ): TranscriptRuntime | undefined
}

export type TranscriptAction =
  | {
      type: "navigate"
      motion:
        | "block-next"
        | "block-previous"
        | "message-next"
        | "message-previous"
        | "url-next"
        | "url-previous"
        | "first-content"
        | "word-next"
        | "word-previous"
        | "word-end"
        | "WORD-next"
        | "WORD-previous"
        | "WORD-end"
      count?: number
      viewportRows?: number
    }
  | { type: "search"; query: string; direction: "forward" | "backward" }
  | { type: "search.next"; reverse?: boolean; count?: number }
  | { type: "selection.swap" }
  | { type: "reference"; presentationId: TranscriptPresentationId }
  | { type: "child.open"; presentationId: TranscriptPresentationId }
  | {
      type: "cursor.move"
      target: LogicalPoint
      preferredScreenRow: number
      extend: boolean
    }
  | {
      type: "jump"
      target: LogicalPoint
      preserveFolds?: boolean
      preferredScreenRow?: number
      extend?: boolean
      origin?: LogicalPoint
      originPreferredScreenRow?: number
    }
  | { type: "jump.back" }
  | { type: "jump.forward" }
  | { type: "mark.set"; name: string }
  | { type: "mark.jump"; name: string }
  | { type: "selection.begin"; shape: "character" | "line" }
  | { type: "selection.clear" }
  | {
      type: "viewport.scroll"
      direction: "up" | "down"
      amount: "line" | "half-page" | "page"
    }
  | { type: "viewport.tail" }
  | { type: "viewport.anchor"; point: LogicalPoint; preferredScreenRow: number }
  | { type: "fold.set"; itemId: ItemId; folded: boolean }
  | { type: "fold.all"; folded: boolean }
  | { type: "fold.defaults"; reasoning: boolean; tools: boolean }
  | {
      type: "copy"
      format: "plain" | "source"
      presentationId: TranscriptPresentationId
    }
  | {
      type: "url.open"
      url?: string
      candidate?: UrlCandidate
      presentationId: TranscriptPresentationId
    }
  | { type: "fork"; itemId?: ItemId }

export interface WorkbenchActions {
  sideChat(
    action: import("./side-chat").SideChatAction,
    question?: string,
  ): void
  anchorThread(
    threadId: ThreadId,
    point: LogicalPoint,
    preferredScreenRow: number,
  ): void
  dispatchInteraction(command: InteractionCommand): void
  changeDraft(text: string, cursorOffset: number): void
  submit(intent: SubmissionIntent): void
  transcript(command: TranscriptAction): void
  answerQuestions(
    id: string,
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): void
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
  executeCommand(line: string, presentationId?: TranscriptPresentationId): void
  executeNamedCommand(
    name: string,
    presentationId?: TranscriptPresentationId,
  ): void
  interrupt(): void
  retryOutgoing(id: string): void
  copyText(text: string): void
}
