import {
  conversationTurnIdsHave,
  forkConversation,
  reduceConversation,
  type ConversationEvent,
  type ConversationStructureDiagnostics,
  type ThreadId,
  type TurnId,
} from "@vimex/conversation"
import {
  initialTranscript,
  persistentTranscriptFolds,
  syncTranscriptItem,
} from "@vimex/transcript"
import { initialComposer } from "@vimex/composer"
import { initialInteraction } from "@vimex/interaction"
import {
  done,
  updateWorkspace,
  type ThreadWorkspace,
  type WorkbenchEffect,
  type WorkbenchState,
  type WorkbenchTransition,
} from "./workbench-state"
import { scheduleQueued } from "./submission-scheduler"
import { sideChatForChild } from "./side-chat"
export function applyConversationEvent(
  state: WorkbenchState,
  event: ConversationEvent,
  diagnostics?: Partial<ConversationStructureDiagnostics>,
): WorkbenchTransition {
  const workspace = state.workspaces[event.threadId]
  if (!workspace) return done(state)
  const priorTurn =
    event.type === "turn.completed"
      ? workspace.conversation.turns[event.turnId]
      : undefined
  const conversation = reduceConversation(workspace.conversation, event)
  let transcript = workspace.transcript
  const changedItemId =
    event.type === "item.started" || event.type === "item.completed"
      ? event.item.id
      : event.type === "item.delta"
        ? event.itemId
        : undefined
  if (changedItemId) {
    const item = conversation.items[changedItemId]
    const side = sideChatForChild(state, event.threadId)
    const inherited =
      item &&
      side?.inheritedTurnIds &&
      conversationTurnIdsHave(side.inheritedTurnIds, item.turnId, diagnostics)
    if (
      item &&
      !inherited &&
      item !== workspace.conversation.items[changedItemId]
    )
      transcript = syncTranscriptItem(transcript, item)
  }
  let composer = workspace.composer
  const effects: WorkbenchEffect[] = []
  if (
    event.type === "turn.started" &&
    conversation.activeTurnId === event.turnId
  ) {
    const scheduled = scheduleQueued(composer, event.threadId, event.turnId)
    composer = scheduled.composer
    if (scheduled.effect) effects.push(scheduled.effect)
  }
  if (event.type === "turn.completed" && priorTurn?.status === "running") {
    const scheduled = scheduleQueued(
      composer,
      event.threadId,
      conversation.activeTurnId,
    )
    composer = scheduled.composer
    if (scheduled.effect) effects.push(scheduled.effect)
  }
  return done(
    updateWorkspace(state, event.threadId, (current) => ({
      ...current,
      conversation,
      canonicalRevision:
        conversation === current.conversation
          ? current.canonicalRevision
          : current.canonicalRevision + 1,
      transcript,
      composer,
    })),
    ...effects,
  )
}

export function forkWorkspace(
  source: ThreadWorkspace,
  nextThreadId: ThreadId,
  throughTurnId: TurnId,
): ThreadWorkspace | undefined {
  const conversation = forkConversation(
    source.conversation,
    nextThreadId,
    throughTurnId,
  )
  if (!conversation) return undefined
  let transcript = initialTranscript()
  for (const turn of conversation.turnIds) {
    for (const itemId of conversation.turns[turn]?.itemIds ?? []) {
      const item = conversation.items[itemId]
      if (item) transcript = syncTranscriptItem(transcript, item)
    }
  }
  const retained = (location: import("@vimex/transcript").JumpLocation) =>
    Boolean(transcript.projectionById[location.point.itemId])
  transcript = {
    ...transcript,
    folded: persistentTranscriptFolds(
      Object.fromEntries(
        transcript.order
          .filter(
            (id) =>
              transcript.projectionById[id]?.nodeKind !== "message" &&
              Object.hasOwn(source.transcript.folded, id),
          )
          .map((id) => [id, source.transcript.folded[id]!]),
      ),
    ),
    foldDefaults: source.transcript.foldDefaults,
    marks: Object.fromEntries(
      Object.entries(source.transcript.marks).filter(([, location]) =>
        retained(location),
      ),
    ),
    jumps: {
      back: source.transcript.jumps.back.filter(retained),
      forward: source.transcript.jumps.forward.filter(retained),
    },
  }
  return {
    conversation,
    canonicalGeneration: 0,
    canonicalRevision: conversation.turnIds.length ? 1 : 0,
    transcript,
    composer: initialComposer(),
    interaction: initialInteraction(),
  }
}
