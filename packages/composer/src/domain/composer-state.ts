import type { SubmissionIntent } from "./submission-intent"
export interface OutgoingMessage {
  id: string
  text: string
  images?: readonly ImageAttachment[]
  intent: SubmissionIntent
  status: "queued" | "sending" | "failed"
  reason?: string
}
export interface ImageAttachment {
  id: string
  label: string
  path: string
  /** Visible inline marker; absent on drafts saved before inline images. */
  marker?: string
}
export interface ComposerState {
  text: string
  images: readonly ImageAttachment[]
  cursorOffset: number
  revision: number
  outbox: readonly OutgoingMessage[]
}
export const initialComposer = (): ComposerState => ({
  text: "",
  images: [],
  cursorOffset: 0,
  revision: 0,
  outbox: [],
})
