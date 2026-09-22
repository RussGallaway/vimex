import type { ComposerState, OutgoingMessage } from "../domain/composer-state"
import type { SubmissionIntent } from "../domain/submission-intent"
export function submitDraft(
  state: ComposerState,
  intent: SubmissionIntent,
  queued: boolean,
  id: string,
): ComposerState {
  const text = state.text.trim()
  if (!text || state.outbox.some((message) => message.id === id)) return state
  return {
    ...state,
    text: "",
    cursorOffset: 0,
    revision: state.revision + 1,
    outbox: [
      ...state.outbox,
      { id, text, intent, status: queued ? "queued" : "sending" },
    ],
  }
}
export function markOutgoingSending(
  state: ComposerState,
  id: string,
): ComposerState {
  return {
    ...state,
    outbox: state.outbox.map((message) =>
      message.id === id
        ? { ...message, status: "sending", reason: undefined }
        : message,
    ),
  }
}
export function firstQueuedMessage(
  state: ComposerState,
  intent?: SubmissionIntent,
): OutgoingMessage | undefined {
  return state.outbox.find(
    (message) =>
      message.status === "queued" &&
      (intent === undefined || message.intent === intent),
  )
}
export function retryOutgoing(
  state: ComposerState,
  id: string,
  queued: boolean,
): ComposerState {
  return {
    ...state,
    outbox: state.outbox.map((message) =>
      message.id === id
        ? {
            ...message,
            status: queued ? "queued" : "sending",
            reason: undefined,
          }
        : message,
    ),
  }
}
export function acknowledgeOutgoing(
  state: ComposerState,
  id: string,
): ComposerState {
  return {
    ...state,
    outbox: state.outbox.filter((message) => message.id !== id),
  }
}
export function failOutgoing(
  state: ComposerState,
  id: string,
  reason: string,
): ComposerState {
  return {
    ...state,
    outbox: state.outbox.map((message) =>
      message.id === id ? { ...message, status: "failed", reason } : message,
    ),
  }
}
