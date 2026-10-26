import type { OutgoingMessage } from "@vimex/composer"
import {
  appendConversationTurnId,
  itemId,
  setConversationItem,
  setConversationTurn,
  turnId,
  type ConversationItem,
  type ConversationState,
} from "@vimex/conversation"
import { removeTranscriptItem, syncTranscriptItem } from "@vimex/transcript"
import type { ThreadWorkspace } from "./workbench-state"

const empty: readonly OutgoingMessage[] = []

function localItem(message: OutgoingMessage): ConversationItem {
  return {
    id: itemId(message.id),
    turnId: turnId(`local-submit:${message.id}`),
    kind: "user",
    markdown: [
      message.text,
      ...(message.images ?? []).flatMap((image, index) =>
        image.marker && message.text.includes(image.marker)
          ? []
          : [`[Image ${index + 1}]`],
      ),
    ]
      .filter(Boolean)
      .join(" "),
    status: "complete",
  }
}

/** Keep local transcript semantics without inventing canonical server events. */
export function syncSubmissionPresentation(
  previous: ThreadWorkspace,
  next: ThreadWorkspace,
  provisional = false,
): ThreadWorkspace {
  if (previous === next) return next
  const pending = previous.pendingSubmissions ?? empty
  if (!pending.length && !next.composer.outbox.length) return next
  const messages = new Map(
    (next.pendingSubmissions ?? empty).map((message) => [message.id, message]),
  )
  for (const message of messages.values())
    if (
      message.status === "queued" &&
      !next.composer.outbox.some((outgoing) => outgoing.id === message.id)
    )
      messages.delete(message.id)
  for (const message of next.composer.outbox) {
    if (
      message.status === "sending" ||
      (provisional && message.status === "queued")
    )
      messages.set(message.id, message)
    else messages.delete(message.id)
  }
  for (const message of messages.values())
    if (next.conversation.items[message.serverItemId ?? message.id])
      messages.delete(message.id)
  const candidates = [...messages.values()]
  const retained =
    candidates.length === pending.length &&
    candidates.every((message, index) => message === pending[index])
      ? pending
      : candidates
  let transcript = next.transcript
  for (const message of pending)
    if (!messages.has(message.id) && !next.conversation.items[message.id])
      transcript = removeTranscriptItem(transcript, itemId(message.id))
  for (const message of retained)
    if (!transcript.projectionById[message.id])
      transcript = syncTranscriptItem(transcript, localItem(message))
  if (retained === pending && transcript === next.transcript) return next
  return { ...next, pendingSubmissions: retained, transcript }
}

const presentations = new WeakMap<
  ConversationState,
  WeakMap<readonly OutgoingMessage[], ConversationState>
>()

/** Overlay only at the presentation boundary; persistence and turn scheduling
 * continue to observe the real server conversation. Cache across draft edits. */
export function submissionConversation(
  workspace: ThreadWorkspace,
): ConversationState {
  const pending = workspace.pendingSubmissions
  if (!pending?.length) return workspace.conversation
  let cache = presentations.get(workspace.conversation)
  if (!cache) {
    cache = new WeakMap()
    presentations.set(workspace.conversation, cache)
  }
  const cached = cache.get(pending)
  if (cached) return cached
  let conversation = workspace.conversation
  for (const message of pending) {
    const item = localItem(message)
    conversation = {
      ...conversation,
      turnIds: appendConversationTurnId(conversation.turnIds, item.turnId),
      turns: setConversationTurn(conversation.turns, {
        id: item.turnId,
        status: "complete",
        itemIds: [item.id],
      }),
      items: setConversationItem(conversation.items, item),
    }
  }
  cache.set(pending, conversation)
  return conversation
}
