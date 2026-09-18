import type { Approval } from "@vimex/approvals"
import type { ConversationEvent, ThreadSummary } from "@vimex/conversation"
import type { InitializeResponse } from "../generated/v0_154_0/InitializeResponse"
import type { RequestId } from "../generated/v0_154_0/RequestId"
import type { CommandExecutionApprovalDecision } from "../generated/v0_154_0/v2/CommandExecutionApprovalDecision"
import type { CommandExecutionRequestApprovalParams } from "../generated/v0_154_0/v2/CommandExecutionRequestApprovalParams"
import type { FileChangeApprovalDecision } from "../generated/v0_154_0/v2/FileChangeApprovalDecision"
import type { GrantedPermissionProfile } from "../generated/v0_154_0/v2/GrantedPermissionProfile"
import type { ModelListParams } from "../generated/v0_154_0/v2/ModelListParams"
import type { ModelListResponse } from "../generated/v0_154_0/v2/ModelListResponse"
import type { PermissionsRequestApprovalParams } from "../generated/v0_154_0/v2/PermissionsRequestApprovalParams"
import type { ThreadForkParams } from "../generated/v0_154_0/v2/ThreadForkParams"
import type { ThreadForkResponse } from "../generated/v0_154_0/v2/ThreadForkResponse"
import type { ThreadListParams } from "../generated/v0_154_0/v2/ThreadListParams"
import type { ThreadListResponse } from "../generated/v0_154_0/v2/ThreadListResponse"
import type { ThreadTurnsListParams } from "../generated/v0_154_0/v2/ThreadTurnsListParams"
import type { ThreadTurnsListResponse } from "../generated/v0_154_0/v2/ThreadTurnsListResponse"
import type { ThreadItemsListParams } from "../generated/v0_154_0/v2/ThreadItemsListParams"
import type { ThreadItemsListResponse } from "../generated/v0_154_0/v2/ThreadItemsListResponse"
import type { ThreadResumeParams } from "../generated/v0_154_0/v2/ThreadResumeParams"
import type { ThreadResumeResponse } from "../generated/v0_154_0/v2/ThreadResumeResponse"
import type { ThreadStartParams } from "../generated/v0_154_0/v2/ThreadStartParams"
import type { ThreadStartResponse } from "../generated/v0_154_0/v2/ThreadStartResponse"
import type { ThreadSetNameResponse } from "../generated/v0_154_0/v2/ThreadSetNameResponse"
import type { ThreadSettingsUpdateParams } from "../generated/v0_154_0/v2/ThreadSettingsUpdateParams"
import type { ThreadSettingsUpdateResponse } from "../generated/v0_154_0/v2/ThreadSettingsUpdateResponse"
import type { TurnInterruptResponse } from "../generated/v0_154_0/v2/TurnInterruptResponse"
import type { TurnStartParams } from "../generated/v0_154_0/v2/TurnStartParams"
import type { TurnStartResponse } from "../generated/v0_154_0/v2/TurnStartResponse"
import type { TurnSteerParams } from "../generated/v0_154_0/v2/TurnSteerParams"
import type { TurnSteerResponse } from "../generated/v0_154_0/v2/TurnSteerResponse"
import type { UserInput } from "../generated/v0_154_0/v2/UserInput"
import type { ToolRequestUserInputResponse } from "../generated/v0_154_0/v2/ToolRequestUserInputResponse"
import type { Turn } from "../generated/v0_154_0/v2/Turn"
import { hydrateTurns, mapNotificationEvents, mapServerRequest, mapThreadRelation, mapThreadSummary, type CodexAdapterEvent, type ThreadRelation } from "../mapping/map-notification"
import { RpcClient, type ServerCall } from "../rpc/json-rpc-client"
import { StdioTransport, type StdioTransportOptions } from "../transport/stdio-transport"
import type { CodexTransport } from "../transport/transport"

export interface CodexClientInfo {
  name: string
  title: string | null
  version: string
}

export interface CodexClientOptions {
  clientInfo?: CodexClientInfo
  experimentalApi?: boolean
  requestAttestation?: boolean
  requestTimeoutMs?: number
}

export interface ThreadPage {
  threads: readonly ThreadSummary[]
  relations: readonly ThreadRelation[]
  nextCursor: string | null
  backwardsCursor: string | null
  raw: ThreadListResponse
}

export interface ThreadSession {
  summary: ThreadSummary
  relation: ThreadRelation
  model: string
  modelProvider: string
  serviceTier: string | null
  cwd: string
  reasoningEffort: string | null
  events: readonly ConversationEvent[]
  raw: ThreadStartResponse | ThreadResumeResponse | ThreadForkResponse
}

export interface ModelOption {
  id: string
  model: string
  label: string
  description: string
  supportedReasoningEfforts: readonly { effort: string; description: string }[]
  defaultReasoningEffort: string
  inputModalities: readonly string[]
  isDefault: boolean
}

export interface ModelPage {
  models: readonly ModelOption[]
  nextCursor: string | null
  raw: ModelListResponse
}

export type ApprovalResult =
  | { decision: CommandExecutionApprovalDecision | FileChangeApprovalDecision | string | Record<string, unknown> }
  | { permissions: GrantedPermissionProfile; scope: "turn" | "session"; strictAutoReview?: boolean }

interface PendingServerRequest {
  request: ServerCall
  approval?: Approval
  answered: boolean
}

export class CodexAppServerClient {
  private readonly rpc: RpcClient
  private readonly listeners = new Set<(event: CodexAdapterEvent) => void>()
  private readonly serverRequestListeners = new Set<(request: ServerCall) => void>()
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>()
  private readonly approvalWireIds = new Map<string, RequestId>()
  private connected = false

  constructor(
    transport: CodexTransport,
    private readonly options: CodexClientOptions = {},
  ) {
    this.rpc = new RpcClient(transport, { requestTimeoutMs: options.requestTimeoutMs })
    this.rpc.onNotification((notification) => { for (const event of mapNotificationEvents(notification)) this.emit(event) })
    this.rpc.onRequest((request) => this.receiveServerRequest(request))
    this.rpc.onUnknown((payload) => this.emit({ type: "unknown", payload }))
    transport.onError((error) => this.handleDisconnect(error))
    transport.onClose((error) => this.handleDisconnect(error))
  }

  async connect(): Promise<InitializeResponse> {
    if (this.connected) throw new Error("Codex app-server client is already connected")
    await this.rpc.start()
    const result = await this.rpc.request<InitializeResponse>("initialize", {
      clientInfo: this.options.clientInfo ?? { name: "vimex", title: "Vimex", version: "0.1.0" },
      capabilities: {
        experimentalApi: this.options.experimentalApi ?? false,
        requestAttestation: this.options.requestAttestation ?? false,
      },
    })
    await this.rpc.notify("initialized")
    this.connected = true
    this.emit({ type: "connection", status: "connected" })
    return result
  }

  onEvent(listener: (event: CodexAdapterEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Receives every server request, including future request methods Vimex does not understand yet. */
  onServerRequest(listener: (request: ServerCall) => void): () => void {
    this.serverRequestListeners.add(listener)
    return () => this.serverRequestListeners.delete(listener)
  }

  async listThreads(params: ThreadListParams = {}): Promise<ThreadPage> {
    const request: ThreadListParams = {
      sortKey: "recency_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther"],
      archived: false,
      ...params,
    }
    const raw = await this.rpc.request<ThreadListResponse>("thread/list", request)
    return {
      threads: raw.data.map(mapThreadSummary),
      relations: raw.data.map(mapThreadRelation),
      nextCursor: raw.nextCursor,
      backwardsCursor: raw.backwardsCursor,
      raw,
    }
  }

  async startThread(params: ThreadStartParams = {}): Promise<ThreadSession> {
    const raw = await this.rpc.request<ThreadStartResponse>("thread/start", params)
    return session(raw)
  }

  async listModels(params: ModelListParams = {}): Promise<ModelPage> {
    const raw = await this.rpc.request<ModelListResponse>("model/list", params)
    return {
      models: raw.data.map((model) => ({
        id: model.id,
        model: model.model,
        label: model.displayName,
        description: model.description,
        supportedReasoningEfforts: model.supportedReasoningEfforts.map((option) => ({
          effort: option.reasoningEffort,
          description: option.description,
        })),
        defaultReasoningEffort: model.defaultReasoningEffort,
        inputModalities: model.inputModalities,
        isDefault: model.isDefault,
      })),
      nextCursor: raw.nextCursor,
      raw,
    }
  }

  renameThread(thread: string, name: string): Promise<ThreadSetNameResponse> {
    return this.rpc.request("thread/name/set", { threadId: thread, name })
  }

  updateThreadSettings(
    thread: string,
    settings: Omit<ThreadSettingsUpdateParams, "threadId">,
  ): Promise<ThreadSettingsUpdateResponse> {
    return this.rpc.request("thread/settings/update", { threadId: thread, ...settings })
  }

  setThreadModel(thread: string, model: string): Promise<ThreadSettingsUpdateResponse> {
    return this.updateThreadSettings(thread, { model })
  }

  setThreadReasoningEffort(thread: string, effort: string): Promise<ThreadSettingsUpdateResponse> {
    return this.updateThreadSettings(thread, { effort })
  }

  setThreadCwd(thread: string, cwd: string): Promise<ThreadSettingsUpdateResponse> {
    return this.updateThreadSettings(thread, { cwd })
  }

  async resumeThread(thread: string, overrides: Omit<ThreadResumeParams, "threadId"> = {}): Promise<ThreadSession> {
    const raw = await this.rpc.request<ThreadResumeResponse>("thread/resume", {
      threadId: thread,
      excludeTurns: true,
      initialTurnsPage: { limit: 100, sortDirection: "desc", itemsView: "full" },
      ...overrides,
    })
    return session(raw, await this.loadResumeTurns(raw))
  }

  listTurns(params: ThreadTurnsListParams): Promise<ThreadTurnsListResponse> {
    return this.rpc.request("thread/turns/list", params)
  }

  listItems(params: ThreadItemsListParams): Promise<ThreadItemsListResponse> {
    return this.rpc.request("thread/items/list", params)
  }

  async forkThread(
    thread: string,
    lastTurnId?: string,
    overrides: Omit<ThreadForkParams, "threadId" | "lastTurnId"> = {},
  ): Promise<ThreadSession> {
    const raw = await this.rpc.request<ThreadForkResponse>("thread/fork", {
      threadId: thread,
      ...(lastTurnId ? { lastTurnId } : {}),
      ...overrides,
    })
    return session(raw)
  }

  startTurn(
    thread: string,
    input: string | readonly UserInput[],
    overrides: Omit<TurnStartParams, "threadId" | "input"> = {},
  ): Promise<TurnStartResponse> {
    return this.rpc.request("turn/start", {
      threadId: thread,
      input: normalizeInput(input),
      ...overrides,
    } satisfies TurnStartParams)
  }

  steerTurn(
    thread: string,
    activeTurnId: string,
    input: string | readonly UserInput[],
    overrides: Omit<TurnSteerParams, "threadId" | "expectedTurnId" | "input"> = {},
  ): Promise<TurnSteerResponse> {
    return this.rpc.request("turn/steer", {
      threadId: thread,
      expectedTurnId: activeTurnId,
      input: normalizeInput(input),
      ...overrides,
    } satisfies TurnSteerParams)
  }

  interruptTurn(thread: string, activeTurnId: string): Promise<TurnInterruptResponse> {
    return this.rpc.request("turn/interrupt", { threadId: thread, turnId: activeTurnId })
  }

  /** Low-level escape hatch for new server request types. */
  async respondToServerRequest(requestId: RequestId, result: unknown): Promise<void> {
    const wireId = this.wireRequestId(requestId)
    const pending = this.pendingServerRequests.get(requestKey(wireId))
    if (pending?.answered) throw new Error(`Server request already answered: ${String(requestId)}`)
    await this.rpc.respond(wireId, result)
    if (pending) pending.answered = true
  }

  async resolveApproval(requestId: RequestId, choice: string, rejection = "Declined by user"): Promise<void> {
    const wireId = this.wireRequestId(requestId)
    const pending = this.pendingServerRequests.get(requestKey(wireId))
    if (!pending) throw new Error(`Unknown or resolved server request: ${String(requestId)}`)
    if (pending.answered) throw new Error(`Server request already answered: ${String(requestId)}`)
    const result = approvalResult(pending.request, choice, rejection)
    await this.respondToServerRequest(wireId, result)
  }

  async respondWithPermissionGrant(
    requestId: RequestId,
    permissions: GrantedPermissionProfile,
    scope: "turn" | "session",
    strictAutoReview?: boolean,
  ): Promise<void> {
    const wireId = this.wireRequestId(requestId)
    const pending = this.pendingServerRequests.get(requestKey(wireId))
    if (!pending || pending.request.method !== "item/permissions/requestApproval") {
      throw new Error(`Request ${String(requestId)} is not a permission approval`)
    }
    await this.respondToServerRequest(wireId, {
      permissions,
      scope,
      ...(strictAutoReview === undefined ? {} : { strictAutoReview }),
    })
  }

  async respondToUserInput(
    requestId: RequestId,
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): Promise<void> {
    const pending = this.pendingServerRequests.get(requestKey(requestId))
    if (!pending || pending.request.method !== "item/tool/requestUserInput") {
      throw new Error(`Request ${String(requestId)} is not a user-input request`)
    }
    const response: ToolRequestUserInputResponse = {
      answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, { answers: typeof answer === "string" ? [answer] : [...answer] }])),
    }
    await this.respondToServerRequest(requestId, response)
  }

  close(): Promise<void> {
    return this.rpc.close()
  }

  private receiveServerRequest(request: ServerCall): void {
    const event = mapServerRequest(request)
    const approval = event.type === "approval.requested" ? event.approval : undefined
    const supported = approval || event.type === "userInput.requested"
    if (supported) this.pendingServerRequests.set(requestKey(request.id), { request, approval, answered: false })
    if (approval) this.approvalWireIds.set(approval.id, request.id)
    this.emit(event)
    for (const listener of this.serverRequestListeners) listener(request)
    if (!supported && this.serverRequestListeners.size === 0) {
      void this.rpc.respondError(request.id, -32601, `Unsupported server request: ${request.method}`)
        .catch((error: unknown) => this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) }))
    }
  }

  private emit(event: CodexAdapterEvent): void {
    if (event.type === "approval.resolved") {
      const pending = this.pendingServerRequests.get(requestKey(event.requestId))
      if (pending?.approval) this.approvalWireIds.delete(pending.approval.id)
      this.pendingServerRequests.delete(requestKey(event.requestId))
    }
    for (const listener of this.listeners) listener(event)
  }

  private wireRequestId(id: RequestId): RequestId {
    return typeof id === "string" ? this.approvalWireIds.get(id) ?? id : id
  }

  private handleDisconnect(error?: Error): void {
    this.connected = false
    const message = error?.message ?? "Codex app-server connection closed"
    for (const pending of this.pendingServerRequests.values()) {
      this.emit({
        type: "approval.cancelled",
        requestId: pending.request.id,
        ...(pending.approval ? { approvalId: pending.approval.id } : {}),
        error: message,
      })
    }
    this.pendingServerRequests.clear()
    this.approvalWireIds.clear()
    this.emit({ type: "connection", status: error ? "error" : "disconnected", ...(error ? { error: message } : {}) })
  }

  private async loadResumeTurns(raw: ThreadResumeResponse): Promise<Turn[]> {
    if (raw.initialTurnsPage === undefined && raw.thread.turns.length > 0) return raw.thread.turns
    let data = raw.initialTurnsPage?.data ?? []
    let cursor = raw.initialTurnsPage?.nextCursor ?? undefined
    if (!raw.initialTurnsPage) {
      const first = await this.listTurns({ threadId: raw.thread.id, limit: 100, sortDirection: "desc", itemsView: "full" })
      data = first.data
      cursor = first.nextCursor ?? undefined
    }
    while (cursor) {
      const page = await this.listTurns({ threadId: raw.thread.id, cursor, limit: 100, sortDirection: "desc", itemsView: "full" })
      data = [...data, ...page.data]
      cursor = page.nextCursor ?? undefined
    }
    const chronological = [...data].reverse()
    return Promise.all(chronological.map((turn) => this.loadFullTurn(raw.thread.id, turn)))
  }

  private async loadFullTurn(thread: string, turn: Turn): Promise<Turn> {
    if (turn.itemsView === "full") return turn
    let cursor: string | undefined
    const items = []
    do {
      const page = await this.listItems({ threadId: thread, turnId: turn.id, cursor, limit: 100, sortDirection: "asc" })
      items.push(...page.data.map((entry) => entry.item))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return { ...turn, items, itemsView: "full" }
  }
}

export function createCodexAppServerClient(
  transportOptions: StdioTransportOptions = {},
  clientOptions: CodexClientOptions = {},
): CodexAppServerClient {
  return new CodexAppServerClient(new StdioTransport(transportOptions), clientOptions)
}

function session(raw: ThreadStartResponse | ThreadResumeResponse | ThreadForkResponse, turns = raw.thread.turns): ThreadSession {
  return {
    summary: mapThreadSummary(raw.thread),
    relation: mapThreadRelation(raw.thread),
    model: raw.model,
    modelProvider: raw.modelProvider,
    serviceTier: raw.serviceTier,
    cwd: raw.cwd,
    reasoningEffort: raw.reasoningEffort,
    events: hydrateTurns(turns, raw.thread.id),
    raw,
  }
}

function normalizeInput(input: string | readonly UserInput[]): UserInput[] {
  return typeof input === "string"
    ? [{ type: "text", text: input, text_elements: [] }]
    : [...input]
}

function approvalResult(request: ServerCall, choice: string, rejection: string): ApprovalResult {
  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const params = request.params as CommandExecutionRequestApprovalParams
      const decision = parseCommandDecision(choice)
      if (params.availableDecisions?.length && !params.availableDecisions.some((available) => sameDecision(available, decision))) {
        throw new Error(`Decision ${choice} is not available for request ${String(request.id)}`)
      }
      return { decision }
    }
    case "item/fileChange/requestApproval":
      if (!isFileDecision(choice)) throw new Error(`Invalid file-change decision: ${choice}`)
      return { decision: choice }
    case "item/permissions/requestApproval": {
      const params = request.params as PermissionsRequestApprovalParams
      if (choice === "decline") return { permissions: {}, scope: "turn" }
      if (choice === "grant-turn" || choice === "grant-session") {
        return {
          permissions: requestedPermissions(params),
          scope: choice === "grant-session" ? "session" : "turn",
        }
      }
      throw new Error(`Invalid permission decision: ${choice}`)
    }
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: legacyDecision(choice, rejection) }
    default:
      throw new Error(`Server request ${request.method} is not an approval`)
  }
}

function parseCommandDecision(choice: string): CommandExecutionApprovalDecision {
  if (choice === "accept" || choice === "acceptForSession" || choice === "decline" || choice === "cancel") return choice
  try {
    return JSON.parse(choice) as CommandExecutionApprovalDecision
  } catch {
    throw new Error(`Invalid command decision: ${choice}`)
  }
}

function sameDecision(left: CommandExecutionApprovalDecision, right: CommandExecutionApprovalDecision): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isFileDecision(choice: string): choice is FileChangeApprovalDecision {
  return choice === "accept" || choice === "acceptForSession" || choice === "decline" || choice === "cancel"
}

function requestedPermissions(params: PermissionsRequestApprovalParams): GrantedPermissionProfile {
  return {
    ...(params.permissions.network ? { network: params.permissions.network } : {}),
    ...(params.permissions.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}),
  }
}

function legacyDecision(choice: string, rejection: string): string | Record<string, unknown> {
  if (choice === "approved" || choice === "approved_for_session" || choice === "abort") return choice
  if (choice === "denied") return { denied: { rejection } }
  throw new Error(`Invalid legacy approval decision: ${choice}`)
}

function requestKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`
}
