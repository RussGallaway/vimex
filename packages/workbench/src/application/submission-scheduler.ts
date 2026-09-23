import {
  firstQueuedMessage,
  markOutgoingSending,
  composerParts,
  type ComposerState,
} from "@vimex/composer"
import type { ThreadId, TurnId } from "@vimex/conversation"
import type { WorkbenchEffect } from "./workbench-state"
export function submissionEffect(
  thread: ThreadId,
  composer: ComposerState,
  messageId: string,
  activeTurnId?: TurnId,
): WorkbenchEffect | undefined {
  const outgoing = composer.outbox.find((message) => message.id === messageId)
  if (!outgoing || outgoing.status !== "sending") return undefined
  return outgoing.intent === "steer" && activeTurnId
    ? {
        type: "conversation.turn.steer",
        threadId: thread,
        text: outgoing.text,
        ...(outgoing.images?.length
          ? { input: composerParts(outgoing.text, outgoing.images) }
          : {}),
        clientMessageId: outgoing.id,
      }
    : {
        type: "conversation.turn.start",
        threadId: thread,
        text: outgoing.text,
        ...(outgoing.images?.length
          ? { input: composerParts(outgoing.text, outgoing.images) }
          : {}),
        clientMessageId: outgoing.id,
      }
}

export function scheduleQueued(
  composer: ComposerState,
  thread: ThreadId,
  activeTurnId?: TurnId,
): { composer: ComposerState; effect?: WorkbenchEffect } {
  const queued = activeTurnId
    ? firstQueuedMessage(composer, "steer")
    : firstQueuedMessage(composer)
  if (!queued) return { composer }
  if (
    activeTurnId &&
    composer.outbox.some(
      (message) => message.intent === "steer" && message.status === "sending",
    )
  )
    return { composer }
  if (
    !activeTurnId &&
    composer.outbox.some((message) => message.status === "sending")
  )
    return { composer }
  const next = markOutgoingSending(composer, queued.id)
  return {
    composer: next,
    effect: submissionEffect(thread, next, queued.id, activeTurnId),
  }
}
