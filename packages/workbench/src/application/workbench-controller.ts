import { adjacentSearchMatch, findSearchMatches, firstContentPoint, moveByWord, moveBySemanticBlock, moveByUrl, referenceText, urlAt, urlCandidates, graphemeCount, type LogicalPoint } from "@vimex/transcript"
import { isThemeName, themeNames, type PreferenceStore } from "./display-preferences"
import { parseCommand, type ExCommand } from "@vimex/interaction"
import { captureLocalState, emptyLocalState, restoreThreadView, type LocalState, type SavedThreadView } from "./local-state"
import { initialWorkbench, activeWorkspace, createWorkspace, type WorkbenchState, type WorkbenchCommand, type WorkbenchEffect } from "./workbench-state"
import { transitionWorkbench } from "./reduce-workbench"
import { forkBoundary, threadId, type ThreadId, type TurnId, type ItemId, type ConversationEvent } from "@vimex/conversation"
import type { ConversationGateway, SessionSnapshot } from "@vimex/conversation"
import type { ApprovalGateway } from "@vimex/approvals"
import type { RuntimeConnection, RuntimeEvent } from "./runtime-connection"
import type { ModelCatalog } from "./model-catalog"
import type { WorkbenchActions, TranscriptAction } from "./workbench-actions"
import { validateAnswers } from "@vimex/approvals"
import type { DisplayPreferences } from "./display-preferences"
import { createRpcEventReplay } from "./rpc-event-replay"
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
  private readonly listeners = new Set<() => void>()
  private readonly pending = new Set<Promise<void>>()
  private readonly loaded = new Set<ThreadId>()
  private readonly buffered = new Map<ThreadId, ConversationEvent[]>()
  private readonly resumes = new Map<ThreadId, Promise<SessionSnapshot>>()
  private unsubscribe?: () => void
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
    this.state = { ...this.state, favoriteThreadIds: [...new Set(ports.localState?.favoriteThreadIds ?? [])].map(threadId) }
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
  dispatch(command: WorkbenchCommand): void {
    if (this.closing) return
    const result = transitionWorkbench(this.state, command)
    this.setState(result.state)
    for (const effect of result.effects) this.launch(() => this.effect(effect))
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
    this.dispatch({ type: "thread.register", summary })
  }
  private async unlessClosing<T>(operation: Promise<T>): Promise<{ value: T } | undefined> {
    return Promise.race([
      operation.then(value => ({ value })),
      this.closingSignal.then(() => undefined),
    ])
  }
  private currentRuntime(epoch: number): boolean { return !this.closing && epoch === this.runtimeEpoch }
  private hydrate(snapshot: SessionSnapshot, focus: boolean): void {
    this.register(snapshot.summary)
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
    switch (event.type) {
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
  dispatchInteraction: WorkbenchActions["dispatchInteraction"] = command => this.dispatch({ type: "interaction.command", command })
  changeDraft: WorkbenchActions["changeDraft"] = (text, cursorOffset) => this.dispatch({ type: "composer.change", text, cursorOffset })
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
    if (request.threadId !== this.state.activeThreadId) {
      this.notice("Open the question's session before responding")
      return
    }
    const token = Symbol(id)
    const epoch = this.runtimeEpoch
    this.answering.set(id, token)
    this.launch(async () => {
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
    const parent = child && (this.parentReturns.get(child) ?? this.state.agentRelationships.find(link => link.childId === child)?.parentId)
    if (!parent) { this.notice("This session has no known parent"); return }
    this.dispatchInteraction({ type: "overlay.close" })
    this.openThread(parent)
  }
  private clearNavigationIntent(): void {
    if (this.state.pendingFork || this.state.urlChoices) {
      this.setState({ ...this.state, pendingFork: undefined, urlChoices: undefined })
    }
  }
  restart = (): void => {
    if (this.restartPending || this.closing) return
    this.restartPending = true
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
  openThread = (id: ThreadId): void => {
    const revision = ++this.navigationRevision
    const epoch = this.runtimeEpoch
    this.clearNavigationIntent()
    this.dispatchInteraction({ type: "overlay.close" })
    this.launch(async () => {
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
      if (this.currentRuntime(epoch) && revision === this.navigationRevision) this.dispatch({ type: "thread.switch", threadId: id })
    })
  }
  interrupt = (): void => {
    const workspace = activeWorkspace(this.state)
    if (workspace?.conversation.activeTurnId) this.launch(() => this.ports.conversation.interruptTurn(workspace.conversation.threadId, workspace.conversation.activeTurnId!))
  }
  transcript = (command: TranscriptAction): void => {
    const workspace = activeWorkspace(this.state)
    if (!workspace) return
    const move = (point?: LogicalPoint) => {
      if (!point) return
      this.dispatch({ type: "transcript.command", command: { type: "fold.set", itemId: point.itemId, folded: false } })
      this.dispatch({ type: "transcript.command", command: { type: "cursor.move", point, preferredScreenRow: 2 } })
    }
    switch (command.type) {
      case "navigate": {
        const direction = command.motion.endsWith("previous") ? "backward" : "forward"
        const count = Math.max(1, command.count ?? 1)
        const transcript = workspace.transcript
        if (command.motion.startsWith("word-") || command.motion.startsWith("WORD-")) {
          const motion = command.motion.endsWith("previous") ? "previous" : command.motion.endsWith("end") ? "end" : "next"
          move(moveByWord(transcript, motion, transcript.cursor, count, command.motion.startsWith("WORD-")))
        } else if (command.motion.startsWith("block-")) move(moveBySemanticBlock(transcript, direction, transcript.cursor, count))
        else if (command.motion.startsWith("url-")) move(moveByUrl(transcript, direction, transcript.cursor, { count, wrap: true }))
        else if (command.motion === "first-content") move(firstContentPoint(transcript))
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
        move(adjacentSearchMatch(workspace.transcript, matches, command.direction)?.from)
        if (!matches.length) this.notice(`Pattern not found: ${query}`)
        break
      }
      case "search.next": {
        const search = workspace.transcript.search
        if (!search) { this.notice("Search with / or ? first"); break }
        const direction = command.reverse ? (search.direction === "forward" ? "backward" : "forward") : search.direction
        move(adjacentSearchMatch(workspace.transcript, findSearchMatches(workspace.transcript, search.query), direction, workspace.transcript.cursor, { count: command.count })?.from)
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
      case "selection.begin": this.dispatch({ type: "transcript.command", command }); break
      case "selection.clear": this.dispatch({ type: "transcript.command", command }); break
      case "viewport.tail": this.dispatch({ type: "transcript.command", command: { type: "tail.attach" } }); break
      case "viewport.scroll": {
        const point = workspace.transcript.cursor
        if (point) this.dispatch({ type: "transcript.command", command: { type: "cursor.move", point } })
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
    const epoch = this.runtimeEpoch
    const previous = this.threadMutations.get(id) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      if (!this.currentRuntime(epoch)) return
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
    const { name: command, argument } = parsed
    switch (command) {
      case "submit": this.submit(this.ports.busySubmit === "steer" ? "steer" : "next-turn"); break
      case "insert": this.dispatchInteraction({ type: "mode.insert" }); break
      case "normal": this.dispatchInteraction({ type: "mode.normal" }); break
      case "visual": this.dispatchInteraction({ type: "mode.visual" }); break
      case "theme": case "syntax": {
        if (!argument) { this.notice(`${command}: ${[...themeNames, ...(command === "syntax" ? ["theme"] : [])].join(", ")}`); break }
        if (!isThemeName(argument) && !(command === "syntax" && argument === "theme")) { this.notice(`Unknown ${command}: ${argument}`); break }
        const current = this.desiredPreferences ?? this.state.preferences ?? { theme: "ember-tide" as const, syntaxTheme: "theme" as const }
        const next = command === "theme" && isThemeName(argument) ? { ...current, theme: argument } : { ...current, syntaxTheme: argument as typeof current.syntaxTheme }
        this.savePreferences(next)
        break
      }
      case "quit": this.ports.quit(); break
      case "sessions": case "approvals": case "help": case "questions": case "agents": this.dispatchInteraction({ type: "overlay.open", overlay: command }); break
      case "model": case "thinking": case "cwd": {
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
          const models = await this.ports.models.listModels()
          if (!argument) {
            this.notice(command === "thinking" ? `Reasoning: ${models.find(m => m.id === summary.model)?.efforts.join(", ") ?? "unavailable"}` : `Models: ${models.map(m => m.id).join(", ")}. Use :model <name>`)
            return
          }
          if (command === "thinking") {
            const current = models.find(model => model.id === summary.model)
            if (!current?.efforts.includes(argument)) throw new Error(`Unsupported reasoning effort: ${argument}`)
            await this.ports.conversation.updateSettings(id, { effort: argument })
            if (this.currentRuntime(epoch)) this.dispatch({ type: "thread.summary.patch", threadId: id, patch: { reasoningEffort: argument } })
          } else {
            if (!models.some(model => model.id === argument)) throw new Error(`Unknown model: ${argument}`)
            await this.ports.conversation.updateSettings(id, { model: argument })
            if (this.currentRuntime(epoch)) this.dispatch({ type: "thread.summary.patch", threadId: id, patch: { model: argument } })
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
      case "parent": this.returnToParent(); break
      case "restart": this.restart(); break
      case "stop": this.interrupt(); break
      case "fork": this.transcript({ type: "fork" }); break
      case "fold": case "unfold": this.transcript({ type: "fold.all", folded: command === "fold" }); break
      case "yank": this.transcript({ type: "copy", format: argument === "markdown" ? "source" : "plain" }); break
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
