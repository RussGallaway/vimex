import { compactionBlockReason } from "./compaction"
import { executeGoalCommand } from "./goal-command"
import { SideChatCoordinator, type SideChatAction } from "./side-chat"
import { adjacentSearchMatch, findSearchMatches, firstContentPoint, moveByWord, moveBySemanticBlock, moveByUrl, referenceText, urlAt, urlCandidates, graphemeCount, type LogicalPoint } from "@vimex/transcript"
import { isThemeName, themeNames, type PreferenceStore } from "./display-preferences"
import { parseCommand, validateCommand, resolveCommandName, commandDescriptors, type ExCommand } from "@vimex/interaction"
import { captureLocalState, emptyLocalState, restoreThreadView, type LocalState, type SavedThreadView } from "./local-state"
import { initialWorkbench, activeWorkspace, createWorkspace, type WorkbenchState, type WorkbenchCommand, type WorkbenchEffect } from "./workbench-state"
import { transitionWorkbench } from "./reduce-workbench"
import { forkBoundary, threadId, type ThreadId, type TurnId, type ItemId, type ConversationEvent } from "@vimex/conversation"
import type { ConversationGateway, SessionSnapshot } from "@vimex/conversation"
import type { ApprovalGateway } from "@vimex/approvals"
import type { RuntimeConnection, RuntimeEvent } from "./runtime-connection"
import type { AvailableModel, ModelCatalog } from "./model-catalog"
import type { WorkbenchActions, TranscriptAction } from "./workbench-actions"
import { validateAnswers } from "@vimex/approvals"
import type { DisplayPreferences } from "./display-preferences"
import { createRpcEventReplay } from "./rpc-event-replay"
import { NavigationHistory, navigationLocation, restoreNavigationLocation, hasRecordedJump, type NavigationLocation } from "./navigation-history"
import { invalidateRuntimeState } from "./runtime-recovery"

export interface ControllerPorts {
  conversation: ConversationGateway
  approvals: ApprovalGateway
  connection: RuntimeConnection
  models: ModelCatalog
  resolveDirectory(base: string, path: string): string
  clipboard: { writeText(text: string): Promise<void> }
  openUrl(url: string): Promise<void>
  quit(): void
  onState?(state: WorkbenchState): void
  localState?: LocalState
  preferences?: PreferenceStore
  busySubmit?: "queue" | "steer"
}
export class VimexController implements WorkbenchActions {
  private state = initialWorkbench()
  private readonly sides = new SideChatCoordinator({
    state: () => this.state,
    update: side => {
      let next = { ...this.state, sideChats: { ...this.state.sideChats, [side.parentId]: side } }
      const workspace = side.threadId ? next.workspaces[side.threadId] : undefined
      if (side.status === "quitting" && side.threadId && workspace) next = { ...next, workspaces: { ...next.workspaces, [side.threadId]: {
        ...workspace, composer: { ...workspace.composer, outbox: workspace.composer.outbox.map(message => message.status === "queued" ? { ...message, status: "failed" as const, reason: "Canceled because side chat is quitting; retry explicitly if retirement fails" } : message) },
      } } }
      this.setState(next)
    },
    discard: parent => {
      const sideChats = { ...this.state.sideChats }; delete sideChats[parent]
      this.setState({ ...this.state, sideChats })
    },
    remove: (parent, retired) => {
      const sideChats = { ...this.state.sideChats }; delete sideChats[parent]
      const summaries = { ...this.state.summaries }; delete summaries[retired]
      const workspaces = { ...this.state.workspaces }; delete workspaces[retired]
      this.navigationHistory.removeThread(retired)
      this.loaded.delete(retired); this.buffered.delete(retired)
      const approvals = { order: this.state.approvals.order.filter(id => this.state.approvals.byId[id]?.threadId !== retired), byId: Object.fromEntries(Object.entries(this.state.approvals.byId).filter(([, approval]) => approval.threadId !== retired)) }
      const compactingThreads = { ...this.state.compactingThreads }; delete compactingThreads[retired]
      const interruptingTurns = { ...this.state.interruptingTurns }; delete interruptingTurns[retired]
      const questions = Object.fromEntries(Object.entries(this.state.questions).filter(([, request]) => request.threadId !== retired))
      this.setState({ ...this.state, sideChats, summaries, workspaces, approvals, questions, compactingThreads, interruptingTurns,
        threadOrder: this.state.threadOrder.filter(id => id !== retired),
        favoriteThreadIds: this.state.favoriteThreadIds.filter(id => id !== retired),
        agentRelationships: this.state.agentRelationships.filter(link => link.childId !== retired && link.parentId !== retired),
        retiredSideThreadIds: [...new Set([...this.state.retiredSideThreadIds, retired])] })
    },
    focus: id => { this.historyNavigation = undefined; return this.navigateThread(id) },
    hydrate: snapshot => this.hydrate(snapshot, false),
    fork: async parent => {
      if (!this.ports.conversation.forkSideThread) throw new Error("This runtime cannot create side chats")
      const epoch = this.runtimeEpoch
      const snapshot = await this.ports.conversation.forkSideThread(parent)
      if (!this.currentRuntime(epoch)) throw new Error("Runtime changed while creating side chat")
      return snapshot
    },
    retire: async id => {
      if (!this.ports.conversation.retireThread) throw new Error("This runtime cannot retire side chats")
      const epoch = this.runtimeEpoch
      const assertRuntime = () => { if (!this.currentRuntime(epoch)) throw new Error("Runtime changed while quitting side chat") }
      await Promise.all([...(this.threadContinuations.get(id) ?? []), this.threadMutations.get(id)?.catch(() => {})])
      assertRuntime()
      if (!this.loaded.has(id)) {
        const epoch = this.runtimeEpoch
        const snapshot = await this.ports.conversation.resumeThread(id)
        if (!this.currentRuntime(epoch)) throw new Error("Runtime changed while quitting side chat")
        this.hydrate(snapshot, false)
      }
      await this.ports.conversation.clearGoal?.(id)
      assertRuntime()
      const turn = this.state.workspaces[id]?.conversation.activeTurnId
      if (turn) await this.ports.conversation.interruptTurn(id, turn)
      assertRuntime()
      await this.ports.conversation.retireThread(id)
      assertRuntime()
    },
    send: (id, text) => {
      if (this.state.compactingThreads[id]) { this.notice("Wait for side chat compaction before sending a question"); return }
      if (!this.loaded.has(id)) { this.notice("Open the side chat successfully before sending a question"); return }
      const draft = this.state.workspaces[id]?.composer
      this.dispatch({ type: "composer.change", threadId: id, text })
      this.dispatch({ type: "composer.submit", threadId: id, intent: "next-turn", clientMessageId: crypto.randomUUID() })
      if (draft?.text) this.dispatch({ type: "composer.change", threadId: id, text: draft.text, cursorOffset: draft.cursorOffset })
    },
    quote: (id, text) => {
      const previous = this.state.workspaces[id]?.composer.text ?? ""
      const next = `${previous}${previous ? "\n\n" : ""}${text.split("\n").map(line => `> ${line}`).join("\n")}`
      this.dispatch({ type: "composer.change", threadId: id, text: next, cursorOffset: next.length })
      this.dispatch({ type: "interaction.command", threadId: id, command: { type: "focus.set", surface: "composer" } })
    },
    notice: message => this.notice(message),
    launch: operation => { this.launch(operation) },
  })
  sideChat = (action: SideChatAction, question?: string): void => this.sides.action(action, question)
  anchorThread = (id: ThreadId, point: LogicalPoint, preferredScreenRow: number): void => {
    this.dispatch({ type: "transcript.command", threadId: id, command: { type: "viewport.anchor", point, preferredScreenRow } })
  }
  private readonly listeners = new Set<() => void>()
  private readonly pending = new Set<Promise<void>>()
  private readonly threadContinuations = new Map<ThreadId, Set<Promise<void>>>()
  private readonly loaded = new Set<ThreadId>()
  private readonly buffered = new Map<ThreadId, ConversationEvent[]>()
  private readonly resumes = new Map<ThreadId, Promise<SessionSnapshot>>()
  private unsubscribe?: () => void
  private catalogRequest?: { epoch: number; promise: Promise<readonly AvailableModel[]> }
  private readonly navigationHistory = new NavigationHistory()
  private restoringNavigation = false
  private historyNavigation?: { queue: ("back" | "forward")[] }
  private navigationRevision = 0
  private initialization?: Promise<void>
  private restartPending = false
  private restartBarrier?: Promise<void>
  private runtimeEpoch = 0
  private readonly answering = new Map<string, symbol>()
  private readonly parentReturns = new Map<ThreadId, ThreadId>()
  private readonly threadMutations = new Map<ThreadId, Promise<void>>()
  private preferenceTail: Promise<void> = Promise.resolve()
  private preferenceRevision = 0
  private desiredPreferences?: DisplayPreferences
  private recoveryViews: Record<string, SavedThreadView> = {}
  private initialDirectory?: string
  private initialModel?: string
  private closing = false
  private closePromise?: Promise<void>
  private signalClosing!: () => void
  private readonly closingSignal = new Promise<void>(resolve => { this.signalClosing = resolve })
  constructor(private readonly ports: ControllerPorts) {
    this.state = { ...this.state, favoriteThreadIds: [...new Set(ports.localState?.favoriteThreadIds ?? [])].map(threadId), sideChats: ports.localState?.sideChats ?? {}, retiredSideThreadIds: (ports.localState?.retiredSideThreadIds ?? []).map(threadId) }
    if (ports.preferences) {
      this.desiredPreferences = ports.preferences.initial
      this.state = { ...this.state, preferences: ports.preferences.initial }
    }
  }
  getSnapshot = (): WorkbenchState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  private setState(state: WorkbenchState): void {
    if (this.closing) return
    if (this.state === state) return
    this.state = state
    for (const listener of this.listeners) listener()
    this.ports.onState?.(state)
  }
  private retiringThread(id: ThreadId): boolean {
    return this.state.retiredSideThreadIds.includes(id) || Object.values(this.state.sideChats).some(side => side.threadId === id && side.status === "quitting")
  }
  private trackContinuation(id: ThreadId, pending: Promise<void> | undefined): void {
    if (!pending) return
    const continuations = this.threadContinuations.get(id) ?? new Set<Promise<void>>()
    continuations.add(pending); this.threadContinuations.set(id, continuations)
    void pending.finally(() => { continuations.delete(pending); if (!continuations.size) this.threadContinuations.delete(id) })
  }
  dispatch(command: WorkbenchCommand): void {
    if (this.closing) return
    if ("threadId" in command && command.threadId && this.state.retiredSideThreadIds.includes(command.threadId)) return
    if (command.type === "conversation.event" && this.state.retiredSideThreadIds.includes(command.event.threadId)) return
    const recipient = command.type === "composer.submit" || command.type === "composer.retry" ? command.threadId ?? this.state.activeThreadId
      : command.type === "approval.resolve" ? this.state.approvals.byId[command.approvalId]?.threadId : undefined
    if (recipient && this.retiringThread(recipient)) { this.notice("Side chat is quitting; new work is paused"); return }
    const before = this.state
    const result = transitionWorkbench(before, command)
    if (command.type === "conversation.event") this.navigationHistory.reproject(before, result.state, command.event.threadId)
    const localJump = command.type === "transcript.command" && (command.command.type === "jump.to" || command.command.type === "mark.jump")
      && hasRecordedJump(before, result.state)
    const switched = before.activeThreadId !== result.state.activeThreadId
    if (!this.restoringNavigation && (localJump || switched)) {
      this.navigationHistory.seed(before)
      const origin = navigationLocation(before)
      if (origin) {
        const explicit = command.type === "transcript.command" && "origin" in command.command ? command.command.origin : undefined
        this.navigationHistory.record(explicit ? { ...origin, cursor: explicit.point, viewport: { kind: "point", ...explicit } } : origin)
      }
      if (localJump) { this.navigationRevision++; this.historyNavigation = undefined }
    }
    this.setState(result.state)
    for (const effect of result.effects) {
      const pending = this.launch(() => this.effect(effect))
      if (effect.type === "conversation.turn.start" || effect.type === "conversation.turn.steer") this.trackContinuation(effect.threadId, pending)
      if (effect.type === "approval.resolve") {
        const id = before.approvals.byId[effect.approvalId]?.threadId
        if (id) this.trackContinuation(id, pending)
      }
    }
  }
  private launch(operation: () => Promise<void>): Promise<void> | undefined {
    if (this.closing) return undefined
    const promise = (async () => operation())().catch(error => {
      if (!this.closing) this.notice(error instanceof Error ? error.message : String(error))
    })
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise))
    return promise
  }
  async settle(): Promise<void> { while (this.pending.size) await Promise.all([...this.pending]) }
  notice(message: string): void { this.setState({ ...this.state, error: message }) }

  private register(summary: SessionSnapshot["summary"]): void {
    if (!this.state.retiredSideThreadIds.includes(summary.id)) this.dispatch({ type: "thread.register", summary })
  }
  private async unlessClosing<T>(operation: Promise<T>): Promise<{ value: T } | undefined> {
    return Promise.race([
      operation.then(value => ({ value })),
      this.closingSignal.then(() => undefined),
    ])
  }
  private currentRuntime(epoch: number): boolean { return !this.closing && epoch === this.runtimeEpoch }
  private hydrate(snapshot: SessionSnapshot, focus: boolean): void {
    if (this.state.retiredSideThreadIds.includes(snapshot.summary.id)) return
    this.register(snapshot.summary)
    const side = Object.values(this.state.sideChats).find(side => side.threadId === snapshot.summary.id)
    const parentTurns = side && this.state.workspaces[side.parentId]?.conversation.turns
    if (side && side.inheritedTurnIds === undefined && parentTurns && Object.keys(parentTurns).length) {
      const inheritedTurnIds = [...new Set(snapshot.events.flatMap(event => "turnId" in event ? [event.turnId] : "item" in event ? [event.item.turnId] : []))].filter(id => parentTurns[id])
      this.setState({ ...this.state, sideChats: { ...this.state.sideChats, [side.parentId]: { ...side, inheritedTurnIds } } })
    }
    if (this.recoveryViews[snapshot.summary.id] && !this.loaded.has(snapshot.summary.id)) {
      this.setState({ ...this.state, workspaces: { ...this.state.workspaces, [snapshot.summary.id]: createWorkspace(snapshot.summary.id) } })
    }
    for (const event of snapshot.events) this.dispatch({ type: "conversation.event", event })
    const saved = this.recoveryViews[snapshot.summary.id] ?? this.ports.localState?.threads[snapshot.summary.id]
    const workspace = this.state.workspaces[snapshot.summary.id]
    if (saved && workspace && !this.loaded.has(snapshot.summary.id)) this.setState({ ...this.state, workspaces: { ...this.state.workspaces, [snapshot.summary.id]: restoreThreadView(workspace, saved) } })
    delete this.recoveryViews[snapshot.summary.id]
    this.loaded.add(snapshot.summary.id)
    const buffered = this.buffered.get(snapshot.summary.id) ?? []
    this.buffered.delete(snapshot.summary.id)
    for (const event of buffered) this.dispatch({ type: "conversation.event", event })
    if (focus) this.dispatch({ type: "thread.switch", threadId: snapshot.summary.id })
  }
  initialize(cwd: string, model?: string, resume?: string): Promise<void> {
    if (this.closing) return Promise.resolve()
    return this.initialization ??= this.runInitialize(cwd, model, resume)
  }
  private async runInitialize(cwd: string, model?: string, resume?: string): Promise<void> {
    const epoch = this.runtimeEpoch
    const navigation = this.navigationRevision
    this.initialDirectory = cwd
    this.initialModel = model
    this.unsubscribe = this.ports.connection.subscribe(event => this.receive(event))
    try {
      if (!await this.unlessClosing(this.ports.connection.connect()) || !this.currentRuntime(epoch)) return
      this.dispatch({ type: "connection.changed", connection: "connected" })
      const summaries = await this.unlessClosing(this.ports.conversation.listThreads())
      if (!summaries || !this.currentRuntime(epoch)) return
      for (const summary of summaries.value) this.register(summary)
      if (resume && this.state.retiredSideThreadIds.includes(threadId(resume))) throw new Error("This side chat was quit and cannot be reopened")
      const snapshot = await this.unlessClosing(resume ? this.ports.conversation.resumeThread(threadId(resume)) : this.ports.conversation.startThread(cwd, model))
      if (!snapshot || !this.currentRuntime(epoch)) return
      this.hydrate(snapshot.value, navigation === this.navigationRevision)
    } catch (error) {
      if (!this.currentRuntime(epoch)) return
      this.dispatch({ type: "connection.changed", connection: "error", error: String(error) })
      throw error
    }
  }
  private receive(event: RuntimeEvent): void {
    if (event.type === "conversation" && this.state.retiredSideThreadIds.includes(event.event.threadId)) return
    if (event.type === "subagent.link" && (this.state.retiredSideThreadIds.includes(event.link.childId) || this.state.retiredSideThreadIds.includes(event.link.parentId))) return
    if (event.type === "approval" && this.state.retiredSideThreadIds.includes(event.approval.threadId)) return
    if (event.type === "question.requested" && this.state.retiredSideThreadIds.includes(event.request.threadId)) return
    switch (event.type) {
      case "compaction": this.dispatch({ type: "compaction.observed", observation: event }); break
      case "question.requested": this.dispatch({ type: "question.received", request: event.request }); break
      case "question.resolved": this.dispatch({ type: "question.resolved", id: event.id }); break
      case "subagent.link": this.dispatch({ type: "agent.link", link: event.link }); break
      case "conversation":
        if (!this.loaded.has(event.event.threadId)) {
          const queue = this.buffered.get(event.event.threadId) ?? []
          queue.push(event.event)
          this.buffered.set(event.event.threadId, queue)
        } else this.dispatch({ type: "conversation.event", event: event.event })
        break
      case "summary": this.register(event.summary); break
      case "metadata": this.dispatch({ type: "thread.summary.patch", threadId: event.threadId, patch: event.patch }); break
      case "approval": this.dispatch({ type: "approval.received", approval: event.approval }); break
      case "approval.resolved": this.dispatch({ type: "approval.resolved", approvalId: event.id }); break
      case "disconnected": {
        // Restart already invalidated the old runtime and owns this connecting state.
        if (event.reason === "restart" && this.restartPending) break
        this.historyNavigation = undefined
        this.runtimeEpoch++
        this.navigationRevision++
        const result = transitionWorkbench(this.state, { type: "connection.changed", connection: "disconnected", error: event.message })
        this.answering.clear()
        this.threadMutations.clear()
        this.setState(invalidateRuntimeState(result.state))
        break
      }
      case "notice": this.notice(event.message); break
      default: { const unreachable: never = event; throw new Error(`Unhandled runtime event: ${String(unreachable)}`) }
    }
  }
  private loadModels() {
    const epoch = this.runtimeEpoch
    if (this.catalogRequest?.epoch === epoch) return this.catalogRequest.promise
    this.setState({ ...this.state, modelCatalogError: undefined })
    const promise = this.ports.models.listModels().then(models => {
      if (this.currentRuntime(epoch)) this.setState({ ...this.state, availableModels: models, modelCatalogError: undefined })
      return models
    }).catch(error => {
      if (this.currentRuntime(epoch)) this.setState({ ...this.state, modelCatalogError: error instanceof Error ? error.message : String(error) })
      if (this.catalogRequest?.promise === promise) this.catalogRequest = undefined
      throw error
    })
    this.catalogRequest = { epoch, promise }
    return promise
  }
  dispatchInteraction: WorkbenchActions["dispatchInteraction"] = command => {
    this.dispatch({ type: "interaction.command", command })
    if (command.type === "mode.command" || (command.type === "overlay.open" && command.overlay === "models")) {
      this.launch(async () => { await this.loadModels() })
    }
  }
  changeDraft: WorkbenchActions["changeDraft"] = (text, cursorOffset) => {
    this.dispatch({ type: "composer.change", text, cursorOffset })
    if (/^\/(?:models?|thinking)(?:\s|$)/.test(text) && !this.catalogRequest) this.launch(async () => { await this.loadModels() })
  }
  submit: WorkbenchActions["submit"] = intent => this.dispatch({ type: "composer.submit", intent, clientMessageId: crypto.randomUUID() })
  retryOutgoing = (id: string): void => this.dispatch({ type: "composer.retry", clientMessageId: id })
  copyText = (text: string): void => { this.launch(() => this.ports.clipboard.writeText(text)) }
  resolveApproval: WorkbenchActions["resolveApproval"] = (approvalId, choiceId) => {
    const approval = this.state.approvals.byId[approvalId]
    if (!approval) return
    if (approval.threadId !== this.state.activeThreadId) {
      this.notice("Open the approval from its active session before responding")
      return
    }
    this.dispatch({ type: "approval.resolve", approvalId, choiceId })
  }
  answerQuestions = (id: string, answers: Readonly<Record<string, string | readonly string[]>>): void => {
    const request = this.state.questions[id]
    if (!request || this.answering.has(id)) return
    if (this.retiringThread(request.threadId)) { this.notice("Side chat is quitting; new work is paused"); return }
    if (request.threadId !== this.state.activeThreadId) {
      this.notice("Open the question's session before responding")
      return
    }
    const token = Symbol(id)
    const epoch = this.runtimeEpoch
    this.answering.set(id, token)
    const response = this.launch(async () => {
      try {
        validateAnswers(request, answers)
        if (!this.ports.approvals.respondToQuestions) throw new Error("This runtime cannot answer questions")
        await this.ports.approvals.respondToQuestions(id, answers)
        if (this.currentRuntime(epoch) && this.answering.get(id) === token && this.state.questions[id] === request) {
          this.dispatch({ type: "question.resolved", id })
        }
      } catch (error) {
        if (this.currentRuntime(epoch) && this.answering.get(id) === token) throw error
      } finally {
        if (this.answering.get(id) === token) this.answering.delete(id)
      }
    })
    this.trackContinuation(request.threadId, response)
  }
  requestFork = (selected?: ItemId): void => {
    const workspace = activeWorkspace(this.state)
    const boundary = workspace && forkBoundary(workspace.conversation, selected ?? workspace.transcript.cursor?.itemId)
    if (!boundary) { this.notice("Select a user message from a completed turn to fork"); return }
    this.setState({ ...this.state, pendingFork: boundary })
    this.dispatchInteraction({ type: "overlay.open", overlay: "fork" })
  }
  cancelFork = (): void => {
    this.setState({ ...this.state, pendingFork: undefined })
    this.dispatchInteraction({ type: "overlay.close" })
  }
  confirmFork = (): void => {
    const boundary = this.state.pendingFork
    if (!boundary || this.state.activeThreadId !== boundary.threadId) { this.cancelFork(); return }
    this.cancelFork()
    this.dispatch({ type: "thread.fork.request", threadId: boundary.threadId, throughTurnId: boundary.turnId })
  }
  openChildThread = (id: ThreadId): void => {
    const parent = this.state.activeThreadId
    if (!parent || !this.state.agentRelationships.some(link => link.parentId === parent && link.childId === id)) { this.notice("This session is not a child of the active thread"); return }
    this.parentReturns.set(id, parent)
    this.dispatchInteraction({ type: "overlay.close" })
    this.openThread(id)
  }
  returnToParent = (): void => {
    const child = this.state.activeThreadId
    const parent = child && (Object.values(this.state.sideChats).find(side => side.threadId === child)?.parentId ?? this.parentReturns.get(child) ?? this.state.agentRelationships.find(link => link.childId === child)?.parentId)
    if (!parent) { this.notice("This session has no known parent"); return }
    this.dispatchInteraction({ type: "overlay.close" })
    this.openThread(parent)
  }
  cycleAgent = (direction: "previous" | "next"): void => {
    const active = this.state.activeThreadId
    if (!active) return
    const parent = this.parentReturns.get(active) ?? this.state.agentRelationships.find(link => link.childId === active)?.parentId ?? active
    const family = [...new Set([parent, ...this.state.agentRelationships.filter(link => link.parentId === parent).map(link => link.childId)])]
    if (family.length < 2) { this.notice("No other agents in this session family"); return }
    const index = family.indexOf(active)
    const target = family[(index + (direction === "next" ? 1 : family.length - 1)) % family.length]
    if (target) this.openThread(target)
  }
  private clearNavigationIntent(): void {
    if (this.state.pendingFork || this.state.urlChoices) {
      this.setState({ ...this.state, pendingFork: undefined, urlChoices: undefined })
    }
  }
  restart = (): void => {
    if (this.restartPending || this.closing) return
    this.restartPending = true
    this.historyNavigation = undefined
    const epoch = ++this.runtimeEpoch
    const id = this.state.activeThreadId
    this.recoveryViews = captureLocalState(this.state, emptyLocalState()).threads
    const revision = ++this.navigationRevision
    this.clearNavigationIntent()
    this.answering.clear()
    this.loaded.clear()
    this.buffered.clear()
    this.resumes.clear()
    this.threadMutations.clear()
    this.setState({ ...invalidateRuntimeState(this.state), connection: "connecting", error: undefined })
    const operation = this.launch(async () => {
      try {
        // Pending RPCs settle on transport close; never replay their submissions.
        await this.ports.connection.restart()
        if (!this.currentRuntime(epoch)) return
        this.setState({ ...this.state, connection: "connected" })
        if (id) {
          const snapshot = await this.ports.conversation.resumeThread(id)
          if (this.currentRuntime(epoch)) this.hydrate(snapshot, revision === this.navigationRevision)
          const background = new Set(Object.values(this.state.sideChats).flatMap(side => side.threadId ? [side.parentId, side.threadId] : []))
          background.delete(id)
          for (const other of background) {
            if (!this.currentRuntime(epoch)) return
            const resumed = await this.ports.conversation.resumeThread(other)
            if (this.currentRuntime(epoch)) this.hydrate(resumed, false)
          }
        } else if (this.initialDirectory) {
          const snapshot = await this.ports.conversation.startThread(this.initialDirectory, this.initialModel)
          if (this.currentRuntime(epoch)) this.hydrate(snapshot, revision === this.navigationRevision)
        }
      } catch (error) {
        if (!this.currentRuntime(epoch)) return
        this.dispatch({ type: "connection.changed", connection: "error", error: String(error) })
        throw error
      } finally { this.restartPending = false }
    })
    this.restartBarrier = operation
    void operation?.finally(() => { if (this.restartBarrier === operation) this.restartBarrier = undefined })
  }
  toggleFavorite = (id: ThreadId): void => this.dispatch({ type: "thread.favorite.toggle", threadId: id })
  renameThread = (id: ThreadId, title: string): void => {
    const name = title.trim()
    if (!name) { this.notice("A session name cannot be empty"); return }
    this.launchThreadMutation(id, async epoch => {
      await this.ports.conversation.renameThread(id, name)
      if (this.currentRuntime(epoch)) this.dispatch({ type: "thread.summary.patch", threadId: id, patch: { title: name } })
    })
  }
  openThread = (id: ThreadId): void => { this.historyNavigation = undefined; this.navigateThread(id) }
  private navigateHistory(direction: "back" | "forward"): void {
    if (this.historyNavigation) { if (this.historyNavigation.queue.length < 100) this.historyNavigation.queue.push(direction); return }
    this.navigationHistory.seed(this.state)
    const target = this.navigationHistory.peek(direction)
    if (!target) return
    const pending = !this.loaded.has(target.threadId) || Boolean(this.restartBarrier)
    const request = { queue: [] as ("back" | "forward")[] }
    if (pending) this.historyNavigation = request
    const operation = this.navigateThread(target.threadId, { direction, target })
    if (pending) void operation?.finally(() => {
      if (this.historyNavigation !== request) return
      this.historyNavigation = undefined
      if (this.state.activeThreadId !== target.threadId) return
      for (const next of request.queue) this.navigateHistory(next)
    })
  }
  private navigateThread(id: ThreadId, restore?: { direction: "back" | "forward"; target: NavigationLocation }): Promise<void> | undefined {
    if (this.state.retiredSideThreadIds.includes(id)) { this.notice("This side chat was quit and cannot be reopened"); return }
    const revision = ++this.navigationRevision
    const epoch = this.runtimeEpoch
    this.clearNavigationIntent()
    this.dispatchInteraction({ type: "overlay.close" })
    return this.launch(async () => {
      if (this.restartBarrier) await this.restartBarrier
      if (!this.currentRuntime(epoch) || this.state.connection !== "connected") return
      if (!this.loaded.has(id)) {
        let pending = this.resumes.get(id)
        if (!pending) {
          pending = this.ports.conversation.resumeThread(id)
          this.resumes.set(id, pending)
        }
        try {
          let snapshot: SessionSnapshot
          try { snapshot = await pending }
          catch (error) { if (this.currentRuntime(epoch)) throw error; return }
          if (!this.currentRuntime(epoch)) return
          if (!this.loaded.has(id)) this.hydrate(snapshot, false)
        } finally { if (this.resumes.get(id) === pending) this.resumes.delete(id) }
      }
      if (this.currentRuntime(epoch) && revision === this.navigationRevision) {
        const origin = navigationLocation(this.state)
        if (restore && (!origin || !this.navigationHistory.commit(restore.direction, restore.target, origin))) return
        const side = Object.values(this.state.sideChats).find(side => side.threadId === id)
        if (side && !side.visible && side.status !== "quitting") this.setState({ ...this.state, sideChats: { ...this.state.sideChats, [side.parentId]: { ...side, visible: true } } })
        this.restoringNavigation = Boolean(restore)
        try { this.dispatch({ type: "thread.switch", threadId: id }) }
        finally { this.restoringNavigation = false }
        if (restore) this.setState(restoreNavigationLocation(this.state, restore.target))
      }
    })
  }
  interrupt = (): void => {
    const workspace = activeWorkspace(this.state)
    const turn = workspace?.conversation.activeTurnId
    if (!workspace || !turn || this.state.interruptingTurns[workspace.conversation.threadId] === turn) return
    const thread = workspace.conversation.threadId
    this.dispatch({ type: "turn.interrupt.requested", threadId: thread, turnId: turn })
    this.launch(async () => {
      try { await this.ports.conversation.interruptTurn(thread, turn) }
      catch (error) {
        this.dispatch({ type: "turn.interrupt.failed", threadId: thread, turnId: turn })
        throw error
      }
    })
  }
  transcript = (command: TranscriptAction): void => {
    const workspace = activeWorkspace(this.state)
    if (!workspace) return
    const move = (point?: LogicalPoint, record = true) => {
      if (!point) return
      if (workspace.transcript.folded[point.itemId]) this.dispatch({ type: "transcript.command", command: { type: "fold.set", itemId: point.itemId, folded: false } })
      this.dispatch({ type: "transcript.command", command: record ? { type: "jump.to", target: { point, preferredScreenRow: 2 } } : { type: "cursor.move", point, preferredScreenRow: 2 } })
    }
    const preserveVisual = () => workspace.interaction.mode === "visual" && workspace.interaction.surface === "transcript"
    const navigationOrigin = () => workspace.interaction.surface === "transcript" && workspace.transcript.cursor
      ? { point: workspace.transcript.cursor, preferredScreenRow: 0 }
      : workspace.transcript.viewport.kind === "point" ? { point: workspace.transcript.viewport.point, preferredScreenRow: workspace.transcript.viewport.preferredScreenRow } : undefined
    const focusJump = (preserve = preserveVisual()) => {
      if (preserve) return
      this.dispatchInteraction({ type: "mode.normal" })
      this.dispatchInteraction({ type: "focus.set", surface: "transcript" })
    }
    const sameDisplayedLocation = (before: typeof workspace.transcript, after: typeof workspace.transcript | undefined) => before.cursor?.itemId === after?.cursor?.itemId
      && before.cursor?.graphemeOffset === after?.cursor?.graphemeOffset
      && JSON.stringify(before.viewport) === JSON.stringify(after?.viewport)
      && before.folded === after?.folded
    switch (command.type) {
      case "navigate": {
        const direction = command.motion.endsWith("previous") ? "backward" : "forward"
        const count = Math.max(1, command.count ?? 1)
        const transcript = workspace.transcript
        if (command.motion.startsWith("word-") || command.motion.startsWith("WORD-")) {
          const motion = command.motion.endsWith("previous") ? "previous" : command.motion.endsWith("end") ? "end" : "next"
          move(moveByWord(transcript, motion, transcript.cursor, count, command.motion.startsWith("WORD-")), false)
        } else if (command.motion.startsWith("block-")) move(moveBySemanticBlock(transcript, direction, transcript.cursor, count))
        else if (command.motion.startsWith("url-")) move(moveByUrl(transcript, direction, transcript.cursor, { count, wrap: true }))
        else if (command.motion === "first-content") move(firstContentPoint(transcript), false)
        else {
          const origin = transcript.cursor ? transcript.order.indexOf(transcript.cursor.itemId) : -1
          const candidates = transcript.order.filter((id, index) => {
            const item = workspace.conversation.items[id]
            return (item?.kind === "user" || item?.kind === "assistant") && (direction === "forward" ? index > origin : index < origin)
          })
          const id = direction === "forward" ? candidates[count - 1] : candidates[candidates.length - count]
          if (id) move({ itemId: id, graphemeOffset: 0 })
        }
        break
      }
      case "search": {
        const query = command.query || workspace.transcript.search?.query || ""
        this.dispatch({ type: "transcript.command", command: { type: "search.set", query, direction: command.direction } })
        const matches = findSearchMatches(workspace.transcript, query)
        const target = adjacentSearchMatch(workspace.transcript, matches, command.direction)?.from
        move(target)
        if (target) focusJump()
        if (!matches.length) this.notice(`Pattern not found: ${query}`)
        break
      }
      case "search.next": {
        const search = workspace.transcript.search
        if (!search) { this.notice("Search with / or ? first"); break }
        const direction = command.reverse ? (search.direction === "forward" ? "backward" : "forward") : search.direction
        const target = adjacentSearchMatch(workspace.transcript, findSearchMatches(workspace.transcript, search.query), direction, workspace.transcript.cursor, { count: command.count })?.from
        move(target)
        if (target) focusJump()
        break
      }
      case "selection.swap": this.dispatch({ type: "transcript.command", command }); break
      case "reference": {
        const text = referenceText(workspace.transcript, "source")
        if (!text) { this.notice("No transcript content selected"); break }
        const draft = [workspace.composer.text, text.split("\n").map(line => `> ${line}`).join("\n")].filter(Boolean).join("\n\n") + "\n\n"
        this.changeDraft(draft, graphemeCount(draft))
        this.dispatchInteraction({ type: "mode.insert" })
        break
      }
      case "cursor.move": this.dispatch({ type: "transcript.command", command: { type: "cursor.move", point: command.target, preferredScreenRow: command.preferredScreenRow } }); break
      case "jump": {
        if (!workspace.transcript.projectionById[command.target.itemId]) break
        if (!command.extend) this.dispatch({ type: "transcript.command", command: { type: "selection.clear" } })
        const originRow = command.originPreferredScreenRow ?? (command.origin && workspace.transcript.viewport.kind === "point"
          && workspace.transcript.viewport.point.itemId === command.origin.itemId
          && workspace.transcript.viewport.point.graphemeOffset === command.origin.graphemeOffset
          ? workspace.transcript.viewport.preferredScreenRow : 0)
        this.dispatch({ type: "transcript.command", command: { type: "jump.to", target: { point: command.target, preferredScreenRow: command.preferredScreenRow ?? 2 }, origin: command.origin ? { point: command.origin, preferredScreenRow: originRow } : undefined } })
        focusJump(Boolean(command.extend) && preserveVisual())
        break
      }
      case "jump.back": case "jump.forward": {
        this.navigateHistory(command.type === "jump.back" ? "back" : "forward")
        break
      }
      case "mark.set": {
        const transcript = workspace.transcript
        if (!/^[a-zA-Z]$/.test(command.name)) { this.notice(`Invalid mark: ${command.name}`); break }
        const point = workspace.interaction.surface === "transcript" && transcript.cursor ? transcript.cursor
          : transcript.viewport.kind === "point" ? transcript.viewport.point : transcript.cursor ?? (() => {
          const itemId = transcript.order.at(-1), projection = itemId ? transcript.projectionById[itemId] : undefined
          return itemId && projection ? { itemId, graphemeOffset: projection.sourceSpans.length } : undefined
        })()
        if (!point) { this.notice("No transcript position to mark"); break }
        const preferredScreenRow = transcript.viewport.kind === "point" && transcript.viewport.point.itemId === point.itemId && transcript.viewport.point.graphemeOffset === point.graphemeOffset ? transcript.viewport.preferredScreenRow : 0
        this.dispatch({ type: "transcript.command", command: { type: "mark.set", name: command.name, target: { point, preferredScreenRow } } })
        break
      }
      case "mark.jump": {
        if (!workspace.transcript.marks[command.name]) { this.notice(`Mark not set: ${command.name}`); break }
        const before = activeWorkspace(this.state)?.transcript
        this.dispatch({ type: "transcript.command", command: { ...command, origin: navigationOrigin() } })
        if (before && !sameDisplayedLocation(before, activeWorkspace(this.state)?.transcript)) focusJump()
        break
      }
      case "selection.begin": this.dispatch({ type: "transcript.command", command }); break
      case "selection.clear": this.dispatch({ type: "transcript.command", command }); break
      case "viewport.anchor": this.dispatch({ type: "transcript.command", command }); break
      case "viewport.tail": {
        const itemId = workspace.transcript.order.at(-1), projection = itemId ? workspace.transcript.projectionById[itemId] : undefined
        if (itemId && projection) this.dispatch({ type: "transcript.command", command: { type: "jump.to", target: { point: { itemId, graphemeOffset: projection.sourceSpans.length }, preferredScreenRow: 0 } } })
        this.dispatch({ type: "transcript.command", command: { type: "tail.attach" } })
        break
      }
      case "viewport.scroll": {
        const point = workspace.transcript.cursor
        if (point) this.dispatch({ type: "transcript.command", command: { type: "viewport.anchor", point, preferredScreenRow: 0 } })
        break
      }
      case "fold.set": case "fold.all": this.dispatch({ type: "transcript.command", command }); break
      case "copy": this.dispatch({ type: "transcript.yank", format: command.format }); break
      case "url.open": {
        const selected = workspace.transcript.selection ? urlCandidates(workspace.transcript, "selection") : []
        const underCursor = selected.length ? undefined : urlAt(workspace.transcript)
        const candidates = selected.length ? selected : urlCandidates(workspace.transcript, "current-item")
        const allowed = this.state.urlChoices ?? candidates
        if (command.url && !allowed.some(candidate => candidate.url === command.url)) {
          this.notice("That URL is no longer available in the active picker")
          break
        }
        const url = command.url ?? (selected.length === 1 ? selected[0]?.url : underCursor) ?? (candidates.length === 1 ? candidates[0]?.url : undefined)
        if (url) {
          this.setState({ ...this.state, urlChoices: undefined })
          this.dispatchInteraction({ type: "overlay.close" })
          this.launch(() => this.ports.openUrl(url))
        } else if (candidates.length > 1) {
          this.setState({ ...this.state, urlChoices: candidates })
          this.dispatchInteraction({ type: "overlay.open", overlay: "urls" })
        } else this.notice("No URL at this transcript position")
        break
      }
      case "fork": this.requestFork(command.itemId); break
    }
  }
  executeCommand = (line: string): void => {
    this.dispatchInteraction({ type: "mode.normal" })
    if (/^[/?]/.test(line)) { this.transcript({ type: "search", query: line.slice(1), direction: line[0] === "/" ? "forward" : "backward" }); return }
    this.runCommand(parseCommand(line))
  }
  executeNamedCommand = (name: string): void => this.runCommand(parseCommand(name))
  private savePreferences(next: DisplayPreferences): void {
    const revision = ++this.preferenceRevision
    this.desiredPreferences = next
    const operation = this.preferenceTail.then(async () => {
      await this.ports.preferences?.save(next)
      this.setState({ ...this.state, preferences: next })
    }).catch(error => {
      if (revision === this.preferenceRevision) this.desiredPreferences = this.state.preferences
      throw error
    })
    this.preferenceTail = operation.catch(() => {})
    this.launch(() => operation)
  }
  private launchThreadMutation(id: ThreadId, operation: (epoch: number) => Promise<void>): void {
    if (this.retiringThread(id)) { this.notice("Side chat is quitting; new work is paused"); return }
    const epoch = this.runtimeEpoch
    const previous = this.threadMutations.get(id) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      if (!this.currentRuntime(epoch) || this.retiringThread(id)) return
      try { await operation(epoch) }
      catch (error) { if (this.currentRuntime(epoch)) throw error }
    })
    this.threadMutations.set(id, pending)
    this.launch(async () => {
      try { await pending }
      finally { if (this.threadMutations.get(id) === pending) this.threadMutations.delete(id) }
    })
  }
  private runCommand(parsed: ExCommand): void {
    if (parsed.kind === "empty") return
    if (parsed.kind === "unknown") { this.notice(`Unknown command: ${parsed.name}`); return }
    const invalid = validateCommand(parsed)
    if (invalid) { this.notice(invalid); return }
    const { name: command, argument } = parsed
    switch (command) {
      case "compact": {
        const id = this.state.activeThreadId
        if (!id) { this.notice("Open a session before compacting"); break }
        if (this.state.compactingThreads[id]) break
        if (this.retiringThread(id)) { this.notice("Side chat is quitting; new work is paused"); break }
        const blocked = compactionBlockReason(this.state, id)
        if (blocked) { this.notice(blocked); break }
        const compact = this.ports.conversation.compactThread
        if (!compact) { this.notice("This runtime does not support compaction"); break }
        const epoch = this.runtimeEpoch
        const request = { phase: "requested" as const, requestId: crypto.randomUUID() }
        this.setState({ ...this.state, error: undefined, compactingThreads: { ...this.state.compactingThreads, [id]: request } })
        const pending = this.launch(async () => {
          try { await compact.call(this.ports.conversation, id) }
          catch (error) {
            if (!this.currentRuntime(epoch) || this.state.compactingThreads[id]?.requestId !== request.requestId) return
            this.dispatch({ type: "compaction.observed", observation: { threadId: id, phase: "failed", error: `Compaction failed: ${String(error)}` } })
          }
        })
        this.trackContinuation(id, pending)
        break
      }
      case "goal": {
        const id = this.state.activeThreadId
        if (!id) { this.notice("Open a session before setting a goal"); break }
        this.launchThreadMutation(id, async epoch => {
          const message = await executeGoalCommand(this.ports.conversation, id, argument)
          if (this.currentRuntime(epoch) && this.state.activeThreadId === id) this.notice(message)
        })
        break
      }
      case "submit": this.submit(argument === "queue" ? "next-turn" : argument === "steer" || this.ports.busySubmit === "steer" ? "steer" : "next-turn"); break
      case "insert": this.dispatchInteraction({ type: "mode.insert" }); break
      case "normal": this.dispatchInteraction({ type: "mode.normal" }); break
      case "visual": {
        const transcript = activeWorkspace(this.state)?.transcript
        const first = transcript?.order[0]
        const point = transcript?.cursor ?? (first ? { itemId: first, graphemeOffset: 0 } : undefined)
        if (!point) { this.notice("No transcript content to select"); break }
        this.dispatchInteraction({ type: "focus.set", surface: "transcript" })
        this.transcript({ type: "cursor.move", target: point, preferredScreenRow: 2, extend: false })
        this.transcript({ type: "selection.begin", shape: "character" })
        this.dispatchInteraction({ type: "mode.visual" })
        break
      }
      case "theme": case "syntax": {
        if (!argument) { this.notice(`${command}: ${[...themeNames, ...(command === "syntax" ? ["theme"] : [])].join(", ")}`); break }
        if (!isThemeName(argument) && !(command === "syntax" && argument === "theme")) { this.notice(`Unknown ${command}: ${argument}`); break }
        const current = this.desiredPreferences ?? this.state.preferences ?? { theme: "ember-tide" as const, syntaxTheme: "theme" as const }
        const next = command === "theme" && isThemeName(argument) ? { ...current, theme: argument } : { ...current, syntaxTheme: argument as typeof current.syntaxTheme }
        this.savePreferences(next)
        break
      }
      case "quit": this.ports.quit(); break
      case "sessions": {
        if (!argument) this.dispatchInteraction({ type: "overlay.open", overlay: "sessions" })
        else this.openThread(threadId(argument))
        break
      }
      case "manual": this.dispatchInteraction({ type: "overlay.open", overlay: "manual" }); break
      case "help": {
        const name = resolveCommandName(argument)
        if (name === "manual") this.dispatchInteraction({ type: "overlay.open", overlay: "manual" })
        else if (name) this.notice(`:${commandDescriptors[name].usage} — ${commandDescriptors[name].description}`)
        else this.dispatchInteraction({ type: "overlay.open", overlay: "help" })
        break
      }
      case "favorite": {
        const id = this.state.activeThreadId
        if (!id) break
        const favorite = this.state.favoriteThreadIds.includes(id)
        const next = argument ? argument === "on" : !favorite
        if (next !== favorite) this.toggleFavorite(id)
        this.notice(next ? "Session favorited" : "Session removed from favorites")
        break
      }
      case "tail": case "follow": this.transcript({ type: "viewport.tail" }); break
      case "approvals": case "questions": case "agents": this.dispatchInteraction({ type: "overlay.open", overlay: command }); break
      case "model": case "thinking": case "cwd": {
        if (command === "model" && !argument) {
          this.dispatchInteraction({ type: "overlay.open", overlay: "models" })
          break
        }
        const id = this.state.activeThreadId
        if (!id || !this.state.summaries[id]) break
        this.launchThreadMutation(id, async epoch => {
          const summary = this.state.summaries[id]
          if (!summary) return
          if (command === "cwd") {
            if (!argument) { this.notice(summary.cwd); return }
            const cwd = this.ports.resolveDirectory(summary.cwd, argument)
            await this.ports.conversation.updateSettings(id, { cwd })
            if (this.currentRuntime(epoch)) this.dispatch({ type: "thread.summary.patch", threadId: id, patch: { cwd, gitBranch: undefined } })
            return
          }
          const models = await this.loadModels()
          if (!this.currentRuntime(epoch)) return
          if (!argument) {
            this.notice(`Reasoning: ${models.find(m => m.id === summary.model)?.efforts.join(", ") ?? "unavailable"}`)
            return
          }
          if (command === "thinking") {
            const current = models.find(model => model.id === summary.model)
            if (!current?.efforts.includes(argument)) throw new Error(`Unsupported reasoning effort: ${argument}`)
            await this.ports.conversation.updateSettings(id, { effort: argument })
            if (this.currentRuntime(epoch)) this.dispatch({ type: "thread.summary.patch", threadId: id, patch: { reasoningEffort: argument } })
          } else {
            const [modelId, effort, ...extra] = argument.trim().split(/\s+/)
            if (extra.length) throw new Error("Usage: :model <model-id> [thinking-level]")
            const model = models.find(candidate => candidate.id === modelId)
            if (!model) throw new Error(`Unknown model: ${modelId}`)
            if (effort && !model.efforts.includes(effort)) throw new Error(`Unsupported reasoning effort for ${model.id}: ${effort}`)
            await this.ports.conversation.updateSettings(id, { model: model.id, ...(effort ? { effort } : {}) })
            if (this.currentRuntime(epoch)) this.dispatch({ type: "thread.summary.patch", threadId: id, patch: { model: model.id, ...(effort ? { reasoningEffort: effort } : {}) } })
          }
        })
        break
      }
      case "new": {
        const summary = this.state.activeThreadId ? this.state.summaries[this.state.activeThreadId] : undefined
        if (summary) {
          const revision = ++this.navigationRevision
          const epoch = this.runtimeEpoch
          this.clearNavigationIntent()
          this.launch(async () => {
            let snapshot: SessionSnapshot
            try { snapshot = await this.ports.conversation.startThread(argument ? this.ports.resolveDirectory(summary.cwd, argument) : summary.cwd, summary.model) }
            catch (error) { if (this.currentRuntime(epoch)) throw error; return }
            if (this.currentRuntime(epoch)) this.hydrate(snapshot, revision === this.navigationRevision)
          })
        }
        break
      }
      case "approve": case "reject": {
        const approval = this.state.approvals.order.map(id => this.state.approvals.byId[id])
          .find(a => a !== undefined && a.threadId === this.state.activeThreadId && (a.status === "pending" || a.status === "failed"))
        const choices = command === "approve" ? ["accept", "approved"] : ["decline", "denied", "cancel", "abort"]
        const choice = approval?.choices.find(c => choices.includes(c.id))
        if (approval && choice) this.resolveApproval(approval.id, choice.id)
        else this.notice("Open :approvals to choose a response")
        break
      }
      case "side": {
        const verbs: SideChatAction[] = ["open", "close", "quit", "refresh", "maximize", "reset", "parent", "side", "cycle", "quote"]
        const action = argument === "focus parent" ? "parent" : argument === "focus side" ? "side" : argument
        this.sideChat(verbs.includes(action as SideChatAction) ? action as SideChatAction : "open", verbs.includes(action as SideChatAction) ? undefined : argument)
        break
      }
      case "parent": this.returnToParent(); break
      case "restart": this.restart(); break
      case "stop": this.interrupt(); break
      case "fork": this.transcript({ type: "fork" }); break
      case "fold": case "unfold": this.transcript({ type: "fold.all", folded: command === "fold" }); break
      case "yank": {
        const transcript = activeWorkspace(this.state)?.transcript
        const format = argument === "markdown" ? "source" : "plain"
        if (transcript?.selection) this.transcript({ type: "copy", format })
        else {
          const id = transcript?.cursor?.itemId ?? transcript?.order.at(-1)
          const projection = id ? transcript?.projectionById[id] : undefined
          if (!projection) { this.notice("No transcript content to copy"); break }
          const text = format === "source" ? projection.source : projection.plain
          this.dispatchInteraction({ type: "register.set", register: { text, shape: "character" } })
          this.copyText(text)
          this.notice("Copied current transcript block")
        }
        break
      }
      case "open": {
        if (argument) {
          this.setState({ ...this.state, urlChoices: undefined })
          this.launch(() => this.ports.openUrl(argument))
        } else this.transcript({ type: "url.open" })
        break
      }
      case "rename": {
        const id = this.state.activeThreadId
        if (id && argument) this.renameThread(id, argument)
        break
      }
      default: { const unreachable: never = command; throw new Error(`Unhandled command: ${String(unreachable)}`) }
    }
  }
  private async effect(effect: WorkbenchEffect): Promise<void> {
    const epoch = this.runtimeEpoch
    switch (effect.type) {
      case "conversation.turn.start": case "conversation.turn.steer": {
        if (this.retiringThread(effect.threadId)) return
        try {
          let submittedTurn: TurnId | undefined
          const turn = this.state.workspaces[effect.threadId]?.conversation.activeTurnId
          if (effect.type === "conversation.turn.steer" && turn) await this.ports.conversation.steerTurn(effect.threadId, turn, effect.text, effect.clientMessageId)
          else {
            const events = await this.ports.conversation.startTurn(effect.threadId, effect.text, effect.clientMessageId)
            if (!this.currentRuntime(epoch)) return
            submittedTurn = events.find(event => event.type === "turn.started")?.turnId
            // RPC snapshots may predate already-observed live deltas/completion.
            const initial = this.state.workspaces[effect.threadId]?.conversation
            if (!initial) return
            const replay = createRpcEventReplay(initial)
            for (const event of events) {
              const current = this.state.workspaces[effect.threadId]?.conversation
              if (current && replay(current, event)) this.receive({ type: "conversation", event })
            }
          }
          if (this.currentRuntime(epoch)) this.dispatch({ type: "composer.ack", threadId: effect.threadId, clientMessageId: effect.clientMessageId, turnId: submittedTurn })
        } catch (error) {
          if (!this.currentRuntime(epoch)) return
          this.dispatch({ type: "composer.fail", threadId: effect.threadId, clientMessageId: effect.clientMessageId, reason: String(error) })
          throw error
        }
        break
      }
      case "approval.resolve":
        try {
          await this.ports.approvals.resolveApproval(effect.approvalId, effect.choiceId)
          if (this.currentRuntime(epoch)) this.dispatch({ type: "approval.resolved", approvalId: effect.approvalId })
        } catch (error) {
          if (!this.currentRuntime(epoch)) return
          this.dispatch({ type: "approval.failed", approvalId: effect.approvalId, error: String(error) })
          throw error
        }
        break
      case "conversation.thread.fork": {
        const revision = ++this.navigationRevision
        let snapshot: SessionSnapshot
        try { snapshot = await this.ports.conversation.forkThread(effect.threadId, effect.throughTurnId) }
        catch (error) { if (this.currentRuntime(epoch)) throw error; return }
        if (this.currentRuntime(epoch)) this.hydrate(snapshot, revision === this.navigationRevision)
        break
      }
      case "clipboard.write": await this.ports.clipboard.writeText(effect.text); break
      case "url.open": await this.ports.openUrl(effect.url); break
      case "viewport.restore": break // The renderer observes the unchanged semantic anchor after reflow.
    }
  }
  close(): Promise<void> { return this.closePromise ??= this.runClose() }
  private async runClose(): Promise<void> {
    this.closing = true
    this.signalClosing()
    this.navigationRevision++
    this.unsubscribe?.()
    this.unsubscribe = undefined
    const errors: unknown[] = []
    try { await this.ports.connection.close() } catch (error) { errors.push(error) }
    if (this.initialization) {
      try { await this.initialization } catch (error) { errors.push(error) }
    }
    try { await this.settle() } catch (error) { errors.push(error) }
    this.buffered.clear()
    this.resumes.clear()
    this.listeners.clear()
    if (errors.length) throw new AggregateError(errors, "Vimex controller shutdown failed")
  }
}
