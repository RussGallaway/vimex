import { observeCompaction, observeCompactionTurn } from "./compaction"
import { acknowledgeOutgoing, failOutgoing, retryOutgoing, submitDraft, updateDraft } from "@vimex/composer"
import { reduceInteraction } from "@vimex/interaction"
import { clearSelection, initialTranscript, reduceTranscript, selectedText, urlAt } from "@vimex/transcript"
import { failApproval, receiveApproval, resolveApproval, resolvingApproval } from "@vimex/approvals"
import { applyConversationEvent, forkWorkspace } from "./conversation-projector"
import { scheduleQueued, submissionEffect } from "./submission-scheduler"
import { createWorkspace, done, openThread, targetThread, updateWorkspace, type WorkbenchCommand, type WorkbenchEffect, type WorkbenchState, type WorkbenchTransition } from "./workbench-state"
export function transitionWorkbench(state: WorkbenchState, command: WorkbenchCommand): WorkbenchTransition {
  switch (command.type) {
    case "compaction.observed": return done(observeCompaction(state, command.observation))
    case "turn.interrupt.requested":
      return state.workspaces[command.threadId]?.conversation.activeTurnId === command.turnId
        ? done({ ...state, interruptingTurns: { ...state.interruptingTurns, [command.threadId]: command.turnId } })
        : done(state)
    case "turn.interrupt.failed": {
      if (state.interruptingTurns[command.threadId] !== command.turnId) return done(state)
      const interruptingTurns = { ...state.interruptingTurns }
      delete interruptingTurns[command.threadId]
      return done({ ...state, interruptingTurns })
    }
    case "thread.favorite.toggle": return done({ ...state, favoriteThreadIds: state.favoriteThreadIds.includes(command.threadId) ? state.favoriteThreadIds.filter(id => id !== command.threadId) : [...state.favoriteThreadIds, command.threadId] })
    case "connection.changed": return done({ ...state, connection: command.connection, error: command.error })
    case "thread.open": return done(openThread(state, command.summary))
    case "thread.register": {
      const exists = Boolean(state.summaries[command.summary.id])
      return done({
        ...state,
        threadOrder: exists ? state.threadOrder : [...state.threadOrder, command.summary.id],
        summaries: { ...state.summaries, [command.summary.id]: command.summary },
        workspaces: { ...state.workspaces, [command.summary.id]: state.workspaces[command.summary.id] ?? createWorkspace(command.summary.id) },
      })
    }
    case "thread.switch": return state.workspaces[command.threadId]
      ? done({ ...state, activeThreadId: command.threadId, pendingFork: undefined, urlChoices: undefined })
      : done(state)
    case "thread.close": {
      if (!state.workspaces[command.threadId]) return done(state)
      const compactingThreads = { ...state.compactingThreads }; delete compactingThreads[command.threadId]
      const workspaces = { ...state.workspaces }; delete workspaces[command.threadId]
      const summaries = { ...state.summaries }; delete summaries[command.threadId]
      const threadOrder = state.threadOrder.filter((id) => id !== command.threadId)
      const activeThreadId = state.activeThreadId === command.threadId ? threadOrder[0] : state.activeThreadId
      return done({ ...state, compactingThreads, workspaces, summaries, threadOrder, activeThreadId })
    }
    case "thread.summary.patch": {
      const summary = state.summaries[command.threadId]
      return summary ? done({ ...state, summaries: { ...state.summaries, [command.threadId]: { ...summary, ...command.patch, id: command.threadId } } }) : done(state)
    }
    case "thread.fork.request": {
      const turn = state.workspaces[command.threadId]?.conversation.turns[command.throughTurnId]
      return turn && turn.status !== "running"
        ? done(state, { type: "conversation.thread.fork", threadId: command.threadId, throughTurnId: command.throughTurnId })
        : done(state)
    }
    case "thread.fork.completed": {
      const source = state.workspaces[command.sourceThreadId]
      const workspace = source ? forkWorkspace(source, command.summary.id, command.throughTurnId) : undefined
      if (!workspace) return done(state)
      return done({
        ...state,
        activeThreadId: command.summary.id,
        threadOrder: [command.summary.id, ...state.threadOrder.filter((id) => id !== command.summary.id)],
        summaries: { ...state.summaries, [command.summary.id]: command.summary },
        workspaces: { ...state.workspaces, [command.summary.id]: workspace },
      })
    }
    case "conversation.event": {
      const result = applyConversationEvent(observeCompactionTurn(state, command.event), command.event)
      if (command.event.type !== "turn.completed" || result.state.interruptingTurns[command.event.threadId] !== command.event.turnId) return result
      const interruptingTurns = { ...result.state.interruptingTurns }
      delete interruptingTurns[command.event.threadId]
      return { ...result, state: { ...result.state, interruptingTurns } }
    }
    case "interaction.command": {
      const id = targetThread(state, command.threadId)
      return id ? done(updateWorkspace(state, id, (workspace) => ({ ...workspace, interaction: reduceInteraction(workspace.interaction, command.command) }))) : done(state)
    }
    case "transcript.command": {
      const id = targetThread(state, command.threadId)
      if (!id) return done(state)
      const workspace = state.workspaces[id]
      if (!workspace) return done(state)
      const transcript = reduceTranscript(workspace.transcript, command.command)
      const next = updateWorkspace(state, id, (current) => transcript === current.transcript ? current : { ...current, transcript })
      const restores = command.command.type.startsWith("fold.") ? [{ type: "viewport.restore" as const, threadId: id, anchor: workspace.transcript.viewport }] : []
      return done(next, ...restores)
    }
    case "transcript.yank": {
      const id = targetThread(state, command.threadId)
      const workspace = id ? state.workspaces[id] : undefined
      const text = workspace ? selectedText(workspace.transcript, command.format) : undefined
      if (!id || !workspace || text === undefined) return done(state)
      const shape = workspace.transcript.selection?.shape === "line" ? "line" : "character"
      // Line registers store content without the final line delimiter; the
      // composer adds that delimiter when placing the register between lines.
      const registerText = shape === "line" ? text.replace(/\n$/, "") : text
      return done(updateWorkspace(state, id, (current) => ({
        ...current,
        transcript: clearSelection(current.transcript),
        interaction: reduceInteraction(reduceInteraction(current.interaction, { type: "register.set", register: { text: registerText, shape } }), { type: "mode.normal" }),
      })), { type: "clipboard.write", text })
    }
    case "transcript.url.open": {
      const id = targetThread(state, command.threadId)
      const url = id ? urlAt(state.workspaces[id]?.transcript ?? initialTranscript()) : undefined
      return url ? done(state, { type: "url.open", url }) : done(state)
    }
    case "composer.change": {
      const id = targetThread(state, command.threadId)
      return id ? done(updateWorkspace(state, id, (workspace) => ({ ...workspace, composer: updateDraft(workspace.composer, command.text, command.cursorOffset) }))) : done(state)
    }
    case "composer.submit": {
      const id = targetThread(state, command.threadId)
      const workspace = id ? state.workspaces[id] : undefined
      if (!id || !workspace) return done(state)
      if (state.compactingThreads[id]) return done({ ...state, error: "Wait for compaction to finish before sending; your draft is preserved" })
      const activeTurnId = workspace.conversation.activeTurnId
      const startingTurn = workspace.composer.outbox.some((message) => message.intent === "next-turn" && message.status === "sending")
      const queued = command.intent === "next-turn" ? Boolean(activeTurnId) || startingTurn : !activeTurnId && startingTurn
      const composer = submitDraft(workspace.composer, command.intent, queued, command.clientMessageId)
      if (composer === workspace.composer) return done(state)
      const outgoing = composer.outbox.find((message) => message.id === command.clientMessageId)
      const next = updateWorkspace(state, id, (current) => ({ ...current, composer }))
      if (!outgoing || outgoing.status === "queued") return done(next)
      const effect = submissionEffect(id, composer, outgoing.id, activeTurnId)
      return effect ? done(next, effect) : done(next)
    }
    case "composer.ack":
    case "composer.fail": {
      const workspace = state.workspaces[command.threadId]
      if (!workspace) return done(state)
      const outgoing = workspace.composer.outbox.find(message => message.id === command.clientMessageId)
      const settled = command.type === "composer.ack"
        ? acknowledgeOutgoing(workspace.composer, command.clientMessageId)
        : failOutgoing(workspace.composer, command.clientMessageId, command.reason)
      // A start-turn acknowledgement may precede turn.started. Keep queued
      // steering serialized until the runtime has supplied the real turn id.
      const acknowledgedTurn = command.type === "composer.ack" && command.turnId ? workspace.conversation.turns[command.turnId] : undefined
      const waitForStartedTurn = command.type === "composer.ack"
        && outgoing?.intent === "next-turn"
        && !workspace.conversation.activeTurnId
        && !(acknowledgedTurn && acknowledgedTurn.status !== "running")
      const scheduled = waitForStartedTurn
        ? { composer: settled }
        : scheduleQueued(settled, command.threadId, workspace.conversation.activeTurnId)
      const next = updateWorkspace(state, command.threadId, (current) => ({ ...current, composer: scheduled.composer }))
      return scheduled.effect ? done(next, scheduled.effect) : done(next)
    }
    case "composer.retry": {
      const id = targetThread(state, command.threadId)
      const workspace = id ? state.workspaces[id] : undefined
      const outgoing = workspace?.composer.outbox.find((message) => message.id === command.clientMessageId)
      if (!id || !workspace || !outgoing || outgoing.status !== "failed") return done(state)
      if (state.compactingThreads[id]) return done({ ...state, error: "Wait for compaction to finish before sending; your draft is preserved" })
      const activeTurnId = workspace.conversation.activeTurnId
      const startingTurn = workspace.composer.outbox.some((message) => message.id !== outgoing.id && message.intent === "next-turn" && message.status === "sending")
      const queued = outgoing.intent === "next-turn" ? Boolean(activeTurnId) || startingTurn : !activeTurnId && startingTurn
      const composer = retryOutgoing(workspace.composer, outgoing.id, queued)
      const next = updateWorkspace(state, id, (current) => ({ ...current, composer }))
      const effect = submissionEffect(id, composer, outgoing.id, activeTurnId)
      return effect ? done(next, effect) : done(next)
    }
    case "approval.received": return done({ ...state, approvals: receiveApproval(state.approvals, command.approval) })
    case "approval.resolve": {
      const approval = state.approvals.byId[command.approvalId]
      if (!approval || (approval.status !== "pending" && approval.status !== "failed") || !approval.choices.some((choice) => choice.id === command.choiceId)) return done(state)
      return done({ ...state, approvals: resolvingApproval(state.approvals, command.approvalId) }, {
        type: "approval.resolve", approvalId: command.approvalId, choiceId: command.choiceId,
      })
    }
    case "approval.resolved": return done({ ...state, approvals: resolveApproval(state.approvals, command.approvalId) })
    case "approval.failed": return done({ ...state, approvals: failApproval(state.approvals, command.approvalId, command.error) })
    case "question.received": return done({ ...state, questions: { ...state.questions, [command.request.id]: command.request } })
    case "question.resolved": {
      if (!state.questions[command.id]) return done(state)
      const questions = { ...state.questions }
      delete questions[command.id]
      return done({ ...state, questions })
    }
    case "agent.link": {
      const duplicate = state.agentRelationships.some(link => link.parentId === command.link.parentId
        && link.childId === command.link.childId && link.itemId === command.link.itemId && link.relation === command.link.relation)
      return duplicate ? done(state) : done({ ...state, agentRelationships: [...state.agentRelationships, command.link] })
    }
  }
}
