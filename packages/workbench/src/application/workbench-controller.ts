import { threadContext } from "./thread-context"
import { agentRoster } from "./agent-roster"
import { compactionBlockReason } from "./compaction"
import { executeGoalCommand } from "./goal-command"
import {
  SideChatCoordinator,
  currentSideChat,
  sideChatForChild,
  sideChatForThread,
  type SideChatAction,
} from "./side-chat"
import {
  adjacentSearchMatch,
  defaultTranscriptWindowPolicy,
  findSearchMatches,
  firstContentPoint,
  moveByMessage,
  moveByWord,
  moveBySemanticBlock,
  moveByUrl,
  referenceText,
  selectedText,
  urlAt,
  urlCandidateInScope,
  urlCandidates,
  graphemeCount,
  TranscriptRuntime,
  type LogicalPoint,
  type TranscriptDamage,
  type TranscriptRevealRequest,
  type TranscriptRuntimeInput,
  type TranscriptState,
  type UrlCandidate,
} from "@vimex/transcript"
import {
  isThemeName,
  themeNames,
  type PreferenceStore,
} from "./display-preferences"
import {
  parseCommand,
  validateCommand,
  resolveCommandName,
  commandDescriptors,
  type ExCommand,
} from "@vimex/interaction"
import {
  captureLocalState,
  emptyLocalState,
  localViewChanged,
  restoreThreadView,
  sameLocalState,
  type LocalState,
  type SavedThreadView,
} from "./local-state"
import {
  captureWorkbenchLifecycle,
  workbenchLifecycleChanged,
  workbenchLifecycleSignature,
  type WorkbenchLifecycleSnapshot,
} from "./workbench-observation"
import {
  captureWorkbenchLayout,
  captureWorkbenchPresentation,
  captureWorkbenchPublicationContext,
  threadForPresentation,
  workbenchLayoutChanged,
  workbenchPresentationChanged,
  type WorkbenchLayoutSnapshot,
  type WorkbenchPublicationContext,
  type WorkbenchPublicationHost,
} from "./workbench-publications"
import {
  initialWorkbench,
  activeWorkspace,
  createWorkspace,
  type ThreadWorkspace,
  type WorkbenchState,
  type WorkbenchCommand,
  type WorkbenchEffect,
} from "./workbench-state"
import { transitionWorkbench } from "./reduce-workbench"
import {
  forkBoundary,
  persistentConversationTurnIds,
  previewTitle,
  threadId,
  turnItemIdsHave,
  type ThreadId,
  type TurnId,
  type ItemId,
  type ConversationEvent,
} from "@vimex/conversation"
import type { ConversationGateway, SessionSnapshot } from "@vimex/conversation"
import type { ApprovalGateway } from "@vimex/approvals"
import type { RuntimeConnection, RuntimeEvent } from "./runtime-connection"
import type { AvailableModel, ModelCatalog } from "./model-catalog"
import type {
  WorkbenchActions,
  TranscriptAction,
  TranscriptPresentationHost,
  TranscriptPresentationId,
} from "./workbench-actions"
import { validateAnswers } from "@vimex/approvals"
import type { DisplayPreferences } from "./display-preferences"
import { createRpcEventReplay } from "./rpc-event-replay"
import {
  NavigationHistory,
  navigationLocation,
  restoreNavigationLocation,
  hasRecordedJump,
  type NavigationLocation,
} from "./navigation-history"
import { invalidateRuntimeState } from "./runtime-recovery"
import {
  ConversationIngress,
  type ConversationIngressScheduler,
} from "./conversation-ingress"
import type { ConversationState } from "@vimex/conversation"

export interface ControllerPorts {
  conversation: ConversationGateway
  approvals: ApprovalGateway
  connection: RuntimeConnection
  models: ModelCatalog
  resolveDirectory(base: string, path: string): string
  clipboard: { writeText(text: string): Promise<void> }
  images?: {
    fromClipboard(): Promise<{ label: string; path: string } | undefined>
    fromPath(path: string): Promise<{ label: string; path: string }>
  }
  openUrl(url: string): Promise<void>
  quit(): void
  /** Legacy broad observer retained for compatibility and tests. */
  onState?(state: WorkbenchState): void
  onLocalState?(state: LocalState): void
  onLifecycle?(state: WorkbenchLifecycleSnapshot): void
  onPerformanceMark?(mark: {
    kind: "submit" | "navigation"
    phase:
      | "accepted"
      | "attempted"
      | "input"
      | "state_published"
      | "adapter_start"
      | "request_sent"
      | "next_thread_activity"
      | "next_thread_content"
      | "next_thread_content_committed"
    operationId?: string
    burstId?: string
    atMs: number
    detail?: {
      transcriptItems?: number
      visibleBlocks?: number
      action?: Parameters<
        NonNullable<WorkbenchActions["performanceNavigationInput"]>
      >[0]
    }
  }): void
  exportPerformance?(): Promise<string>
  localState?: LocalState
  preferences?: PreferenceStore
  busySubmit?: "queue" | "steer"
  conversationIngressScheduler?: ConversationIngressScheduler
  conversationIngressCadenceMs?: number
}
const profiledNavigationCommands = new Set([
  "cursor.move",
  "cursor.reveal",
  "jump.to",
  "jump.back",
  "jump.forward",
  "mark.jump",
  "search.jump",
  "viewport.anchor",
  "tail.attach",
])
const navigationBurstIdleMs = 120
const navigationBurstAssociationMs = 250
function isNonUserContentEvent(
  event: ConversationEvent,
  conversation?: ConversationState,
): boolean {
  if (event.type === "item.started" || event.type === "item.completed")
    return event.item.kind !== "user"
  if (event.type !== "item.delta" || !conversation) return false
  const kind = conversation.items[event.itemId]?.kind
  return kind !== undefined && kind !== "user"
}
interface TranscriptRuntimeHint {
  canonicalOnly?: boolean
  canonicalDamageByThread?: Readonly<Record<string, TranscriptDamage>>
  reveal?: {
    threadId: ThreadId
    presentationId: TranscriptPresentationId
    request: TranscriptRevealRequest
  }
  foldItemIds?: readonly ItemId[]
}

/** Returns bounded damage only when pre-event chronology proves a local change or tail admission. */
export function incrementalConversationEventDamage(
  conversation: ConversationState | undefined,
  event: ConversationEvent,
): Extract<TranscriptDamage, { kind: "blocks" }> | undefined {
  if (event.type === "item.delta")
    return { kind: "blocks", itemIds: [event.itemId] }
  if (!conversation) return undefined
  // A lifecycle report can also update an earlier child assignment row.
  if (
    (event.type === "item.started" || event.type === "item.completed") &&
    event.item.kind === "agent"
  )
    return undefined
  if (event.type === "turn.started") {
    return conversation.turns[event.turnId]
      ? undefined
      : { kind: "blocks", itemIds: [] }
  }
  if (event.type === "item.started") {
    const turn = conversation.turns[event.item.turnId]
    return !conversation.items[event.item.id] &&
      turn?.status === "running" &&
      conversation.turnIds.at(-1) === event.item.turnId &&
      !turnItemIdsHave(turn.itemIds, event.item.id)
      ? { kind: "blocks", itemIds: [event.item.id] }
      : undefined
  }
  if (event.type === "turn.completed") {
    const turn = conversation.turns[event.turnId]
    return turn?.status === "running" &&
      conversation.activeTurnId === event.turnId &&
      conversation.turnIds.at(-1) === event.turnId &&
      turn.itemIds.length <= 1
      ? { kind: "blocks", itemIds: [] }
      : undefined
  }
  if (event.type !== "item.completed") return undefined
  const existing = conversation.items[event.item.id]
  const turn = conversation.turns[event.item.turnId]
  return existing?.turnId === event.item.turnId &&
    Boolean(turn && turnItemIdsHave(turn.itemIds, event.item.id))
    ? { kind: "blocks", itemIds: [event.item.id] }
    : undefined
}

export class VimexController
  implements
    WorkbenchActions,
    TranscriptPresentationHost,
    WorkbenchPublicationHost
{
  private state = initialWorkbench()
  private readonly ingress: ConversationIngress
  private readonly transcriptRuntimes = new Map<
    TranscriptPresentationId,
    TranscriptRuntime
  >()
  /** Invalidates an older presentation pass when a runtime listener mutates authority reentrantly. */
  private runtimeSyncEpoch = 0
  private readonly urlChoiceIndexes = new WeakMap<
    readonly UrlCandidate[],
    Readonly<{
      members: WeakSet<object>
      firstByUrl: ReadonlyMap<string, UrlCandidate>
    }>
  >()
  private revealRevision = 0
  private readonly sides = new SideChatCoordinator({
    state: () => this.state,
    update: (side) => {
      let next = {
        ...this.state,
        sideChats: { ...this.state.sideChats, [side.parentId]: side },
      }
      const workspace = side.threadId
        ? next.workspaces[side.threadId]
        : undefined
      if (side.status === "quitting" && side.threadId && workspace)
        next = {
          ...next,
          workspaces: {
            ...next.workspaces,
            [side.threadId]: {
              ...workspace,
              composer: {
                ...workspace.composer,
                outbox: workspace.composer.outbox.map((message) =>
                  message.status === "queued"
                    ? {
                        ...message,
                        status: "failed" as const,
                        reason:
                          "Canceled because side chat is quitting; retry explicitly if retirement fails",
                      }
                    : message,
                ),
              },
            },
          },
        }
      this.setState(next)
    },
    discard: (parent) => {
      const sideChats = { ...this.state.sideChats }
      delete sideChats[parent]
      this.setState({ ...this.state, sideChats })
    },
    remove: (parent, retired) => {
      this.ingress.flush()
      const sideRuntime = this.transcriptRuntimes.get("side")
      if (sideRuntime?.getThreadId() === retired) {
        sideRuntime.dispose()
        this.transcriptRuntimes.delete("side")
      }
      const sideChats = { ...this.state.sideChats }
      delete sideChats[parent]
      const summaries = { ...this.state.summaries }
      delete summaries[retired]
      const workspaces = { ...this.state.workspaces }
      delete workspaces[retired]
      this.navigationHistory.removeThread(retired)
      this.loaded.delete(retired)
      this.buffered.delete(retired)
      const approvals = {
        order: this.state.approvals.order.filter(
          (id) => this.state.approvals.byId[id]?.threadId !== retired,
        ),
        byId: Object.fromEntries(
          Object.entries(this.state.approvals.byId).filter(
            ([, approval]) => approval.threadId !== retired,
          ),
        ),
      }
      const compactingThreads = { ...this.state.compactingThreads }
      delete compactingThreads[retired]
      const interruptingTurns = { ...this.state.interruptingTurns }
      delete interruptingTurns[retired]
      const questions = Object.fromEntries(
        Object.entries(this.state.questions).filter(
          ([, request]) => request.threadId !== retired,
        ),
      )
      this.setState({
        ...this.state,
        sideChats,
        summaries,
        workspaces,
        approvals,
        questions,
        compactingThreads,
        interruptingTurns,
        threadOrder: this.state.threadOrder.filter((id) => id !== retired),
        favoriteThreadIds: this.state.favoriteThreadIds.filter(
          (id) => id !== retired,
        ),
        agentRelationships: this.state.agentRelationships.filter(
          (link) => link.childId !== retired && link.parentId !== retired,
        ),
        retiredSideThreadIds: [
          ...new Set([...this.state.retiredSideThreadIds, retired]),
        ],
      })
    },
    focus: (id) => {
      this.historyNavigation = undefined
      return this.navigateThread(id)
    },
    hydrate: (snapshot) => this.hydrate(snapshot, false),
    fork: async (parent) => {
      if (!this.ports.conversation.forkSideThread)
        throw new Error("This runtime cannot create side chats")
      const epoch = this.runtimeEpoch
      const snapshot = await this.ports.conversation.forkSideThread(parent)
      if (!this.currentRuntime(epoch))
        throw new Error("Runtime changed while creating side chat")
      return snapshot
    },
    retire: async (id) => {
      if (!this.ports.conversation.retireThread)
        throw new Error("This runtime cannot retire side chats")
      const epoch = this.runtimeEpoch
      const assertRuntime = () => {
        if (!this.currentRuntime(epoch))
          throw new Error("Runtime changed while quitting side chat")
      }
      await Promise.all([
        ...(this.threadContinuations.get(id) ?? []),
        this.threadMutations.get(id)?.catch(() => {}),
      ])
      assertRuntime()
      if (!this.loaded.has(id)) {
        const epoch = this.runtimeEpoch
        const snapshot = await this.ports.conversation.resumeThread(id)
        if (!this.currentRuntime(epoch))
          throw new Error("Runtime changed while quitting side chat")
        this.hydrate(snapshot, false)
      }
      if (!sideChatForChild(this.state, id)?.ephemeral)
        await this.ports.conversation.clearGoal?.(id)
      assertRuntime()
      const turn = this.state.workspaces[id]?.conversation.activeTurnId
      if (turn) await this.ports.conversation.interruptTurn(id, turn)
      assertRuntime()
      await this.ports.conversation.retireThread(id)
      assertRuntime()
    },
    send: (id, text) => {
      if (this.state.compactingThreads[id]) {
        this.notice("Wait for side chat compaction before sending a question")
        return
      }
      if (!this.loaded.has(id)) {
        this.notice("Open the side chat successfully before sending a question")
        return
      }
      const draft = this.state.workspaces[id]?.composer
      this.dispatch({ type: "composer.change", threadId: id, text })
      this.dispatch({
        type: "composer.submit",
        threadId: id,
        intent: "next-turn",
        clientMessageId: crypto.randomUUID(),
      })
      if (draft?.text)
        this.dispatch({
          type: "composer.change",
          threadId: id,
          text: draft.text,
          cursorOffset: draft.cursorOffset,
        })
    },
    quote: (id, text) => {
      const previous = this.state.workspaces[id]?.composer.text ?? ""
      const next = `${previous}${previous ? "\n\n" : ""}${text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}`
      this.dispatch({
        type: "composer.change",
        threadId: id,
        text: next,
        cursorOffset: next.length,
      })
      this.dispatch({
        type: "interaction.command",
        threadId: id,
        command: { type: "focus.set", surface: "composer" },
      })
    },
    presentedTranscript: (id) => {
      const context = this.presentationContext("side")
      return context?.threadId === id ? context.transcript : undefined
    },
    notice: (message) => this.notice(message),
    launch: (operation) => {
      this.launch(operation)
    },
  })
  sideChat = (action: SideChatAction, question?: string): void =>
    this.sides.action(action, question)
  anchorThread = (
    id: ThreadId,
    point: LogicalPoint,
    preferredScreenRow: number,
  ): void => {
    this.dispatch({
      type: "transcript.command",
      threadId: id,
      command: { type: "viewport.anchor", point, preferredScreenRow },
    })
  }
  private readonly listeners = new Set<() => void>()
  private readonly layoutListeners = new Set<() => void>()
  private readonly presentationListeners: Record<
    TranscriptPresentationId,
    Set<() => void>
  > = { main: new Set(), side: new Set() }
  private layoutSnapshot!: WorkbenchLayoutSnapshot
  private publicationContext!: WorkbenchPublicationContext
  private readonly presentationSnapshots = new Map<
    TranscriptPresentationId,
    WorkbenchState
  >()
  private readonly pending = new Set<Promise<void>>()
  private readonly threadContinuations = new Map<ThreadId, Set<Promise<void>>>()
  private readonly loaded = new Set<ThreadId>()
  private catalogThreadIds = new Set<ThreadId>()
  private sessionCatalogRequest?: Promise<void>
  private readonly buffered = new Map<ThreadId, ConversationEvent[]>()
  private readonly resumes = new Map<ThreadId, Promise<SessionSnapshot>>()
  private unsubscribe?: () => void
  private catalogRequest?: {
    epoch: number
    promise: Promise<readonly AvailableModel[]>
  }
  private readonly navigationHistory = new NavigationHistory()
  private historyNavigation?: { queue: ("back" | "forward")[] }
  private navigationRevision = 0
  private initialization?: Promise<void>
  private restartPending = false
  private restartBarrier?: Promise<void>
  private runtimeEpoch = 0
  private readonly answering = new Map<string, symbol>()
  private readonly pendingImages = new Map<ThreadId, number>()
  private readonly pendingSubmitActivity = new Map<
    ThreadId,
    {
      operationId: string
      nextThreadActivity: boolean
      nextThreadContent: boolean
      nextThreadContentCommitted: boolean
    }
  >()
  private navigationPerformanceSequence = 0
  private navigationBurstSequence = 0
  private activeNavigationBurst?: { id: string; lastInputAtMs: number }
  private pendingNavigationInput?: { operationId: string; atMs: number }
  private readonly threadMutations = new Map<ThreadId, Promise<void>>()
  private preferenceTail: Promise<void> = Promise.resolve()
  private preferenceRevision = 0
  private desiredPreferences?: DisplayPreferences
  private recoveryViews: Record<string, SavedThreadView> = {}
  private initialDirectory?: string
  private initialModel?: string
  private closing = false
  private closePromise?: Promise<void>
  private localStateSnapshot: LocalState
  private lifecycleSignature: string
  private signalClosing!: () => void
  private readonly closingSignal = new Promise<void>((resolve) => {
    this.signalClosing = resolve
  })
  constructor(private readonly ports: ControllerPorts) {
    this.ingress = new ConversationIngress(
      (events) => this.commitConversationEvents(events),
      {
        scheduler: ports.conversationIngressScheduler,
        cadenceMs: ports.conversationIngressCadenceMs,
        onError: (error) =>
          this.notice(error instanceof Error ? error.message : String(error)),
      },
    )
    this.state = {
      ...this.state,
      favoriteThreadIds: [
        ...new Set(ports.localState?.favoriteThreadIds ?? []),
      ].map(threadId),
      sideChats: Object.freeze(
        Object.fromEntries(
          Object.entries(ports.localState?.sideChats ?? {}).map(
            ([id, side]) => [
              id,
              side.inheritedTurnIds
                ? {
                    ...side,
                    inheritedTurnIds: persistentConversationTurnIds(
                      side.inheritedTurnIds,
                    ),
                  }
                : side,
            ],
          ),
        ),
      ),
      retiredSideThreadIds: (ports.localState?.retiredSideThreadIds ?? []).map(
        threadId,
      ),
    }
    if (ports.preferences) {
      this.desiredPreferences = ports.preferences.initial
      this.state = { ...this.state, preferences: ports.preferences.initial }
    }
    this.localStateSnapshot = ports.localState ?? emptyLocalState()
    this.lifecycleSignature = workbenchLifecycleSignature(
      captureWorkbenchLifecycle(this.state),
    )
    this.publicationContext = captureWorkbenchPublicationContext(this.state)
    this.layoutSnapshot = captureWorkbenchLayout(
      this.state,
      this.publicationContext,
    )
    this.presentationSnapshots.set(
      "main",
      captureWorkbenchPresentation(this.state, "main", this.publicationContext),
    )
    this.presentationSnapshots.set(
      "side",
      captureWorkbenchPresentation(this.state, "side", this.publicationContext),
    )
  }
  private performanceMark(
    kind: "submit" | "navigation",
    phase:
      | "accepted"
      | "attempted"
      | "input"
      | "state_published"
      | "adapter_start"
      | "request_sent"
      | "next_thread_activity"
      | "next_thread_content"
      | "next_thread_content_committed",
    operationId: string,
    detail?: {
      transcriptItems?: number
      visibleBlocks?: number
      action?: Parameters<
        NonNullable<WorkbenchActions["performanceNavigationInput"]>
      >[0]
    },
    burstId?: string,
  ): void {
    if (!this.ports.onPerformanceMark) return
    const atMs = performance.now()
    try {
      this.ports.onPerformanceMark({
        kind,
        phase,
        operationId,
        ...(burstId ? { burstId } : {}),
        atMs,
        detail,
      })
    } catch {
      // Measurements must never affect an interaction.
    }
  }
  private navigationPerformanceDetail(
    state: WorkbenchState,
    thread?: ThreadId,
  ): { transcriptItems?: number; visibleBlocks?: number } {
    const target = thread ?? state.activeThreadId
    const transcriptItems = target
      ? state.workspaces[target]?.transcript.order.length
      : undefined
    const presentation = this.activeTranscriptPresentation()
    const runtime = presentation
      ? this.transcriptRuntimes.get(presentation)
      : undefined
    const visibleBlocks =
      runtime && runtime.getThreadId() === target
        ? runtime.getSnapshot().window.blocks.length
        : undefined
    return { transcriptItems, visibleBlocks }
  }
  performanceNavigationInput: NonNullable<
    WorkbenchActions["performanceNavigationInput"]
  > = (action) => {
    if (!this.ports.onPerformanceMark || this.closing) return
    const atMs = performance.now()
    if (
      !this.activeNavigationBurst ||
      atMs - this.activeNavigationBurst.lastInputAtMs > navigationBurstIdleMs
    )
      this.activeNavigationBurst = {
        id: `navigation-burst-${++this.navigationBurstSequence}`,
        lastInputAtMs: atMs,
      }
    else this.activeNavigationBurst.lastInputAtMs = atMs
    const operationId = `navigation-${++this.navigationPerformanceSequence}`
    this.pendingNavigationInput = { operationId, atMs }
    this.performanceMark(
      "navigation",
      "input",
      operationId,
      { action },
      this.activeNavigationBurst.id,
    )
  }
  getSnapshot = (): WorkbenchState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getLayoutSnapshot = (): WorkbenchLayoutSnapshot => this.layoutSnapshot
  subscribeLayout = (listener: () => void): (() => void) => {
    this.layoutListeners.add(listener)
    return () => this.layoutListeners.delete(listener)
  }
  getPresentationSnapshot = (
    presentationId: TranscriptPresentationId,
  ): WorkbenchState => this.presentationSnapshots.get(presentationId)!
  subscribePresentation = (
    presentationId: TranscriptPresentationId,
    listener: () => void,
  ): (() => void) => {
    this.presentationListeners[presentationId].add(listener)
    return () => this.presentationListeners[presentationId].delete(listener)
  }

  private presentationThread(
    state: WorkbenchState,
    presentationId: TranscriptPresentationId,
  ): ThreadId | undefined {
    return threadForPresentation(
      state,
      presentationId,
      state === this.state ? this.publicationContext : undefined,
    )
  }
  private canonicalDamage(
    before: ThreadWorkspace | undefined,
    after: ThreadWorkspace,
  ): TranscriptDamage {
    if (!before || before.canonicalGeneration !== after.canonicalGeneration)
      return { kind: "full" }
    if (before.canonicalRevision === after.canonicalRevision)
      return { kind: "none" }
    const ids = new Set<ItemId>(
      [
        ...Object.keys(before.conversation.items),
        ...Object.keys(after.conversation.items),
      ].map((id) => id as ItemId),
    )
    const changed = [...ids].filter(
      (id) => before.conversation.items[id] !== after.conversation.items[id],
    )
    const turnPresentationChanged =
      before.conversation.turnIds !== after.conversation.turnIds ||
      Object.keys(before.conversation.turns).some((id) => {
        const left = before.conversation.turns[id],
          right = after.conversation.turns[id]
        return (
          !left ||
          !right ||
          left.status !== right.status ||
          left.startedAt !== right.startedAt ||
          left.completedAt !== right.completedAt ||
          left.durationMs !== right.durationMs
        )
      }) ||
      Object.keys(after.conversation.turns).some(
        (id) => !before.conversation.turns[id],
      )
    return turnPresentationChanged
      ? { kind: "full" }
      : changed.length
        ? { kind: "blocks", itemIds: changed }
        : { kind: "full" }
  }
  private runtimeInput(
    presentationId: TranscriptPresentationId,
    state: WorkbenchState,
    before?: WorkbenchState,
    hint: TranscriptRuntimeHint = {},
  ): TranscriptRuntimeInput | undefined {
    const thread = this.presentationThread(state, presentationId)
    const workspace = thread ? state.workspaces[thread] : undefined
    if (!thread || !workspace) return undefined
    const previous = before?.workspaces[thread]
    const side = sideChatForChild(state, thread)
    const transcriptChanged =
      previous && previous.transcript !== workspace.transcript
    const presentationDamage: TranscriptDamage =
      hint.canonicalOnly || !transcriptChanged
        ? { kind: "none" }
        : previous.transcript.folded !== workspace.transcript.folded
          ? hint.foldItemIds?.length
            ? { kind: "folds", itemIds: hint.foldItemIds }
            : { kind: "layout" }
          : { kind: "view" }
    return {
      threadId: thread,
      canonicalGeneration: workspace.canonicalGeneration,
      canonicalRevision: workspace.canonicalRevision,
      conversation: workspace.conversation,
      transcript: workspace.transcript,
      mode:
        workspace.transcript.viewport.kind === "tail" ? "follow" : "detached",
      canonicalDamage:
        hint.canonicalDamageByThread?.[thread] ??
        this.canonicalDamage(previous, workspace),
      presentationDamage,
      reveal:
        hint.reveal?.threadId === thread &&
        hint.reveal.presentationId === presentationId
          ? hint.reveal.request
          : undefined,
      excludedTurnIds: side?.inheritedTurnIds,
    }
  }
  private syncTranscriptRuntimes(
    before: WorkbenchState,
    state: WorkbenchState,
    hint: TranscriptRuntimeHint = {},
  ): void {
    const epoch = ++this.runtimeSyncEpoch
    for (const [presentationId, runtime] of this.transcriptRuntimes) {
      if (epoch !== this.runtimeSyncEpoch) return
      const input = this.runtimeInput(presentationId, state, before, hint)
      if (input) runtime.update(input)
      // Runtime listeners are synchronous and may commit a newer Workbench
      // state. That nested pass starts again at the first presentation; the
      // older pass must not continue and overwrite a later presentation with
      // its captured state.
      if (epoch !== this.runtimeSyncEpoch) return
    }
  }
  transcriptRuntime = (
    presentationId: TranscriptPresentationId,
  ): TranscriptRuntime | undefined => {
    if (this.closing) return undefined
    const input = this.runtimeInput(presentationId, this.state)
    if (!input) return undefined
    let runtime = this.transcriptRuntimes.get(presentationId)
    if (!runtime) {
      runtime = new TranscriptRuntime(input, {
        windowPolicy: defaultTranscriptWindowPolicy,
      })
      this.transcriptRuntimes.set(presentationId, runtime)
    }
    return runtime
  }

  /** Resolves presentation-owned reads without moving authority into React. */
  private presentationContext(presentationId: TranscriptPresentationId):
    | {
        threadId: ThreadId
        workspace: ThreadWorkspace
        transcript: TranscriptState
        displayedCanonicalRevision: number
      }
    | undefined {
    const threadId = this.presentationThread(this.state, presentationId)
    const workspace = threadId ? this.state.workspaces[threadId] : undefined
    const runtime = this.transcriptRuntime(presentationId)
    if (!threadId || !workspace || runtime?.getThreadId() !== threadId)
      return undefined
    const frame = runtime.getSnapshot()
    return {
      threadId,
      workspace,
      transcript: frame.transcript,
      displayedCanonicalRevision: frame.displayedCanonicalRevision,
    }
  }

  private activeTranscriptPresentation(): TranscriptPresentationId | undefined {
    const active = this.state.activeThreadId
    if (!active) return undefined
    if (this.presentationThread(this.state, "side") === active) return "side"
    if (this.presentationThread(this.state, "main") === active) return "main"
    return undefined
  }

  private readTranscript(
    command: Extract<
      TranscriptAction,
      { type: "reference" | "copy" | "url.open" }
    >,
  ): void {
    const context = this.presentationContext(command.presentationId)
    if (!context) return
    const { threadId, workspace, transcript, displayedCanonicalRevision } =
      context
    if (command.type === "reference") {
      const text = referenceText(transcript, "source")
      if (!text) {
        this.notice("No transcript content selected")
        return
      }
      const draft =
        [
          workspace.composer.text,
          text
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        ]
          .filter(Boolean)
          .join("\n\n") + "\n\n"
      this.dispatch({
        type: "composer.change",
        threadId,
        text: draft,
        cursorOffset: graphemeCount(draft),
      })
      this.dispatch({
        type: "interaction.command",
        threadId,
        command: { type: "mode.insert" },
      })
      return
    }
    if (command.type === "copy") {
      const text = selectedText(transcript, command.format)
      if (text === undefined) return
      const shape =
        transcript.selection?.shape === "line" ? "line" : "character"
      this.dispatch({ type: "transcript.yank", threadId, text, shape })
      return
    }

    if (command.url || command.candidate) {
      const owner = this.state.urlChoiceOwner
      const pickerChoices = this.state.urlChoices
      const pickerIndex =
        pickerChoices && this.urlChoiceIndexes.get(pickerChoices)
      const chosen =
        command.candidate ?? pickerIndex?.firstByUrl.get(command.url ?? "")
      const exact =
        chosen &&
        pickerIndex?.members.has(chosen) &&
        urlCandidateInScope(transcript, chosen, owner?.scope ?? "current-item")
      if (
        !owner ||
        owner.threadId !== threadId ||
        owner.presentationId !== command.presentationId ||
        owner.displayedCanonicalRevision !== displayedCanonicalRevision ||
        !exact
      ) {
        this.notice("That URL is no longer available in the active picker")
        return
      }
      this.dispatch({ type: "url.picker", threadId, url: chosen.url })
      return
    }
    const selected = transcript.selection
      ? urlCandidates(transcript, "selection")
      : []
    const underCursor = selected.length ? undefined : urlAt(transcript)
    const candidates = selected.length
      ? selected
      : urlCandidates(transcript, "current-item")
    const url =
      (selected.length === 1 ? selected[0]?.url : underCursor) ??
      (candidates.length === 1 ? candidates[0]?.url : undefined)
    if (url) {
      this.dispatch({ type: "url.picker", threadId, url })
    } else if (candidates.length > 1) {
      const firstByUrl = new Map<string, UrlCandidate>()
      for (const candidate of candidates)
        if (!firstByUrl.has(candidate.url))
          firstByUrl.set(candidate.url, candidate)
      this.urlChoiceIndexes.set(
        candidates,
        Object.freeze({
          members: new WeakSet(candidates),
          firstByUrl,
        }),
      )
      this.dispatch({
        type: "url.picker",
        threadId,
        choices: candidates,
        owner: {
          threadId,
          presentationId: command.presentationId,
          displayedCanonicalRevision,
          scope: selected.length ? "selection" : "current-item",
        },
      })
    } else this.notice("No URL at this transcript position")
  }

  private setState(
    state: WorkbenchState,
    hint: TranscriptRuntimeHint = {},
  ): void {
    if (this.closing) return
    if (this.state === state) return
    const before = this.state
    this.state = state
    const viewChanges = this.prepareWorkbenchViews(before)
    this.syncTranscriptRuntimes(before, state, hint)
    this.notifyWorkbenchViews(viewChanges)
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* observers cannot roll back an authoritative state change */
      }
    }
    this.publishExternalObservers(before)
  }

  private prepareWorkbenchViews(before: WorkbenchState): {
    layout: boolean
    presentations: readonly TranscriptPresentationId[]
  } {
    const beforeContext = this.publicationContext
    const afterContext = captureWorkbenchPublicationContext(
      this.state,
      beforeContext,
    )
    const layout = workbenchLayoutChanged(
      before,
      this.state,
      beforeContext,
      afterContext,
    )
    if (layout) {
      this.layoutSnapshot = captureWorkbenchLayout(this.state, afterContext)
    }
    const presentations = (["main", "side"] as const).filter(
      (presentationId) => {
        if (
          !workbenchPresentationChanged(
            before,
            this.state,
            presentationId,
            beforeContext,
            afterContext,
          )
        )
          return false
        this.presentationSnapshots.set(
          presentationId,
          captureWorkbenchPresentation(
            this.state,
            presentationId,
            afterContext,
          ),
        )
        return true
      },
    )
    this.publicationContext = afterContext
    return { layout, presentations }
  }

  private notifyWorkbenchViews(changes: {
    layout: boolean
    presentations: readonly TranscriptPresentationId[]
  }): void {
    if (changes.layout) {
      for (const listener of this.layoutListeners) {
        try {
          listener()
        } catch {
          /* one view cannot suppress its peers */
        }
      }
    }
    for (const presentationId of changes.presentations) {
      for (const listener of this.presentationListeners[presentationId]) {
        try {
          listener()
        } catch {
          /* one pane cannot suppress its peer */
        }
      }
    }
  }

  private publishExternalObservers(
    before: WorkbenchState,
    changedThreadIds?: readonly ThreadId[],
  ): void {
    try {
      this.ports.onState?.(this.state)
    } catch {
      /* legacy observers are isolated */
    }

    if (localViewChanged(before, this.state, changedThreadIds)) {
      const next = captureLocalState(this.state, this.localStateSnapshot)
      if (!sameLocalState(next, this.localStateSnapshot)) {
        this.localStateSnapshot = next
        try {
          this.ports.onLocalState?.(next)
        } catch {
          /* persistence owns its failure policy */
        }
      }
    }

    if (workbenchLifecycleChanged(before, this.state)) {
      const lifecycle = captureWorkbenchLifecycle(this.state)
      const lifecycleSignature = workbenchLifecycleSignature(lifecycle)
      if (lifecycleSignature !== this.lifecycleSignature) {
        this.lifecycleSignature = lifecycleSignature
        try {
          this.ports.onLifecycle?.(lifecycle)
        } catch {
          /* lifecycle integrations are advisory */
        }
      }
    }
  }
  private retiringThread(id: ThreadId): boolean {
    const side = sideChatForChild(this.state, id)
    return (
      this.state.retiredSideThreadIds.includes(id) ||
      side?.status === "quitting"
    )
  }
  private trackContinuation(
    id: ThreadId,
    pending: Promise<void> | undefined,
  ): void {
    if (!pending) return
    const continuations =
      this.threadContinuations.get(id) ?? new Set<Promise<void>>()
    continuations.add(pending)
    this.threadContinuations.set(id, continuations)
    void pending.finally(() => {
      continuations.delete(pending)
      if (!continuations.size) this.threadContinuations.delete(id)
    })
  }
  /** Applies one ingress cadence as one canonical publication. */
  private commitConversationEvents(events: readonly ConversationEvent[]): void {
    const beforeBatch = this.state
    let state = beforeBatch
    const navigationHistory = this.navigationHistory.clone()
    const effects: WorkbenchEffect[] = []
    const damagedItems = new Map<ThreadId, Set<ItemId>>()
    const fullDamage = new Set<ThreadId>()
    for (const event of events) {
      if (state.retiredSideThreadIds.includes(event.threadId)) continue
      const before = state
      const result = transitionWorkbench(before, {
        type: "conversation.event",
        event,
      })
      if (result.state !== before) {
        const incrementalDamage = incrementalConversationEventDamage(
          before.workspaces[event.threadId]?.conversation,
          event,
        )
        if (!incrementalDamage) {
          fullDamage.add(event.threadId)
          damagedItems.delete(event.threadId)
        } else if (!fullDamage.has(event.threadId)) {
          const ids = damagedItems.get(event.threadId) ?? new Set<ItemId>()
          for (const itemId of incrementalDamage.itemIds) ids.add(itemId)
          damagedItems.set(event.threadId, ids)
        }
      }
      navigationHistory.reproject(before, result.state, event.threadId)
      state = result.state
      effects.push(...result.effects)
    }
    if (state === this.state) {
      for (const event of events)
        if (event.type === "turn.completed")
          this.pendingSubmitActivity.delete(event.threadId)
      return
    }
    this.navigationHistory.adopt(navigationHistory)
    const canonicalDamageByThread: Record<string, TranscriptDamage> = {}
    for (const id of fullDamage) canonicalDamageByThread[id] = { kind: "full" }
    for (const [id, itemIds] of damagedItems)
      canonicalDamageByThread[id] = { kind: "blocks", itemIds: [...itemIds] }
    this.state = state
    const viewChanges = this.prepareWorkbenchViews(beforeBatch)
    this.syncTranscriptRuntimes(beforeBatch, state, {
      canonicalOnly: true,
      canonicalDamageByThread,
    })
    this.notifyWorkbenchViews(viewChanges)
    if (!this.closing) {
      // Canonical commit is authoritative even if a renderer observer is faulty.
      for (const listener of this.listeners) {
        try {
          listener()
        } catch {
          /* observers cannot roll back an ingress commit */
        }
      }
      this.publishExternalObservers(beforeBatch, [
        ...new Set(events.map((event) => event.threadId)),
      ])
      for (const event of events) {
        const pending = this.pendingSubmitActivity.get(event.threadId)
        if (
          pending &&
          !pending.nextThreadContentCommitted &&
          isNonUserContentEvent(
            event,
            state.workspaces[event.threadId]?.conversation,
          )
        ) {
          pending.nextThreadContentCommitted = true
          this.performanceMark(
            "submit",
            "next_thread_content_committed",
            pending.operationId,
          )
        }
        if (event.type === "turn.completed")
          this.pendingSubmitActivity.delete(event.threadId)
      }
    }
    if (this.closing) {
      this.publishExternalObservers(beforeBatch, [
        ...new Set(events.map((event) => event.threadId)),
      ])
      return
    }
    for (const effect of effects) {
      const pending = this.launch(() => this.effect(effect))
      if (
        effect.type === "conversation.turn.start" ||
        effect.type === "conversation.turn.steer"
      )
        this.trackContinuation(effect.threadId, pending)
    }
  }
  dispatch(command: WorkbenchCommand): void {
    if (this.closing) return
    if (
      "threadId" in command &&
      command.threadId &&
      this.state.retiredSideThreadIds.includes(command.threadId)
    )
      return
    if (
      command.type === "conversation.event" &&
      this.state.retiredSideThreadIds.includes(command.event.threadId)
    )
      return
    const recipient =
      command.type === "composer.submit" || command.type === "composer.retry"
        ? (command.threadId ?? this.state.activeThreadId)
        : command.type === "approval.resolve"
          ? this.state.approvals.byId[command.approvalId]?.threadId
          : undefined
    if (recipient && this.retiringThread(recipient)) {
      this.notice("Side chat is quitting; new work is paused")
      return
    }
    const performanceKind =
      command.type === "composer.submit"
        ? "submit"
        : (command.type === "transcript.command" ||
              command.type === "transcript.navigate") &&
            profiledNavigationCommands.has(command.command.type)
          ? "navigation"
          : undefined
    const performanceOperationId =
      performanceKind === "submit"
        ? command.type === "composer.submit"
          ? command.clientMessageId
          : undefined
        : performanceKind === "navigation"
          ? this.pendingNavigationInput &&
            performance.now() - this.pendingNavigationInput.atMs < 250
            ? this.pendingNavigationInput.operationId
            : `navigation-${++this.navigationPerformanceSequence}`
          : undefined
    const performanceBurstId =
      performanceKind === "navigation" &&
      this.activeNavigationBurst &&
      performance.now() - this.activeNavigationBurst.lastInputAtMs <
        navigationBurstAssociationMs
        ? this.activeNavigationBurst.id
        : undefined
    if (performanceKind === "navigation")
      this.pendingNavigationInput = undefined
    if (performanceKind && performanceOperationId)
      this.performanceMark(
        performanceKind,
        performanceKind === "submit" ? "attempted" : "accepted",
        performanceOperationId,
        performanceKind === "navigation" &&
          (command.type === "transcript.command" ||
            command.type === "transcript.navigate")
          ? this.navigationPerformanceDetail(this.state, command.threadId)
          : undefined,
        performanceBurstId,
      )
    const before = this.state
    const result = transitionWorkbench(before, command)
    const submitAccepted =
      command.type === "composer.submit" &&
      recipient !== undefined &&
      !before.workspaces[recipient]?.composer.outbox.some(
        (message) => message.id === command.clientMessageId,
      ) &&
      Boolean(
        result.state.workspaces[recipient]?.composer.outbox.some(
          (message) => message.id === command.clientMessageId,
        ),
      )
    if (submitAccepted && performanceOperationId)
      this.performanceMark("submit", "accepted", performanceOperationId)
    if (command.type === "conversation.event")
      this.navigationHistory.reproject(
        before,
        result.state,
        command.event.threadId,
      )
    const transcriptCommand =
      command.type === "transcript.command" ||
      command.type === "transcript.navigate"
        ? command.command
        : undefined
    const localJump =
      transcriptCommand &&
      (transcriptCommand.type === "jump.to" ||
        transcriptCommand.type === "search.jump" ||
        transcriptCommand.type === "mark.jump") &&
      hasRecordedJump(before, result.state)
    const switched = before.activeThreadId !== result.state.activeThreadId
    if (localJump || switched) {
      this.navigationHistory.seed(before)
      const origin = navigationLocation(before)
      if (origin) {
        const explicit =
          transcriptCommand && "origin" in transcriptCommand
            ? transcriptCommand.origin
            : undefined
        this.navigationHistory.record(
          explicit
            ? {
                ...origin,
                cursor: explicit.point,
                viewport: { kind: "point", ...explicit },
              }
            : origin,
        )
      }
      if (localJump) {
        this.navigationRevision++
        this.historyNavigation = undefined
      }
    }
    const revealThread =
      command.type === "transcript.command" ||
      command.type === "transcript.navigate"
        ? (command.threadId ?? before.activeThreadId)
        : undefined
    const priorTranscript = revealThread
      ? before.workspaces[revealThread]?.transcript
      : undefined
    const nextTranscript = revealThread
      ? result.state.workspaces[revealThread]?.transcript
      : undefined
    const targetCommand =
      transcriptCommand &&
      (transcriptCommand.type === "cursor.move" ||
        transcriptCommand.type === "cursor.reveal" ||
        transcriptCommand.type === "jump.to" ||
        transcriptCommand.type === "search.jump" ||
        transcriptCommand.type === "selection.swap" ||
        transcriptCommand.type === "jump.back" ||
        transcriptCommand.type === "jump.forward" ||
        transcriptCommand.type === "mark.jump")
    const revealChanged =
      priorTranscript &&
      nextTranscript &&
      (priorTranscript.cursor?.itemId !== nextTranscript.cursor?.itemId ||
        priorTranscript.cursor?.graphemeOffset !==
          nextTranscript.cursor?.graphemeOffset ||
        JSON.stringify(priorTranscript.viewport) !==
          JSON.stringify(nextTranscript.viewport) ||
        priorTranscript.folded !== nextTranscript.folded)
    const revealPoint =
      targetCommand && revealChanged && nextTranscript
        ? nextTranscript.viewport.kind === "point"
          ? nextTranscript.viewport.point
          : nextTranscript.cursor
        : undefined
    const revealReason: TranscriptRevealRequest["reason"] =
      command.type === "transcript.navigate" && command.revealReason
        ? command.revealReason
        : transcriptCommand?.type === "search.jump"
          ? "search"
          : transcriptCommand?.type === "mark.jump"
            ? "mark"
            : transcriptCommand &&
                (transcriptCommand.type === "jump.to" ||
                  transcriptCommand.type === "jump.back" ||
                  transcriptCommand.type === "jump.forward")
              ? "jump"
              : "cursor"
    const presentationId = this.activeTranscriptPresentation()
    const explicitFoldItem =
      transcriptCommand?.type === "fold.set" ||
      transcriptCommand?.type === "fold.toggle"
        ? transcriptCommand.itemId
        : undefined
    const revealedFoldItem =
      revealPoint &&
      priorTranscript?.folded[revealPoint.itemId] &&
      !nextTranscript?.folded[revealPoint.itemId]
        ? revealPoint.itemId
        : undefined
    const directConversationDamage =
      command.type === "conversation.event"
        ? incrementalConversationEventDamage(
            before.workspaces[command.event.threadId]?.conversation,
            command.event,
          )
        : undefined
    const hint: TranscriptRuntimeHint = {
      ...(explicitFoldItem || revealedFoldItem
        ? { foldItemIds: [explicitFoldItem ?? revealedFoldItem!] }
        : {}),
      ...(command.type === "conversation.event" && directConversationDamage
        ? {
            canonicalDamageByThread: {
              [command.event.threadId]: directConversationDamage,
            },
          }
        : {}),
      ...(revealThread && revealPoint && presentationId
        ? {
            reveal: {
              threadId: revealThread,
              presentationId,
              request: {
                id: ++this.revealRevision,
                point: revealPoint,
                reason: revealReason,
              },
            },
          }
        : {}),
    }
    this.setState(result.state, hint)
    if (
      performanceKind &&
      performanceOperationId &&
      (performanceKind === "submit"
        ? submitAccepted
        : priorTranscript !== nextTranscript && result.state !== before)
    )
      this.performanceMark(
        performanceKind,
        "state_published",
        performanceOperationId,
        performanceKind === "navigation" && revealThread
          ? this.navigationPerformanceDetail(this.state, revealThread)
          : undefined,
        performanceBurstId,
      )
    for (const effect of result.effects) {
      const pending = this.launch(() => this.effect(effect))
      if (
        effect.type === "conversation.turn.start" ||
        effect.type === "conversation.turn.steer"
      )
        this.trackContinuation(effect.threadId, pending)
      if (effect.type === "approval.resolve") {
        const id = before.approvals.byId[effect.approvalId]?.threadId
        if (id) this.trackContinuation(id, pending)
      }
    }
  }
  private launch(operation: () => Promise<void>): Promise<void> | undefined {
    if (this.closing) return undefined
    const promise = (async () => operation())().catch((error) => {
      if (!this.closing)
        this.notice(error instanceof Error ? error.message : String(error))
    })
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise))
    return promise
  }
  async settle(): Promise<void> {
    do {
      this.ingress.flush()
      if (this.pending.size) await Promise.all([...this.pending])
    } while (this.pending.size || this.ingress.hasPending)
  }
  notice(message: string): void {
    this.setState({ ...this.state, error: message })
  }

  private register(summary: SessionSnapshot["summary"]): void {
    if (this.state.retiredSideThreadIds.includes(summary.id)) return
    const current = this.state.summaries[summary.id]
    const withKnownCapability =
      current?.canAcceptDirectInput !== undefined &&
      summary.canAcceptDirectInput === undefined
        ? { ...summary, canAcceptDirectInput: current.canAcceptDirectInput }
        : summary
    this.dispatch({
      type: "thread.register",
      summary:
        (current?.titleSource === "name" && summary.titleSource !== "name") ||
        (current?.titleSource === "preview" &&
          summary.titleSource === "untitled")
          ? {
              ...withKnownCapability,
              title: current.title,
              titleSource: current.titleSource,
            }
          : withKnownCapability,
    })
  }
  private refreshSessionCatalog(): Promise<void> {
    if (this.sessionCatalogRequest) return this.sessionCatalogRequest
    const epoch = this.runtimeEpoch
    const request = (async () => {
      const summaries = await this.ports.conversation.listThreads()
      if (!this.currentRuntime(epoch)) return
      const previous = this.catalogThreadIds
      const visibleSummaries = summaries.filter(
        (summary) => !this.state.retiredSideThreadIds.includes(summary.id),
      )
      const current = new Set(visibleSummaries.map((summary) => summary.id))
      for (const summary of visibleSummaries) this.register(summary)
      const state = this.state
      const local = state.threadOrder.filter(
        (id) =>
          !previous.has(id) ||
          (id === state.activeThreadId && !current.has(id)),
      )
      const threadOrder = [
        ...new Set([
          ...local,
          ...visibleSummaries.map((summary) => summary.id),
        ]),
      ]
      const favoriteThreadIds = state.favoriteThreadIds.filter(
        (id) => !previous.has(id) || current.has(id),
      )
      this.catalogThreadIds = current
      this.setState({ ...state, threadOrder, favoriteThreadIds })
    })()
    this.sessionCatalogRequest = request
    void request.then(
      () => {
        if (this.sessionCatalogRequest === request)
          this.sessionCatalogRequest = undefined
      },
      () => {
        if (this.sessionCatalogRequest === request)
          this.sessionCatalogRequest = undefined
      },
    )
    return request
  }
  private async unlessClosing<T>(
    operation: Promise<T>,
  ): Promise<{ value: T } | undefined> {
    return Promise.race([
      operation.then((value) => ({ value })),
      this.closingSignal.then(() => undefined),
    ])
  }
  private currentRuntime(epoch: number): boolean {
    return !this.closing && epoch === this.runtimeEpoch
  }
  private hydrate(snapshot: SessionSnapshot, focus: boolean): void {
    this.ingress.flush()
    if (this.state.retiredSideThreadIds.includes(snapshot.summary.id)) return
    this.register(snapshot.summary)
    const side = sideChatForChild(this.state, snapshot.summary.id)
    const parentTurns =
      side && this.state.workspaces[side.parentId]?.conversation.turns
    if (
      side &&
      side.inheritedTurnIds === undefined &&
      parentTurns &&
      Object.keys(parentTurns).length
    ) {
      const inheritedTurnIds = persistentConversationTurnIds(
        [
          ...new Set(
            snapshot.events.flatMap((event) =>
              "turnId" in event
                ? [event.turnId]
                : "item" in event
                  ? [event.item.turnId]
                  : [],
            ),
          ),
        ].filter((id) => parentTurns[id]),
      )
      this.setState({
        ...this.state,
        sideChats: {
          ...this.state.sideChats,
          [side.parentId]: { ...side, inheritedTurnIds },
        },
      })
    }
    if (
      this.recoveryViews[snapshot.summary.id] &&
      !this.loaded.has(snapshot.summary.id)
    ) {
      const generation =
        (this.state.workspaces[snapshot.summary.id]?.canonicalGeneration ??
          -1) + 1
      this.setState({
        ...this.state,
        workspaces: {
          ...this.state.workspaces,
          [snapshot.summary.id]: createWorkspace(
            snapshot.summary.id,
            generation,
          ),
        },
      })
    }
    this.ingress.replay(snapshot.events)
    const saved =
      this.recoveryViews[snapshot.summary.id] ??
      this.ports.localState?.threads[snapshot.summary.id]
    const workspace = this.state.workspaces[snapshot.summary.id]
    if (saved && workspace && !this.loaded.has(snapshot.summary.id))
      this.setState({
        ...this.state,
        workspaces: {
          ...this.state.workspaces,
          [snapshot.summary.id]: restoreThreadView(workspace, saved),
        },
      })
    delete this.recoveryViews[snapshot.summary.id]
    this.loaded.add(snapshot.summary.id)
    const buffered = this.buffered.get(snapshot.summary.id) ?? []
    this.buffered.delete(snapshot.summary.id)
    for (const event of buffered) this.ingress.push(event)
    this.ingress.flush()
    if (focus)
      this.dispatch({ type: "thread.switch", threadId: snapshot.summary.id })
  }
  initialize(
    cwd: string,
    model?: string,
    resume?: string,
    resumeMode?: "picker" | "last",
  ): Promise<void> {
    if (this.closing) return Promise.resolve()
    return (this.initialization ??= this.runInitialize(
      cwd,
      model,
      resume,
      resumeMode,
    ))
  }
  private async runInitialize(
    cwd: string,
    model?: string,
    resume?: string,
    resumeMode?: "picker" | "last",
  ): Promise<void> {
    const epoch = this.runtimeEpoch
    const navigation = this.navigationRevision
    this.initialDirectory = cwd
    this.initialModel = model
    this.unsubscribe = this.ports.connection.subscribe((event) =>
      this.receive(event),
    )
    try {
      if (
        !(await this.unlessClosing(this.ports.connection.connect())) ||
        !this.currentRuntime(epoch)
      )
        return
      this.dispatch({ type: "connection.changed", connection: "connected" })
      const summaries = await this.unlessClosing(
        this.ports.conversation.listThreads(),
      )
      if (!summaries || !this.currentRuntime(epoch)) return
      this.catalogThreadIds = new Set(
        summaries.value.map((summary) => summary.id),
      )
      for (const summary of summaries.value) this.register(summary)
      if (resumeMode && !resume) {
        const matching = summaries.value
          .filter(
            (summary) =>
              this.ports.resolveDirectory(cwd, summary.cwd) ===
                this.ports.resolveDirectory(cwd, cwd) &&
              !this.state.retiredSideThreadIds.includes(summary.id) &&
              !summary.parentThreadId,
          )
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        resume = matching[0]?.id
        if (!resume)
          throw new Error(
            `No sessions found for ${cwd}. Run vimex to start a new session.`,
          )
      }
      if (resume && this.state.retiredSideThreadIds.includes(threadId(resume)))
        throw new Error("This side chat was quit and cannot be reopened")
      const snapshot = await this.unlessClosing(
        resume
          ? this.ports.conversation.resumeThread(threadId(resume))
          : this.ports.conversation.startThread(cwd, model),
      )
      if (!snapshot || !this.currentRuntime(epoch)) return
      this.hydrate(snapshot.value, navigation === this.navigationRevision)
      if (resumeMode === "picker" && navigation === this.navigationRevision)
        this.dispatchInteraction({ type: "overlay.open", overlay: "sessions" })
    } catch (error) {
      if (!this.currentRuntime(epoch)) return
      this.dispatch({
        type: "connection.changed",
        connection: "error",
        error: String(error),
      })
      throw error
    }
  }
  private receive(event: RuntimeEvent): void {
    if (
      event.type === "conversation" &&
      this.state.retiredSideThreadIds.includes(event.event.threadId)
    )
      return
    if (
      event.type === "subagent.link" &&
      (this.state.retiredSideThreadIds.includes(event.link.childId) ||
        this.state.retiredSideThreadIds.includes(event.link.parentId))
    )
      return
    if (
      event.type === "approval" &&
      this.state.retiredSideThreadIds.includes(event.approval.threadId)
    )
      return
    if (
      event.type === "question.requested" &&
      this.state.retiredSideThreadIds.includes(event.request.threadId)
    )
      return
    if (event.type === "conversation") {
      const pending = this.pendingSubmitActivity.get(event.event.threadId)
      if (pending) {
        if (!pending.nextThreadActivity) {
          pending.nextThreadActivity = true
          this.performanceMark(
            "submit",
            "next_thread_activity",
            pending.operationId,
          )
        }
        if (
          !pending.nextThreadContent &&
          isNonUserContentEvent(
            event.event,
            this.state.workspaces[event.event.threadId]?.conversation,
          )
        ) {
          pending.nextThreadContent = true
          this.performanceMark(
            "submit",
            "next_thread_content",
            pending.operationId,
          )
        }
      }
    }
    if (event.type !== "conversation") this.ingress.flush()
    switch (event.type) {
      case "compaction":
        this.dispatch({ type: "compaction.observed", observation: event })
        break
      case "question.requested":
        this.dispatch({ type: "question.received", request: event.request })
        break
      case "question.resolved":
        this.dispatch({ type: "question.resolved", id: event.id })
        break
      case "subagent.link":
        this.dispatch({ type: "agent.link", link: event.link })
        break
      case "conversation":
        if (!this.loaded.has(event.event.threadId)) {
          const queue = this.buffered.get(event.event.threadId) ?? []
          queue.push(event.event)
          this.buffered.set(event.event.threadId, queue)
        } else this.ingress.push(event.event)
        break
      case "summary":
        this.register(event.summary)
        break
      case "metadata":
        this.dispatch({
          type: "thread.summary.patch",
          threadId: event.threadId,
          patch: event.patch,
        })
        break
      case "approval":
        this.dispatch({ type: "approval.received", approval: event.approval })
        break
      case "approval.resolved":
        this.dispatch({ type: "approval.resolved", approvalId: event.id })
        break
      case "disconnected": {
        // Restart already invalidated the old runtime and owns this connecting state.
        if (event.reason === "restart" && this.restartPending) break
        this.historyNavigation = undefined
        this.pendingNavigationInput = undefined
        this.activeNavigationBurst = undefined
        this.runtimeEpoch++
        this.pendingSubmitActivity.clear()
        this.navigationRevision++
        const result = transitionWorkbench(this.state, {
          type: "connection.changed",
          connection: "disconnected",
          error: event.message,
        })
        this.answering.clear()
        this.threadMutations.clear()
        this.setState(invalidateRuntimeState(result.state))
        break
      }
      case "notice":
        this.notice(event.message)
        break
      default: {
        const unreachable: never = event
        throw new Error(`Unhandled runtime event: ${String(unreachable)}`)
      }
    }
  }
  private loadModels() {
    const epoch = this.runtimeEpoch
    if (this.catalogRequest?.epoch === epoch) return this.catalogRequest.promise
    this.setState({ ...this.state, modelCatalogError: undefined })
    const promise = this.ports.models
      .listModels()
      .then((models) => {
        if (this.currentRuntime(epoch))
          this.setState({
            ...this.state,
            availableModels: models,
            modelCatalogError: undefined,
          })
        return models
      })
      .catch((error) => {
        if (this.currentRuntime(epoch))
          this.setState({
            ...this.state,
            modelCatalogError:
              error instanceof Error ? error.message : String(error),
          })
        if (this.catalogRequest?.promise === promise)
          this.catalogRequest = undefined
        throw error
      })
    this.catalogRequest = { epoch, promise }
    return promise
  }
  dispatchInteraction: WorkbenchActions["dispatchInteraction"] = (command) => {
    const active = this.state.activeThreadId
    if (
      active &&
      this.state.summaries[active]?.canAcceptDirectInput === false &&
      !this.state.workspaces[active]?.interaction.overlay &&
      (command.type === "mode.insert" ||
        (command.type === "focus.set" && command.surface === "composer"))
    ) {
      this.notice("Send instructions to this child through its parent")
      return
    }
    if (
      (command.type === "overlay.open" && command.overlay === "agents") ||
      command.type === "overlay.close"
    )
      if (this.state.agentPickerTargets)
        this.setState({ ...this.state, agentPickerTargets: undefined })
    this.dispatch({ type: "interaction.command", command })
    if (command.type === "overlay.open" && command.overlay === "sessions")
      this.launch(() => this.refreshSessionCatalog())
    if (
      command.type === "mode.command" ||
      (command.type === "overlay.open" && command.overlay === "models")
    ) {
      this.launch(async () => {
        await this.loadModels()
      })
    }
  }
  changeDraft: WorkbenchActions["changeDraft"] = (text, cursorOffset) => {
    this.dispatch({ type: "composer.change", text, cursorOffset })
    if (/^\/(?:models?|thinking)(?:\s|$)/.test(text) && !this.catalogRequest)
      this.launch(async () => {
        await this.loadModels()
      })
  }
  attachImageFromClipboard: WorkbenchActions["attachImageFromClipboard"] = (
    cursorOffset,
  ) => {
    const threadId = this.state.activeThreadId
    if (!threadId || !this.ports.images) return
    const at =
      cursorOffset ?? this.state.workspaces[threadId]?.composer.cursorOffset
    this.importImage(threadId, async () => {
      const image = await this.ports.images!.fromClipboard()
      if (!image) {
        this.notice("No image found on the host clipboard")
        return
      }
      this.dispatch({
        type: "composer.image.attach",
        threadId,
        image: { ...image, id: crypto.randomUUID() },
        cursorOffset: at,
      })
    })
  }
  attachImageFromPath: WorkbenchActions["attachImageFromPath"] = (
    path,
    cursorOffset,
  ) => {
    const threadId = this.state.activeThreadId
    if (!threadId || !this.ports.images) return
    const at =
      cursorOffset ?? this.state.workspaces[threadId]?.composer.cursorOffset
    this.importImage(threadId, async () => {
      const image = await this.ports.images!.fromPath(path)
      this.dispatch({
        type: "composer.image.attach",
        threadId,
        image: { ...image, id: crypto.randomUUID() },
        cursorOffset: at,
      })
    })
  }
  private importImage(
    threadId: ThreadId,
    operation: () => Promise<void>,
  ): void {
    this.pendingImages.set(
      threadId,
      (this.pendingImages.get(threadId) ?? 0) + 1,
    )
    const pending = this.launch(operation)
    if (!pending) {
      this.pendingImages.delete(threadId)
      return
    }
    void pending.finally(() => {
      const count = (this.pendingImages.get(threadId) ?? 1) - 1
      if (count) this.pendingImages.set(threadId, count)
      else this.pendingImages.delete(threadId)
    })
  }
  removeImage: WorkbenchActions["removeImage"] = (id) =>
    this.dispatch({ type: "composer.image.remove", imageId: id })
  submit: WorkbenchActions["submit"] = (intent) => {
    if (this.closing) return false
    const thread = this.state.activeThreadId
    if (
      thread &&
      this.state.summaries[thread]?.canAcceptDirectInput === false
    ) {
      this.notice(
        "This child is controlled by its parent. Return to the parent to send instructions.",
      )
      return false
    }
    if (thread && this.pendingImages.has(thread)) {
      this.notice("Image is still attaching; send again when its chip appears")
      return false
    }
    const workspace = thread ? this.state.workspaces[thread] : undefined
    const draft = workspace?.composer.text ?? ""
    if (draft.startsWith("!") && !draft.startsWith("!!")) {
      const command = draft.slice(1)
      if (!command.trim()) {
        this.notice("Type a shell command after !")
        return false
      }
      if (workspace?.composer.images.length) {
        this.notice("Remove image attachments before running a shell command")
        return false
      }
      if (!thread || this.state.connection !== "connected") {
        this.notice("Open a connected session before running a shell command")
        return false
      }
      if (this.retiringThread(thread) || this.state.compactingThreads[thread]) {
        this.notice(
          "Wait for this session to become ready before running a shell command",
        )
        return false
      }
      const run = this.ports.conversation.shellCommand
      if (!run) {
        this.notice("This runtime does not support shell commands")
        return false
      }
      const epoch = this.runtimeEpoch
      this.dispatch({
        type: "composer.change",
        threadId: thread,
        text: "",
        cursorOffset: 0,
      })
      const pending = this.launch(async () => {
        try {
          await run(thread, command)
        } catch (error) {
          if (!this.currentRuntime(epoch)) return
          // Restore the command only when the user has not started another draft.
          if (this.state.workspaces[thread]?.composer.text === "")
            this.dispatch({
              type: "composer.change",
              threadId: thread,
              text: draft,
              cursorOffset: workspace?.composer.cursorOffset ?? 0,
            })
          throw error
        }
      })
      this.trackContinuation(thread, pending)
      return true
    }
    const escapedBangDraft = draft.startsWith("!!")
    if (escapedBangDraft && thread)
      this.dispatch({
        type: "composer.change",
        threadId: thread,
        text: draft.slice(1),
        cursorOffset: Math.max(0, workspace!.composer.cursorOffset - 1),
      })
    const clientMessageId = crypto.randomUUID()
    this.dispatch({
      type: "composer.submit",
      intent,
      clientMessageId,
    })
    const outgoing = thread
      ? this.state.workspaces[thread]?.composer.outbox.find(
          (message) => message.id === clientMessageId,
        )
      : undefined
    if (
      escapedBangDraft &&
      !outgoing &&
      thread &&
      this.state.workspaces[thread]?.composer.text === draft.slice(1)
    )
      this.dispatch({
        type: "composer.change",
        threadId: thread,
        text: draft,
        cursorOffset: workspace?.composer.cursorOffset ?? 0,
      })
    const summary = thread ? this.state.summaries[thread] : undefined
    if (summary?.titleSource === "untitled" && outgoing)
      this.dispatch({
        type: "thread.summary.patch",
        threadId: summary.id,
        patch: {
          title: previewTitle(outgoing.text || "Image"),
          titleSource: "preview",
        },
      })
    return Boolean(outgoing)
  }
  retryOutgoing = (id: string): void =>
    this.dispatch({ type: "composer.retry", clientMessageId: id })
  unqueueOutgoing: WorkbenchActions["unqueueOutgoing"] = (id) => {
    const threadId = this.state.activeThreadId
    if (!threadId) return false
    if (
      !this.state.workspaces[threadId]?.composer.outbox.some(
        (message) => message.id === id && message.status === "queued",
      )
    )
      return false
    this.dispatch({ type: "composer.unqueue", threadId, clientMessageId: id })
    return !this.state.workspaces[threadId]?.composer.outbox.some(
      (message) => message.id === id,
    )
  }
  removeQueuedOutgoing: WorkbenchActions["removeQueuedOutgoing"] = (id) => {
    const threadId = this.state.activeThreadId
    if (!threadId) return false
    if (
      !this.state.workspaces[threadId]?.composer.outbox.some(
        (message) => message.id === id && message.status === "queued",
      )
    )
      return false
    this.dispatch({
      type: "composer.removeQueued",
      threadId,
      clientMessageId: id,
    })
    return !this.state.workspaces[threadId]?.composer.outbox.some(
      (message) => message.id === id,
    )
  }
  copyText = (text: string): void => {
    this.launch(() => this.ports.clipboard.writeText(text))
  }
  resolveApproval: WorkbenchActions["resolveApproval"] = (
    approvalId,
    choiceId,
  ) => {
    const approval = this.state.approvals.byId[approvalId]
    if (!approval) return
    this.dispatch({ type: "approval.resolve", approvalId, choiceId })
  }
  answerQuestions = (
    id: string,
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): void => {
    const request = this.state.questions[id]
    if (!request || this.answering.has(id)) return
    if (this.retiringThread(request.threadId)) {
      this.notice("Side chat is quitting; new work is paused")
      return
    }
    const token = Symbol(id)
    const epoch = this.runtimeEpoch
    this.answering.set(id, token)
    const response = this.launch(async () => {
      try {
        validateAnswers(request, answers)
        if (!this.ports.approvals.respondToQuestions)
          throw new Error("This runtime cannot answer questions")
        await this.ports.approvals.respondToQuestions(id, answers)
        if (
          this.currentRuntime(epoch) &&
          this.answering.get(id) === token &&
          this.state.questions[id] === request
        ) {
          this.dispatch({ type: "question.resolved", id })
        }
      } catch (error) {
        if (this.currentRuntime(epoch) && this.answering.get(id) === token)
          throw error
      } finally {
        if (this.answering.get(id) === token) this.answering.delete(id)
      }
    })
    this.trackContinuation(request.threadId, response)
  }
  requestFork = (selected?: ItemId): void => {
    const workspace = activeWorkspace(this.state)
    const boundary =
      workspace &&
      forkBoundary(
        workspace.conversation,
        selected ?? workspace.transcript.cursor?.itemId,
      )
    if (!boundary) {
      this.notice("Select a user message from a completed turn to fork")
      return
    }
    this.setState({ ...this.state, pendingFork: boundary })
    this.dispatchInteraction({ type: "overlay.open", overlay: "fork" })
  }
  cancelFork = (): void => {
    this.setState({ ...this.state, pendingFork: undefined })
    this.dispatchInteraction({ type: "overlay.close" })
  }
  confirmFork = (): void => {
    const boundary = this.state.pendingFork
    if (!boundary || this.state.activeThreadId !== boundary.threadId) {
      this.cancelFork()
      return
    }
    this.cancelFork()
    this.dispatch({
      type: "thread.fork.request",
      threadId: boundary.threadId,
      throughTurnId: boundary.turnId,
    })
  }
  openChildThread = (id: ThreadId): void => {
    if (!agentRoster(this.state).some((row) => row.threadId === id)) {
      this.notice("This agent is not in the current conversation")
      return
    }
    this.dispatchInteraction({ type: "overlay.close" })
    this.openThread(id)
  }
  returnToParent = (): void => {
    const parent = threadContext(this.state).parentId
    if (!parent) {
      this.notice("This session has no known parent")
      return
    }
    this.dispatchInteraction({ type: "overlay.close" })
    this.openThread(parent)
  }
  cycleAgent = (direction: "previous" | "next"): void => {
    const active = this.state.activeThreadId
    if (!active) return
    const parent = threadContext(this.state).parentId ?? active
    const family = [
      ...new Set([
        parent,
        ...this.state.agentRelationships
          .filter(
            (link) =>
              link.parentId === parent &&
              link.relation === "spawned" &&
              !sideChatForChild(this.state, link.childId) &&
              !this.state.retiredSideThreadIds.includes(link.childId),
          )
          .map((link) => link.childId),
      ]),
    ]
    if (family.length < 2) {
      this.notice("No other agents in this session family")
      return
    }
    const index = family.indexOf(active)
    const target =
      index < 0
        ? parent
        : family[
            (index + (direction === "next" ? 1 : family.length - 1)) %
              family.length
          ]
    if (target) this.openThread(target)
  }
  private clearNavigationIntent(): void {
    if (
      !this.state.pendingFork &&
      !this.state.urlChoices &&
      !this.state.urlChoiceOwner
    )
      return
    let next = this.state.pendingFork
      ? { ...this.state, pendingFork: undefined }
      : this.state
    const owner = next.urlChoiceOwner
    next = owner
      ? transitionWorkbench(next, {
          type: "url.picker",
          threadId: owner.threadId,
        }).state
      : next.urlChoices
        ? { ...next, urlChoices: undefined, urlChoiceOwner: undefined }
        : next
    this.setState(next)
  }
  restart = (): void => {
    if (this.restartPending || this.closing) return
    this.ingress.flush()
    const ephemeralSides = Object.values(this.state.sideChats).filter(
      (side) => side.ephemeral,
    )
    if (ephemeralSides.length) {
      const retired = new Set(
        ephemeralSides.flatMap((side) =>
          side.threadId ? [side.threadId] : [],
        ),
      )
      for (const child of retired) {
        this.navigationHistory.removeThread(child)
        this.loaded.delete(child)
        this.buffered.delete(child)
      }
      const activeSide = ephemeralSides.find(
        (side) => side.threadId === this.state.activeThreadId,
      )
      this.setState({
        ...this.state,
        activeThreadId: activeSide?.parentId ?? this.state.activeThreadId,
        sideChats: Object.fromEntries(
          Object.entries(this.state.sideChats).filter(
            ([, side]) => !side.ephemeral,
          ),
        ),
        summaries: Object.fromEntries(
          Object.entries(this.state.summaries).filter(
            ([id]) => !retired.has(threadId(id)),
          ),
        ),
        workspaces: Object.fromEntries(
          Object.entries(this.state.workspaces).filter(
            ([id]) => !retired.has(threadId(id)),
          ),
        ),
        threadOrder: this.state.threadOrder.filter((id) => !retired.has(id)),
        favoriteThreadIds: this.state.favoriteThreadIds.filter(
          (id) => !retired.has(id),
        ),
        agentRelationships: this.state.agentRelationships.filter(
          (link) => !retired.has(link.childId) && !retired.has(link.parentId),
        ),
        retiredSideThreadIds: [
          ...new Set([...this.state.retiredSideThreadIds, ...retired]),
        ],
      })
    }
    this.restartPending = true
    this.historyNavigation = undefined
    const epoch = ++this.runtimeEpoch
    const id = this.state.activeThreadId
    this.recoveryViews = captureLocalState(
      this.state,
      emptyLocalState(),
    ).threads
    const revision = ++this.navigationRevision
    this.clearNavigationIntent()
    this.answering.clear()
    this.loaded.clear()
    this.buffered.clear()
    this.resumes.clear()
    this.threadMutations.clear()
    this.setState({
      ...invalidateRuntimeState(this.state),
      connection: "connecting",
      error: undefined,
    })
    const operation = this.launch(async () => {
      try {
        // Pending RPCs settle on transport close; never replay their submissions.
        await this.ports.connection.restart()
        if (!this.currentRuntime(epoch)) return
        this.setState({ ...this.state, connection: "connected" })
        if (id) {
          const snapshot = await this.ports.conversation.resumeThread(id)
          if (this.currentRuntime(epoch))
            this.hydrate(snapshot, revision === this.navigationRevision)
          const background = new Set(
            Object.values(this.state.sideChats).flatMap((side) =>
              side.threadId ? [side.parentId, side.threadId] : [],
            ),
          )
          background.delete(id)
          for (const other of background) {
            if (!this.currentRuntime(epoch)) return
            const resumed = await this.ports.conversation.resumeThread(other)
            if (this.currentRuntime(epoch)) this.hydrate(resumed, false)
          }
        } else if (this.initialDirectory) {
          const snapshot = await this.ports.conversation.startThread(
            this.initialDirectory,
            this.initialModel,
          )
          if (this.currentRuntime(epoch))
            this.hydrate(snapshot, revision === this.navigationRevision)
        }
      } catch (error) {
        if (!this.currentRuntime(epoch)) return
        this.dispatch({
          type: "connection.changed",
          connection: "error",
          error: String(error),
        })
        throw error
      } finally {
        this.restartPending = false
      }
    })
    this.restartBarrier = operation
    void operation?.finally(() => {
      if (this.restartBarrier === operation) this.restartBarrier = undefined
    })
  }
  toggleFavorite = (id: ThreadId): void =>
    this.dispatch({ type: "thread.favorite.toggle", threadId: id })
  renameThread = (id: ThreadId, title: string): void => {
    const name = title.replace(/\s+/gu, " ").trim()
    if (!name) {
      this.notice("A session name cannot be empty")
      return
    }
    this.launchThreadMutation(id, async (epoch) => {
      await this.ports.conversation.renameThread(id, name)
      if (this.currentRuntime(epoch))
        this.dispatch({
          type: "thread.summary.patch",
          threadId: id,
          patch: { title: name, titleSource: "name" },
        })
    })
  }
  openThread = (id: ThreadId): void => {
    this.historyNavigation = undefined
    this.navigateThread(id)
  }
  private navigateHistory(direction: "back" | "forward"): void {
    if (this.historyNavigation) {
      if (this.historyNavigation.queue.length < 100)
        this.historyNavigation.queue.push(direction)
      return
    }
    this.navigationHistory.seed(this.state)
    const target = this.navigationHistory.peek(direction)
    if (!target) return
    const pending =
      !this.loaded.has(target.threadId) || Boolean(this.restartBarrier)
    const request = { queue: [] as ("back" | "forward")[] }
    if (pending) this.historyNavigation = request
    const operation = this.navigateThread(target.threadId, {
      direction,
      target,
    })
    if (pending)
      void operation?.finally(() => {
        if (this.historyNavigation !== request) return
        this.historyNavigation = undefined
        if (this.state.activeThreadId !== target.threadId) return
        for (const next of request.queue) this.navigateHistory(next)
      })
  }
  private navigateThread(
    id: ThreadId,
    restore?: { direction: "back" | "forward"; target: NavigationLocation },
  ): Promise<void> | undefined {
    if (this.state.retiredSideThreadIds.includes(id)) {
      this.notice("This side chat was quit and cannot be reopened")
      return
    }
    const revision = ++this.navigationRevision
    const epoch = this.runtimeEpoch
    return this.launch(async () => {
      if (this.restartBarrier) await this.restartBarrier
      if (!this.currentRuntime(epoch) || this.state.connection !== "connected")
        return
      if (!this.loaded.has(id)) {
        let pending = this.resumes.get(id)
        if (!pending) {
          pending = this.ports.conversation.resumeThread(id)
          this.resumes.set(id, pending)
        }
        try {
          let snapshot: SessionSnapshot
          try {
            snapshot = await pending
          } catch (error) {
            if (this.currentRuntime(epoch)) throw error
            return
          }
          if (!this.currentRuntime(epoch)) return
          if (!this.loaded.has(id)) this.hydrate(snapshot, false)
        } finally {
          if (this.resumes.get(id) === pending) this.resumes.delete(id)
        }
      }
      if (this.currentRuntime(epoch) && revision === this.navigationRevision) {
        const origin = navigationLocation(this.state)
        if (
          restore &&
          (!origin ||
            !this.navigationHistory.commit(
              restore.direction,
              restore.target,
              origin,
            ))
        )
          return
        const side = sideChatForChild(this.state, id)
        const sourceThread = this.state.activeThreadId
        const prepared = sourceThread
          ? transitionWorkbench(this.state, {
              type: "interaction.command",
              threadId: sourceThread,
              command: { type: "overlay.close" },
            }).state
          : this.state
        const visible =
          side && !side.visible && side.status !== "quitting"
            ? {
                ...prepared,
                sideChats: {
                  ...prepared.sideChats,
                  [side.parentId]: { ...side, visible: true },
                },
              }
            : prepared
        if (restore) {
          const switched = transitionWorkbench(visible, {
            type: "thread.switch",
            threadId: id,
          }).state
          const foldedCursor =
            restore.target.cursor &&
            switched.workspaces[id]?.transcript.folded[
              restore.target.cursor.itemId
            ]
              ? restore.target.cursor.itemId
              : undefined
          const restored = restoreNavigationLocation(switched, restore.target)
          const transcript = restored.workspaces[id]?.transcript
          const point =
            transcript?.viewport.kind === "point"
              ? transcript.viewport.point
              : undefined
          const presentationId =
            threadForPresentation(restored, "side") === id
              ? "side"
              : threadForPresentation(restored, "main") === id
                ? "main"
                : undefined
          this.setState(restored, {
            ...(foldedCursor ? { foldItemIds: [foldedCursor] } : {}),
            ...(point && presentationId
              ? {
                  reveal: {
                    threadId: id,
                    presentationId,
                    request: {
                      id: ++this.revealRevision,
                      point,
                      reason: "history" as const,
                    },
                  },
                }
              : {}),
          })
        } else {
          const switched = transitionWorkbench(visible, {
            type: "thread.switch",
            threadId: id,
          }).state
          const closed = transitionWorkbench(switched, {
            type: "interaction.command",
            threadId: id,
            command: { type: "overlay.close" },
          }).state
          if (this.state.activeThreadId !== closed.activeThreadId) {
            this.navigationHistory.seed(this.state)
            if (origin) this.navigationHistory.record(origin)
          }
          const transcript = closed.workspaces[id]?.transcript
          const point =
            transcript?.viewport.kind === "point"
              ? transcript.viewport.point
              : undefined
          const presentationId =
            threadForPresentation(closed, "side") === id
              ? "side"
              : threadForPresentation(closed, "main") === id
                ? "main"
                : undefined
          this.setState(
            closed,
            point && presentationId
              ? {
                  reveal: {
                    threadId: id,
                    presentationId,
                    request: {
                      id: ++this.revealRevision,
                      point,
                      reason: "thread",
                    },
                  },
                }
              : undefined,
          )
        }
      }
    })
  }
  interrupt = (): void => {
    const workspace = activeWorkspace(this.state)
    const turn = workspace?.conversation.activeTurnId
    if (
      !workspace ||
      !turn ||
      this.state.interruptingTurns[workspace.conversation.threadId] === turn
    )
      return
    const thread = workspace.conversation.threadId
    this.dispatch({
      type: "turn.interrupt.requested",
      threadId: thread,
      turnId: turn,
    })
    this.launch(async () => {
      try {
        await this.ports.conversation.interruptTurn(thread, turn)
      } catch (error) {
        this.dispatch({
          type: "turn.interrupt.failed",
          threadId: thread,
          turnId: turn,
        })
        throw error
      }
    })
  }
  transcript = (command: TranscriptAction): void => {
    if (command.type === "child.open") {
      const read = this.presentationContext(command.presentationId)
      if (!read) return
      const { threadId, workspace, transcript } = read
      if (threadId !== this.state.activeThreadId) return
      const id = transcript.cursor?.itemId
      const item = id ? workspace.conversation.items[id] : undefined
      const children =
        item?.kind === "agent"
          ? item.agentThreadIds.filter((childId) =>
              this.state.agentRelationships.some(
                (link) =>
                  link.parentId === threadId && link.childId === childId,
              ),
            )
          : []
      if (children.length === 1) this.openChildThread(children[0]!)
      else if (children.length > 1) {
        this.dispatchInteraction({ type: "overlay.open", overlay: "agents" })
        this.setState({ ...this.state, agentPickerTargets: children })
      } else this.notice("No child conversation on this row")
      return
    }
    if (
      command.type === "reference" ||
      command.type === "copy" ||
      command.type === "url.open"
    ) {
      this.readTranscript(command)
      return
    }
    const workspace = activeWorkspace(this.state)
    if (!workspace) return
    const move = (
      point?: LogicalPoint,
      record = true,
      revealReason?: TranscriptRevealRequest["reason"],
      preserveFolds = false,
      preferredScreenRow = 2,
    ) => {
      if (!point) return
      this.dispatch(
        record
          ? {
              type: "transcript.navigate",
              command: {
                type: "jump.to",
                target: { point, preferredScreenRow },
                preserveFolds,
              },
              revealReason,
            }
          : {
              type: "transcript.navigate",
              command: { type: "cursor.reveal", point, preferredScreenRow: 2 },
            },
      )
    }
    const preserveVisual = () =>
      workspace.interaction.surface === "transcript" &&
      Boolean(workspace.transcript.selection) &&
      (workspace.interaction.mode === "visual" ||
        workspace.interaction.mode === "command")
    const navigationFocusMode = (): "normal" | "visual" =>
      preserveVisual() ? "visual" : "normal"
    const navigationOrigin = () =>
      workspace.interaction.surface === "transcript" &&
      workspace.transcript.cursor
        ? { point: workspace.transcript.cursor, preferredScreenRow: 0 }
        : workspace.transcript.viewport.kind === "point"
          ? {
              point: workspace.transcript.viewport.point,
              preferredScreenRow:
                workspace.transcript.viewport.preferredScreenRow,
            }
          : undefined
    switch (command.type) {
      case "navigate": {
        const direction = command.motion.endsWith("previous")
          ? "backward"
          : "forward"
        const count = Math.max(1, command.count ?? 1)
        const transcript = workspace.transcript
        if (
          command.motion.startsWith("word-") ||
          command.motion.startsWith("WORD-")
        ) {
          const motion = command.motion.endsWith("previous")
            ? "previous"
            : command.motion.endsWith("end")
              ? "end"
              : "next"
          move(
            moveByWord(
              transcript,
              motion,
              transcript.cursor,
              count,
              command.motion.startsWith("WORD-"),
            ),
            false,
          )
        } else if (command.motion.startsWith("block-")) {
          const presentation = this.activeTranscriptPresentation()
          const frame = presentation
            ? this.transcriptRuntime(presentation)?.getSnapshot()
            : undefined
          const target = moveBySemanticBlock(
            transcript,
            direction,
            transcript.cursor,
            count,
            {
              isItemHidden: (itemId) => {
                const batch = frame?.window.activityBatchByItem[itemId]
                return Boolean(
                  batch &&
                  itemId !== batch.leadItemId &&
                  frame?.window.activityPresentation[batch.blockKeys[0]!]
                    ?.kind === "activity-lead",
                )
              },
            },
          )
          move(
            target,
            true,
            undefined,
            true,
            target && presentation
              ? this.transcriptRuntime(presentation)?.navigationScreenRow(
                  target,
                  direction,
                  command.viewportRows,
                )
              : undefined,
          )
        } else if (command.motion.startsWith("url-"))
          move(
            moveByUrl(transcript, direction, transcript.cursor, {
              count,
              wrap: true,
            }),
            true,
            "url",
          )
        else if (command.motion === "first-content")
          move(firstContentPoint(transcript), false)
        else
          move(moveByMessage(transcript, direction, transcript.cursor, count))
        break
      }
      case "search": {
        const query = command.query || workspace.transcript.search?.query || ""
        const matches = findSearchMatches(workspace.transcript, query)
        const target = adjacentSearchMatch(
          workspace.transcript,
          matches,
          command.direction,
        )?.from
        if (target)
          this.dispatch({
            type: "transcript.navigate",
            focusMode: navigationFocusMode(),
            command: {
              type: "search.jump",
              search: { query, direction: command.direction },
              target: { point: target, preferredScreenRow: 2 },
            },
          })
        else
          this.dispatch({
            type: "transcript.navigate",
            focusMode: navigationFocusMode(),
            command: {
              type: "search.set",
              query,
              direction: command.direction,
            },
          })
        if (!matches.length) this.notice(`Pattern not found: ${query}`)
        break
      }
      case "search.next": {
        const search = workspace.transcript.search
        if (!search) {
          this.notice("Search with / or ? first")
          break
        }
        const direction = command.reverse
          ? search.direction === "forward"
            ? "backward"
            : "forward"
          : search.direction
        const target = adjacentSearchMatch(
          workspace.transcript,
          findSearchMatches(workspace.transcript, search.query),
          direction,
          workspace.transcript.cursor,
          { count: command.count },
        )?.from
        if (target)
          this.dispatch({
            type: "transcript.navigate",
            focusMode: navigationFocusMode(),
            command: {
              type: "search.jump",
              target: { point: target, preferredScreenRow: 2 },
            },
          })
        break
      }
      case "selection.swap":
        this.dispatch({ type: "transcript.command", command })
        break
      case "cursor.move":
        this.dispatch({
          type: "transcript.command",
          command: {
            type: "cursor.move",
            point: command.target,
            preferredScreenRow: command.preferredScreenRow,
          },
        })
        break
      case "jump": {
        if (!workspace.transcript.projectionById[command.target.itemId]) break
        const originRow =
          command.originPreferredScreenRow ??
          (command.origin &&
          workspace.transcript.viewport.kind === "point" &&
          workspace.transcript.viewport.point.itemId ===
            command.origin.itemId &&
          workspace.transcript.viewport.point.graphemeOffset ===
            command.origin.graphemeOffset
            ? workspace.transcript.viewport.preferredScreenRow
            : 0)
        this.dispatch({
          type: "transcript.navigate",
          focusMode:
            Boolean(command.extend) && preserveVisual() ? "visual" : "normal",
          command: {
            type: "jump.to",
            preserveFolds: command.preserveFolds,
            target: {
              point: command.target,
              preferredScreenRow: command.preferredScreenRow ?? 2,
            },
            origin: command.origin
              ? { point: command.origin, preferredScreenRow: originRow }
              : undefined,
            clearSelection: !command.extend,
          },
        })
        break
      }
      case "jump.back":
      case "jump.forward": {
        this.navigateHistory(command.type === "jump.back" ? "back" : "forward")
        break
      }
      case "mark.set": {
        const transcript = workspace.transcript
        if (!/^[a-zA-Z]$/.test(command.name)) {
          this.notice(`Invalid mark: ${command.name}`)
          break
        }
        const point =
          workspace.interaction.surface === "transcript" && transcript.cursor
            ? transcript.cursor
            : transcript.viewport.kind === "point"
              ? transcript.viewport.point
              : (transcript.cursor ??
                (() => {
                  const itemId = transcript.order.at(-1),
                    projection = itemId
                      ? transcript.projectionById[itemId]
                      : undefined
                  return itemId && projection
                    ? { itemId, graphemeOffset: projection.sourceSpans.length }
                    : undefined
                })())
        if (!point) {
          this.notice("No transcript position to mark")
          break
        }
        const preferredScreenRow =
          transcript.viewport.kind === "point" &&
          transcript.viewport.point.itemId === point.itemId &&
          transcript.viewport.point.graphemeOffset === point.graphemeOffset
            ? transcript.viewport.preferredScreenRow
            : 0
        this.dispatch({
          type: "transcript.command",
          command: {
            type: "mark.set",
            name: command.name,
            target: { point, preferredScreenRow },
          },
        })
        break
      }
      case "mark.jump": {
        const target = workspace.transcript.marks[command.name]
        if (!target) {
          this.notice(`Mark not set: ${command.name}`)
          break
        }
        const changesDisplay =
          workspace.transcript.folded[target.point.itemId] ||
          workspace.transcript.cursor?.itemId !== target.point.itemId ||
          workspace.transcript.cursor.graphemeOffset !==
            target.point.graphemeOffset ||
          workspace.transcript.viewport.kind !== "point" ||
          workspace.transcript.viewport.point.itemId !== target.point.itemId ||
          workspace.transcript.viewport.point.graphemeOffset !==
            target.point.graphemeOffset ||
          workspace.transcript.viewport.preferredScreenRow !==
            target.preferredScreenRow
        this.dispatch({
          type: "transcript.navigate",
          focusMode: changesDisplay ? navigationFocusMode() : undefined,
          command: { ...command, origin: navigationOrigin() },
        })
        break
      }
      case "selection.begin":
        this.dispatch({ type: "transcript.command", command })
        break
      case "selection.clear":
        this.dispatch({ type: "transcript.command", command })
        break
      case "viewport.anchor":
        this.dispatch({ type: "transcript.command", command })
        break
      case "viewport.tail": {
        this.dispatch({
          type: "transcript.command",
          command: { type: "tail.attach" },
        })
        break
      }
      case "viewport.scroll": {
        const point = workspace.transcript.cursor
        if (point)
          this.dispatch({
            type: "transcript.command",
            command: { type: "viewport.anchor", point, preferredScreenRow: 0 },
          })
        break
      }
      case "fold.set":
      case "fold.all":
      case "fold.defaults":
        this.dispatch({ type: "transcript.command", command })
        break
      case "fork":
        this.requestFork(command.itemId)
        break
    }
  }
  executeCommand = (
    line: string,
    presentationId?: TranscriptPresentationId,
  ): void => {
    if (/^[/?]/.test(line)) {
      this.transcript({
        type: "search",
        query: line.slice(1),
        direction: line[0] === "/" ? "forward" : "backward",
      })
      return
    }
    if (presentationId) {
      const context = this.presentationContext(presentationId)
      if (context)
        this.dispatch({
          type: "interaction.command",
          threadId: context.threadId,
          command: { type: "mode.normal" },
        })
    } else this.dispatchInteraction({ type: "mode.normal" })
    this.runCommand(parseCommand(line), presentationId)
  }
  executeNamedCommand = (
    name: string,
    presentationId?: TranscriptPresentationId,
  ): void => this.runCommand(parseCommand(name), presentationId)
  private savePreferences(next: DisplayPreferences): void {
    const revision = ++this.preferenceRevision
    this.desiredPreferences = next
    const operation = this.preferenceTail
      .then(async () => {
        await this.ports.preferences?.save(next)
        this.setState({ ...this.state, preferences: next })
      })
      .catch((error) => {
        if (revision === this.preferenceRevision)
          this.desiredPreferences = this.state.preferences
        throw error
      })
    this.preferenceTail = operation.catch(() => {})
    this.launch(() => operation)
  }
  private launchThreadMutation(
    id: ThreadId,
    operation: (epoch: number) => Promise<void>,
  ): void {
    if (this.retiringThread(id)) {
      this.notice("Side chat is quitting; new work is paused")
      return
    }
    const epoch = this.runtimeEpoch
    const previous = this.threadMutations.get(id) ?? Promise.resolve()
    const pending = previous
      .catch(() => {})
      .then(async () => {
        if (!this.currentRuntime(epoch) || this.retiringThread(id)) return
        try {
          await operation(epoch)
        } catch (error) {
          if (this.currentRuntime(epoch)) throw error
        }
      })
    this.threadMutations.set(id, pending)
    this.launch(async () => {
      try {
        await pending
      } finally {
        if (this.threadMutations.get(id) === pending)
          this.threadMutations.delete(id)
      }
    })
  }
  private runCommand(
    parsed: ExCommand,
    presentationId?: TranscriptPresentationId,
  ): void {
    if (parsed.kind === "empty") return
    if (parsed.kind === "unknown") {
      this.notice(`Unknown command: ${parsed.name}`)
      return
    }
    const invalid = validateCommand(parsed)
    if (invalid) {
      this.notice(invalid)
      return
    }
    const { name: command, argument } = parsed
    const transcriptPresentation =
      presentationId ?? this.activeTranscriptPresentation()
    switch (command) {
      case "compact": {
        const id = this.state.activeThreadId
        if (!id) {
          this.notice("Open a session before compacting")
          break
        }
        if (this.state.compactingThreads[id]) break
        if (this.retiringThread(id)) {
          this.notice("Side chat is quitting; new work is paused")
          break
        }
        const blocked = compactionBlockReason(this.state, id)
        if (blocked) {
          this.notice(blocked)
          break
        }
        const compact = this.ports.conversation.compactThread
        if (!compact) {
          this.notice("This runtime does not support compaction")
          break
        }
        const epoch = this.runtimeEpoch
        const request = {
          phase: "requested" as const,
          requestId: crypto.randomUUID(),
        }
        this.setState({
          ...this.state,
          error: undefined,
          compactingThreads: { ...this.state.compactingThreads, [id]: request },
        })
        const pending = this.launch(async () => {
          try {
            await compact.call(this.ports.conversation, id)
          } catch (error) {
            if (
              !this.currentRuntime(epoch) ||
              this.state.compactingThreads[id]?.requestId !== request.requestId
            )
              return
            this.dispatch({
              type: "compaction.observed",
              observation: {
                threadId: id,
                phase: "failed",
                error: `Compaction failed: ${String(error)}`,
              },
            })
          }
        })
        this.trackContinuation(id, pending)
        break
      }
      case "goal": {
        const id = this.state.activeThreadId
        if (!id) {
          this.notice("Open a session before setting a goal")
          break
        }
        this.launchThreadMutation(id, async (epoch) => {
          const message = await executeGoalCommand(
            this.ports.conversation,
            id,
            argument,
          )
          if (this.currentRuntime(epoch) && this.state.activeThreadId === id)
            this.notice(message)
        })
        break
      }
      case "submit":
        this.submit(
          argument === "queue"
            ? "next-turn"
            : argument === "steer" || this.ports.busySubmit === "steer"
              ? "steer"
              : "next-turn",
        )
        break
      case "performance": {
        if (!this.ports.exportPerformance) {
          this.notice("Performance export is unavailable")
          break
        }
        this.launch(async () => {
          const path = await this.ports.exportPerformance!()
          if (!this.closing) this.notice(`Performance trace saved: ${path}`)
        })
        break
      }
      case "insert":
        this.dispatchInteraction({ type: "mode.insert" })
        break
      case "normal":
        this.dispatchInteraction({ type: "mode.normal" })
        break
      case "visual": {
        const transcript = activeWorkspace(this.state)?.transcript
        const first = transcript?.order[0]
        const point =
          transcript?.cursor ??
          (first ? { itemId: first, graphemeOffset: 0 } : undefined)
        if (!point) {
          this.notice("No transcript content to select")
          break
        }
        this.dispatchInteraction({ type: "focus.set", surface: "transcript" })
        this.transcript({
          type: "cursor.move",
          target: point,
          preferredScreenRow: 2,
          extend: false,
        })
        this.transcript({ type: "selection.begin", shape: "character" })
        this.dispatchInteraction({ type: "mode.visual" })
        break
      }
      case "theme":
      case "syntax": {
        if (!argument) {
          this.notice(
            `${command}: ${[...themeNames, ...(command === "syntax" ? ["theme"] : [])].join(", ")}`,
          )
          break
        }
        if (
          !isThemeName(argument) &&
          !(command === "syntax" && argument === "theme")
        ) {
          this.notice(`Unknown ${command}: ${argument}`)
          break
        }
        const current = this.desiredPreferences ??
          this.state.preferences ?? {
            theme: "ember-tide" as const,
            syntaxTheme: "theme" as const,
          }
        const next =
          command === "theme" && isThemeName(argument)
            ? { ...current, theme: argument }
            : {
                ...current,
                syntaxTheme: argument as typeof current.syntaxTheme,
              }
        this.savePreferences(next)
        break
      }
      case "quit":
        this.ports.quit()
        break
      case "sessions": {
        if (!argument) {
          this.dispatchInteraction({
            type: "overlay.open",
            overlay: "sessions",
          })
        } else this.openThread(threadId(argument))
        break
      }
      case "manual":
        this.dispatchInteraction({ type: "overlay.open", overlay: "manual" })
        break
      case "help": {
        const name = resolveCommandName(argument)
        if (name === "manual")
          this.dispatchInteraction({ type: "overlay.open", overlay: "manual" })
        else if (name)
          this.notice(
            `:${commandDescriptors[name].usage} — ${commandDescriptors[name].description}`,
          )
        else this.dispatchInteraction({ type: "overlay.open", overlay: "help" })
        break
      }
      case "favorite": {
        const id = this.state.activeThreadId
        if (!id) break
        const favorite = this.state.favoriteThreadIds.includes(id)
        const next = argument ? argument === "on" : !favorite
        if (next !== favorite) this.toggleFavorite(id)
        this.notice(
          next ? "Session favorited" : "Session removed from favorites",
        )
        break
      }
      case "tail":
      case "follow":
        this.transcript({ type: "viewport.tail" })
        break
      case "approvals":
      case "questions":
      case "agents":
        this.dispatchInteraction({ type: "overlay.open", overlay: command })
        break
      case "model":
      case "thinking":
      case "cwd": {
        if (command === "model" && !argument) {
          this.dispatchInteraction({ type: "overlay.open", overlay: "models" })
          break
        }
        const id = this.state.activeThreadId
        if (!id || !this.state.summaries[id]) break
        this.launchThreadMutation(id, async (epoch) => {
          const summary = this.state.summaries[id]
          if (!summary) return
          if (command === "cwd") {
            if (!argument) {
              this.notice(summary.cwd)
              return
            }
            const cwd = this.ports.resolveDirectory(summary.cwd, argument)
            await this.ports.conversation.updateSettings(id, { cwd })
            if (this.currentRuntime(epoch))
              this.dispatch({
                type: "thread.summary.patch",
                threadId: id,
                patch: { cwd, gitBranch: undefined },
              })
            return
          }
          const models = await this.loadModels()
          if (!this.currentRuntime(epoch)) return
          if (!argument) {
            this.notice(
              `Reasoning: ${models.find((m) => m.id === summary.model)?.efforts.join(", ") ?? "unavailable"}`,
            )
            return
          }
          if (command === "thinking") {
            const current = models.find((model) => model.id === summary.model)
            if (!current?.efforts.includes(argument))
              throw new Error(`Unsupported reasoning effort: ${argument}`)
            await this.ports.conversation.updateSettings(id, {
              effort: argument,
            })
            if (this.currentRuntime(epoch))
              this.dispatch({
                type: "thread.summary.patch",
                threadId: id,
                patch: { reasoningEffort: argument },
              })
          } else {
            const [modelId, effort, ...extra] = argument.trim().split(/\s+/)
            if (extra.length)
              throw new Error("Usage: :model <model-id> [thinking-level]")
            const model = models.find((candidate) => candidate.id === modelId)
            if (!model) throw new Error(`Unknown model: ${modelId}`)
            if (effort && !model.efforts.includes(effort))
              throw new Error(
                `Unsupported reasoning effort for ${model.id}: ${effort}`,
              )
            await this.ports.conversation.updateSettings(id, {
              model: model.id,
              ...(effort ? { effort } : {}),
            })
            if (this.currentRuntime(epoch))
              this.dispatch({
                type: "thread.summary.patch",
                threadId: id,
                patch: {
                  model: model.id,
                  ...(effort ? { reasoningEffort: effort } : {}),
                },
              })
          }
        })
        break
      }
      case "new": {
        const summary = this.state.activeThreadId
          ? this.state.summaries[this.state.activeThreadId]
          : undefined
        if (summary) {
          const revision = ++this.navigationRevision
          const epoch = this.runtimeEpoch
          this.clearNavigationIntent()
          this.launch(async () => {
            let snapshot: SessionSnapshot
            try {
              snapshot = await this.ports.conversation.startThread(
                argument
                  ? this.ports.resolveDirectory(summary.cwd, argument)
                  : summary.cwd,
                summary.model,
              )
            } catch (error) {
              if (this.currentRuntime(epoch)) throw error
              return
            }
            if (this.currentRuntime(epoch))
              this.hydrate(snapshot, revision === this.navigationRevision)
          })
        }
        break
      }
      case "approve":
      case "reject": {
        const approval = this.state.approvals.order
          .map((id) => this.state.approvals.byId[id])
          .find(
            (a) =>
              a !== undefined &&
              a.threadId === this.state.activeThreadId &&
              (a.status === "pending" || a.status === "failed"),
          )
        const choices =
          command === "approve"
            ? ["accept", "approved"]
            : ["decline", "denied", "cancel", "abort"]
        const choice = approval?.choices.find((c) => choices.includes(c.id))
        if (approval && choice) this.resolveApproval(approval.id, choice.id)
        else this.notice("Open :approvals to choose a response")
        break
      }
      case "side": {
        const verbs: SideChatAction[] = [
          "open",
          "close",
          "quit",
          "refresh",
          "maximize",
          "reset",
          "parent",
          "side",
          "cycle",
          "quote",
        ]
        const action =
          argument === "focus parent"
            ? "parent"
            : argument === "focus side"
              ? "side"
              : argument
        this.sideChat(
          verbs.includes(action as SideChatAction)
            ? (action as SideChatAction)
            : "open",
          verbs.includes(action as SideChatAction) ? undefined : argument,
        )
        break
      }
      case "parent":
        this.returnToParent()
        break
      case "restart":
        this.restart()
        break
      case "stop":
        this.interrupt()
        break
      case "fork":
        this.transcript({ type: "fork" })
        break
      case "fold":
      case "unfold":
        this.transcript({ type: "fold.all", folded: command === "fold" })
        break
      case "yank": {
        const context = transcriptPresentation
          ? this.presentationContext(transcriptPresentation)
          : undefined
        const transcript = context?.transcript
        const format = argument === "markdown" ? "source" : "plain"
        if (transcript?.selection && transcriptPresentation)
          this.transcript({
            type: "copy",
            format,
            presentationId: transcriptPresentation,
          })
        else {
          const id = transcript?.cursor?.itemId ?? transcript?.order.at(-1)
          const projection = id ? transcript?.projectionById[id] : undefined
          if (!projection) {
            this.notice("No transcript content to copy")
            break
          }
          const text =
            format === "source" ? projection.source : projection.plain
          this.dispatch({
            type: "interaction.command",
            threadId: context!.threadId,
            command: {
              type: "register.set",
              register: { text, shape: "character" },
            },
          })
          this.copyText(text)
          this.notice("Copied current transcript block")
        }
        break
      }
      case "open": {
        if (argument) {
          this.setState({
            ...this.state,
            urlChoices: undefined,
            urlChoiceOwner: undefined,
          })
          this.launch(() => this.ports.openUrl(argument))
        } else if (transcriptPresentation)
          this.transcript({
            type: "url.open",
            presentationId: transcriptPresentation,
          })
        break
      }
      case "rename": {
        const id = this.state.activeThreadId
        if (id && argument) this.renameThread(id, argument)
        break
      }
      default: {
        const unreachable: never = command
        throw new Error(`Unhandled command: ${String(unreachable)}`)
      }
    }
  }
  private async effect(effect: WorkbenchEffect): Promise<void> {
    const epoch = this.runtimeEpoch
    switch (effect.type) {
      case "conversation.turn.start":
      case "conversation.turn.steer": {
        if (this.retiringThread(effect.threadId)) return
        this.pendingSubmitActivity.set(effect.threadId, {
          operationId: effect.clientMessageId,
          nextThreadActivity: false,
          nextThreadContent: false,
          nextThreadContentCommitted: false,
        })
        this.performanceMark("submit", "adapter_start", effect.clientMessageId)
        const onRequestSent = () =>
          this.performanceMark("submit", "request_sent", effect.clientMessageId)
        try {
          let submittedTurn: TurnId | undefined
          const input = effect.input?.map((part) =>
            part.type === "text"
              ? part
              : { type: "image" as const, path: part.path },
          )
          const turn =
            this.state.workspaces[effect.threadId]?.conversation.activeTurnId
          if (effect.type === "conversation.turn.steer" && turn)
            await this.ports.conversation.steerTurn(
              effect.threadId,
              turn,
              effect.text,
              effect.clientMessageId,
              input,
              onRequestSent,
            )
          else {
            const events = await this.ports.conversation.startTurn(
              effect.threadId,
              effect.text,
              effect.clientMessageId,
              input,
              onRequestSent,
            )
            if (!this.currentRuntime(epoch)) return
            submittedTurn = events.find(
              (event) => event.type === "turn.started",
            )?.turnId
            // RPC snapshots may predate already-observed live deltas/completion.
            this.ingress.flush()
            const initial = this.state.workspaces[effect.threadId]?.conversation
            if (!initial) return
            const replay = createRpcEventReplay(initial)
            for (const event of events) {
              const current =
                this.state.workspaces[effect.threadId]?.conversation
              if (current && replay(current, event))
                this.receive({ type: "conversation", event })
            }
          }
          if (this.currentRuntime(epoch))
            this.dispatch({
              type: "composer.ack",
              threadId: effect.threadId,
              clientMessageId: effect.clientMessageId,
              turnId: submittedTurn,
            })
        } catch (error) {
          if (
            this.pendingSubmitActivity.get(effect.threadId)?.operationId ===
            effect.clientMessageId
          )
            this.pendingSubmitActivity.delete(effect.threadId)
          if (!this.currentRuntime(epoch)) return
          this.dispatch({
            type: "composer.fail",
            threadId: effect.threadId,
            clientMessageId: effect.clientMessageId,
            reason: String(error),
          })
          throw error
        }
        break
      }
      case "approval.resolve":
        try {
          await this.ports.approvals.resolveApproval(
            effect.approvalId,
            effect.choiceId,
          )
          if (this.currentRuntime(epoch))
            this.dispatch({
              type: "approval.resolved",
              approvalId: effect.approvalId,
            })
        } catch (error) {
          if (!this.currentRuntime(epoch)) return
          this.dispatch({
            type: "approval.failed",
            approvalId: effect.approvalId,
            error: String(error),
          })
          throw error
        }
        break
      case "conversation.thread.fork": {
        const revision = ++this.navigationRevision
        let snapshot: SessionSnapshot
        try {
          snapshot = await this.ports.conversation.forkThread(
            effect.threadId,
            effect.throughTurnId,
          )
        } catch (error) {
          if (this.currentRuntime(epoch)) throw error
          return
        }
        if (this.currentRuntime(epoch))
          this.hydrate(snapshot, revision === this.navigationRevision)
        break
      }
      case "clipboard.write":
        await this.ports.clipboard.writeText(effect.text)
        break
      case "url.open":
        await this.ports.openUrl(effect.url)
        break
      case "viewport.restore":
        break // The renderer observes the unchanged semantic anchor after reflow.
    }
  }
  close(): Promise<void> {
    return (this.closePromise ??= this.runClose())
  }
  private async runClose(): Promise<void> {
    this.closing = true
    this.pendingNavigationInput = undefined
    this.activeNavigationBurst = undefined
    this.pendingSubmitActivity.clear()
    const errors: unknown[] = []
    try {
      this.ingress.close()
    } catch (error) {
      errors.push(error)
    }
    this.signalClosing()
    this.navigationRevision++
    this.unsubscribe?.()
    this.unsubscribe = undefined
    try {
      await this.ports.connection.close()
    } catch (error) {
      errors.push(error)
    }
    if (this.initialization) {
      try {
        await this.initialization
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      await this.settle()
    } catch (error) {
      errors.push(error)
    }
    this.buffered.clear()
    this.resumes.clear()
    for (const runtime of this.transcriptRuntimes.values()) runtime.dispose()
    this.transcriptRuntimes.clear()
    this.listeners.clear()
    this.layoutListeners.clear()
    this.presentationListeners.main.clear()
    this.presentationListeners.side.clear()
    if (errors.length)
      throw new AggregateError(errors, "Vimex controller shutdown failed")
  }
}
