import type { SubmissionIntent } from "./submission-intent"
export interface OutgoingMessage { id: string; text: string; intent: SubmissionIntent; status: "queued" | "sending" | "failed"; reason?: string }
export interface ComposerState { text: string; cursorOffset: number; revision: number; outbox: readonly OutgoingMessage[] }
export const initialComposer = (): ComposerState => ({ text: "", cursorOffset: 0, revision: 0, outbox: [] })
