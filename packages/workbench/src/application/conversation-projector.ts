import { forkConversation, reduceConversation, type ConversationEvent, type ThreadId, type TurnId } from "@vimex/conversation"
import { initialTranscript, syncTranscriptItem } from "@vimex/transcript"
import { initialComposer } from "@vimex/composer"
import { initialInteraction } from "@vimex/interaction"
import { done, updateWorkspace, type ThreadWorkspace, type WorkbenchEffect, type WorkbenchState, type WorkbenchTransition } from "./workbench-state"
import { scheduleQueued } from "./submission-scheduler"
export function applyConversationEvent(state: WorkbenchState, event: ConversationEvent): WorkbenchTransition {
  const workspace = state.workspaces[event.threadId]
  if (!workspace) return done(state)
  const priorTurn = event.type === "turn.completed" ? workspace.conversation.turns[event.turnId] : undefined
  const conversation = reduceConversation(workspace.conversation, event)
  let transcript = workspace.transcript
  if (event.type === "item.started" || event.type === "item.completed") transcript = syncTranscriptItem(transcript, event.item)
  if (event.type === "item.delta") {
    const item = conversation.items[event.itemId]
    if (item) transcript = syncTranscriptItem(transcript, item)
  }
  let composer = workspace.composer
  const effects: WorkbenchEffect[] = []
  if (event.type === "turn.started" && conversation.activeTurnId === event.turnId) {
    const scheduled = scheduleQueued(composer, event.threadId, event.turnId)
    composer = scheduled.composer
    if (scheduled.effect) effects.push(scheduled.effect)
  }
  if (event.type === "turn.completed" && priorTurn?.status === "running") {
    const scheduled = scheduleQueued(composer, event.threadId)
    composer = scheduled.composer
    if (scheduled.effect) effects.push(scheduled.effect)
  }
  return done(updateWorkspace(state, event.threadId, (current) => ({ ...current, conversation, transcript, composer })), ...effects)
}

export function forkWorkspace(source: ThreadWorkspace, nextThreadId: ThreadId, throughTurnId: TurnId): ThreadWorkspace | undefined {
  const conversation = forkConversation(source.conversation, nextThreadId, throughTurnId)
  if (!conversation) return undefined
  let transcript = initialTranscript()
  for (const turn of conversation.turnIds) {
    for (const itemId of conversation.turns[turn]?.itemIds ?? []) {
      const item = conversation.items[itemId]
      if (item) transcript = syncTranscriptItem(transcript, item)
    }
  }
  transcript = { ...transcript, folded: Object.fromEntries(transcript.order.filter((id) => source.transcript.folded[id]).map((id) => [id, true])) }
  return { conversation, transcript, composer: initialComposer(), interaction: initialInteraction() }
}
