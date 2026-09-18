import { parseCommand } from "@vimex/interaction"
import { restoreThreadView, type LocalState } from "./local-state"
import { initialWorkbench, activeWorkspace, type WorkbenchState, type WorkbenchCommand, type WorkbenchEffect } from "./workbench-state"
import { transitionWorkbench } from "./reduce-workbench"
import { threadId, type ThreadId, type ConversationEvent } from "@vimex/conversation"
import type { ConversationGateway, SessionSnapshot } from "@vimex/conversation"
import type { ApprovalGateway } from "@vimex/approvals"
import type { RuntimeConnection, RuntimeEvent } from "./runtime-connection"
import type { ModelCatalog } from "./model-catalog"
import type { WorkbenchActions, TranscriptAction } from "./workbench-actions"
import { initialApprovals } from "@vimex/approvals"

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
  private closing = false
  private closePromise?: Promise<void>
  private signalClosing!: () => void
  private readonly closingSignal = new Promise<void>(resolve => { this.signalClosing = resolve })
  constructor(private readonly ports: ControllerPorts) {}
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
  private launch(operation: () => Promise<void>): void {
    if (this.closing) return
    const promise = operation().catch(error => { if (!this.closing) this.notice(error instanceof Error ? error.message : String(error)) })
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise))
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
  private hydrate(snapshot: SessionSnapshot, focus: boolean): void {
    this.register(snapshot.summary)
    for (const event of snapshot.events) this.dispatch({ type: "conversation.event", event })
    const saved = this.ports.localState?.threads[snapshot.summary.id]
    const workspace = this.state.workspaces[snapshot.summary.id]
    if (saved && workspace && !this.loaded.has(snapshot.summary.id)) this.setState({ ...this.state, workspaces: { ...this.state.workspaces, [snapshot.summary.id]: restoreThreadView(workspace, saved) } })
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
    this.unsubscribe = this.ports.connection.subscribe(event => this.receive(event))
    try {
      if (!await this.unlessClosing(this.ports.connection.connect())) return
      this.dispatch({ type: "connection.changed", connection: "connected" })
      const summaries = await this.unlessClosing(this.ports.conversation.listThreads())
      if (!summaries) return
      for (const summary of summaries.value) this.register(summary)
      const snapshot = await this.unlessClosing(resume ? this.ports.conversation.resumeThread(threadId(resume)) : this.ports.conversation.startThread(cwd, model))
      if (!snapshot) return
      this.hydrate(snapshot.value, true)
    } catch (error) {
      if (this.closing) return
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
        const result = transitionWorkbench(this.state, { type: "connection.changed", connection: "disconnected", error: event.message })
        this.setState({ ...result.state, approvals: initialApprovals(), questions: {} })
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
  copyText = (text: string): void => this.launch(() => this.ports.clipboard.writeText(text))
  resolveApproval: WorkbenchActions["resolveApproval"] = (approvalId, choiceId) => this.dispatch({ type: "approval.resolve", approvalId, choiceId })
  openThread = (id: ThreadId): void => {
    const revision = ++this.navigationRevision
    this.launch(async () => {
      if (!this.loaded.has(id)) {
        let pending = this.resumes.get(id)
        if (!pending) {
          pending = this.ports.conversation.resumeThread(id)
          this.resumes.set(id, pending)
        }
        try {
          const snapshot = await pending
          if (!this.loaded.has(id)) this.hydrate(snapshot, false)
        } finally { if (this.resumes.get(id) === pending) this.resumes.delete(id) }
      }
      if (revision === this.navigationRevision) this.dispatch({ type: "thread.switch", threadId: id })
    })
  }
  interrupt = (): void => {
    const workspace = activeWorkspace(this.state)
    if (workspace?.conversation.activeTurnId) this.launch(() => this.ports.conversation.interruptTurn(workspace.conversation.threadId, workspace.conversation.activeTurnId!))
  }
  transcript = (command: TranscriptAction): void => {
    const workspace = activeWorkspace(this.state)
    if (!workspace) return
    switch (command.type) {
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
      case "url.open":
        if (command.url) this.launch(() => this.ports.openUrl(command.url!))
        else this.dispatch({ type: "transcript.url.open" })
        break
      case "fork": {
        const id = command.itemId ?? workspace.transcript.cursor?.itemId
        const item = id ? workspace.conversation.items[id] : undefined
        if (item) this.dispatch({ type: "thread.fork.request", threadId: workspace.conversation.threadId, throughTurnId: item.turnId })
        break
      }
    }
  }
  executeCommand = (line: string): void => {
    const parsed = parseCommand(line)
    this.dispatchInteraction({ type: "mode.normal" })
    if (parsed.kind === "empty") return
    if (parsed.kind === "unknown") { this.notice(`Unknown command: ${parsed.name}`); return }
    const { name: command, argument } = parsed
    switch (command) {
      case "quit": this.ports.quit(); break
      case "sessions": case "approvals": case "help": this.dispatchInteraction({ type: "overlay.open", overlay: command }); break
      case "model": case "thinking": case "cwd": {
        const id = this.state.activeThreadId
        const summary = id ? this.state.summaries[id] : undefined
        if (!id || !summary) break
        this.launch(async () => {
          if (command === "cwd") {
            if (!argument) { this.notice(summary.cwd); return }
            const cwd = this.ports.resolveDirectory(summary.cwd, argument)
            await this.ports.conversation.updateSettings(id, { cwd })
            this.dispatch({ type: "thread.summary.patch", threadId: id, patch: { cwd, gitBranch: undefined } })
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
            this.dispatch({ type: "thread.summary.patch", threadId: id, patch: { reasoningEffort: argument } })
          } else {
            if (!models.some(model => model.id === argument)) throw new Error(`Unknown model: ${argument}`)
            await this.ports.conversation.updateSettings(id, { model: argument })
            this.dispatch({ type: "thread.summary.patch", threadId: id, patch: { model: argument } })
          }
        })
        break
      }
      case "new": {
        const summary = this.state.activeThreadId ? this.state.summaries[this.state.activeThreadId] : undefined
        if (summary) this.launch(async () => this.hydrate(await this.ports.conversation.startThread(argument ? this.ports.resolveDirectory(summary.cwd, argument) : summary.cwd, summary.model), true))
        break
      }
      case "approve": case "reject": {
        const approval = this.state.approvals.order.map(id => this.state.approvals.byId[id]).find(a => a?.status === "pending" || a?.status === "failed")
        const choices = command === "approve" ? ["accept", "approved"] : ["decline", "denied", "cancel", "abort"]
        const choice = approval?.choices.find(c => choices.includes(c.id))
        if (approval && choice) this.resolveApproval(approval.id, choice.id)
        else this.notice("Open :approvals to choose a response")
        break
      }
      case "stop": this.interrupt(); break
      case "fork": this.transcript({ type: "fork" }); break
      case "fold": case "unfold": this.transcript({ type: "fold.all", folded: command === "fold" }); break
      case "yank": this.transcript({ type: "copy", format: argument === "markdown" ? "source" : "plain" }); break
      case "open": this.transcript({ type: "url.open", url: argument || undefined }); break
      case "rename": {
        const id = this.state.activeThreadId
        if (id && argument) this.launch(async () => {
          await this.ports.conversation.renameThread(id, argument)
          this.dispatch({ type: "thread.summary.patch", threadId: id, patch: { title: argument } })
        })
        break
      }
      default: { const unreachable: never = command; throw new Error(`Unhandled command: ${String(unreachable)}`) }
    }
  }
  private async effect(effect: WorkbenchEffect): Promise<void> {
    switch (effect.type) {
      case "conversation.turn.start": case "conversation.turn.steer": {
        try {
          const turn = this.state.workspaces[effect.threadId]?.conversation.activeTurnId
          if (effect.type === "conversation.turn.steer" && turn) await this.ports.conversation.steerTurn(effect.threadId, turn, effect.text, effect.clientMessageId)
          else {
            const events = await this.ports.conversation.startTurn(effect.threadId, effect.text, effect.clientMessageId)
            // RPC snapshots may predate already-observed live deltas/completion.
            const observed = new Set(this.state.workspaces[effect.threadId]?.conversation.turnIds ?? [])
            for (const event of events) {
              const turn = "turnId" in event ? event.turnId : "item" in event ? event.item.turnId : undefined
              if (!turn || !observed.has(turn)) this.receive({ type: "conversation", event })
            }
          }
          this.dispatch({ type: "composer.ack", threadId: effect.threadId, clientMessageId: effect.clientMessageId })
        } catch (error) {
          this.dispatch({ type: "composer.fail", threadId: effect.threadId, clientMessageId: effect.clientMessageId, reason: String(error) })
          throw error
        }
        break
      }
      case "approval.resolve":
        try { await this.ports.approvals.resolveApproval(effect.approvalId, effect.choiceId) }
        catch (error) { this.dispatch({ type: "approval.failed", approvalId: effect.approvalId, error: String(error) }); throw error }
        break
      case "conversation.thread.fork": this.hydrate(await this.ports.conversation.forkThread(effect.threadId, effect.throughTurnId), true); break
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
