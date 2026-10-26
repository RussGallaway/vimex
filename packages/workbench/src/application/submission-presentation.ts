import type { OutgoingMessage } from "@vimex/composer"
import {
  appendConversationTurnId,
  isConversationItemAddition,
  isConversationTurnIdAppend,
  isConversationTurnUpdate,
  isTurnItemIdAppend,
  itemId,
  setConversationItem,
  setConversationTurn,
  turnId,
  type ConversationItem,
  type ConversationState,
} from "@vimex/conversation"
import {
  removeTranscriptItem,
  syncTranscriptItem,
  transcriptOrderTailRemoval,
  transcriptOrderTailReplacement,
  type TranscriptRuntimeInput,
} from "@vimex/transcript"
import type { ThreadWorkspace } from "./workbench-state"

const empty: readonly OutgoingMessage[] = []

/** Proofs for the common one-message send/echo lifecycle, never guesses from size. */
export function submissionPresentationChange(
  previous: ThreadWorkspace | undefined,
  next: ThreadWorkspace,
): Pick<
  TranscriptRuntimeInput,
  "canonicalPresentationUnchanged" | "tailReplacement"
> {
  const pending = previous?.pendingSubmissions
  if (!previous || pending?.length !== 1) return {}
  const message = pending[0]!
  const before = previous.conversation
  const after = next.conversation
  const nextPending = next.pendingSubmissions ?? empty
  if (
    nextPending.length === 1 &&
    nextPending[0] === message &&
    previous.transcript === next.transcript &&
    before.items === after.items &&
    !before.activeTurnId
  ) {
    const id = after.turnIds.at(-1)
    const turn = id ? after.turns[id] : undefined
    if (
      id &&
      turn?.status === "running" &&
      !turn.itemIds.length &&
      after.activeTurnId === id &&
      isConversationTurnIdAppend(before.turnIds, after.turnIds, id) &&
      isConversationTurnUpdate(before.turns, after.turns, id, undefined, turn)
    )
      return { canonicalPresentationUnchanged: true }
  }
  if (nextPending.length) return {}
  const localId = itemId(message.id)
  if (
    before === after &&
    transcriptOrderTailRemoval(
      previous.transcript.order,
      next.transcript.order,
    ) === localId
  )
    return { tailReplacement: { previousItemId: localId } }
  const replacement = transcriptOrderTailReplacement(
    previous.transcript.order,
    next.transcript.order,
  )
  if (replacement?.removed !== localId) return {}
  const item = after.items[replacement.added]
  const priorTurn = item && before.turns[item.turnId]
  const turn = item && after.turns[item.turnId]
  if (
    item?.kind !== "user" ||
    (item.clientMessageId ?? item.id) !== message.id ||
    !priorTurn ||
    !turn ||
    before.turnIds !== after.turnIds ||
    before.activeTurnId !== after.activeTurnId ||
    priorTurn.status !== turn.status ||
    priorTurn.startedAt !== turn.startedAt ||
    priorTurn.completedAt !== turn.completedAt ||
    priorTurn.durationMs !== turn.durationMs ||
    !isConversationItemAddition(before.items, after.items, item) ||
    !isTurnItemIdAppend(priorTurn.itemIds, turn.itemIds, item.id) ||
    !isConversationTurnUpdate(
      before.turns,
      after.turns,
      item.turnId,
      priorTurn,
      turn,
    )
  )
    return {}
  return { tailReplacement: { previousItemId: localId, nextItemId: item.id } }
}

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
const presentationTurns = new WeakMap<
  ConversationState["turns"],
  WeakMap<
    readonly OutgoingMessage[],
    Pick<ConversationState, "turnIds" | "turns"> & {
      baseTurnIds: ConversationState["turnIds"]
    }
  >
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
  let turnCache = presentationTurns.get(workspace.conversation.turns)
  if (!turnCache) {
    turnCache = new WeakMap()
    presentationTurns.set(workspace.conversation.turns, turnCache)
  }
  const cachedTurns = turnCache.get(pending)
  const reuseTurns = cachedTurns?.baseTurnIds === workspace.conversation.turnIds
  let conversation = workspace.conversation
  for (const message of pending) {
    const item = localItem(message)
    conversation = {
      ...conversation,
      turnIds: reuseTurns
        ? cachedTurns.turnIds
        : appendConversationTurnId(conversation.turnIds, item.turnId),
      turns: reuseTurns
        ? cachedTurns.turns
        : setConversationTurn(conversation.turns, {
            id: item.turnId,
            status: "complete",
            itemIds: [item.id],
          }),
      items: setConversationItem(conversation.items, item),
    }
  }
  if (!reuseTurns)
    turnCache.set(pending, {
      baseTurnIds: workspace.conversation.turnIds,
      turnIds: conversation.turnIds,
      turns: conversation.turns,
    })
  cache.set(pending, conversation)
  return conversation
}
