import type { RequestId } from "../generated/v0_154_0/RequestId"
import type { CodexTransport, JsonObject } from "../transport/transport"
import { PendingRequests } from "./pending-requests"
import { isRecord, routeRpcMessage, type ServerCall, type ServerNotificationMessage } from "./request-router"

export type { ServerCall, ServerNotificationMessage } from "./request-router"

export interface RpcClientOptions {
  /** Reject requests that receive no response. Set to 0 to disable. */
  requestTimeoutMs?: number
}

export class RpcRequestError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${message}`)
    this.name = "RpcRequestError"
  }
}

export class RpcClient {
  private nextId = 1
  private readonly pending: PendingRequests
  private readonly requestListeners = new Set<(request: ServerCall) => void>()
  private readonly notificationListeners = new Set<(notification: ServerNotificationMessage) => void>()
  private readonly unknownListeners = new Set<(message: unknown) => void>()

  constructor(readonly transport: CodexTransport, private readonly options: RpcClientOptions = {}) {
    this.pending = new PendingRequests(options.requestTimeoutMs ?? 30_000)
    transport.onMessage((message) => this.receive(message))
    transport.onClose((error) => this.pending.rejectAll(error ?? new Error("Codex app-server connection closed")))
    transport.onError((error) => this.pending.rejectAll(error))
  }

  async start(): Promise<void> {
    await this.transport.start()
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++
    const promise = this.pending.create<T>(id, method)
    void this.transport.send({ method, id, params } as JsonObject).catch((error: unknown) => {
      this.pending.reject(id, asError(error))
    })
    return promise
  }

  notify(method: string, params?: unknown): Promise<void> {
    const message = params === undefined ? { method } : { method, params }
    return this.transport.send(message)
  }

  respond(id: RequestId, result: unknown): Promise<void> {
    return this.transport.send({ id, result } as JsonObject)
  }

  respondError(id: RequestId, code: number, message: string, data?: unknown): Promise<void> {
    return this.transport.send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } } as JsonObject)
  }

  onRequest(listener: (request: ServerCall) => void): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  onNotification(listener: (notification: ServerNotificationMessage) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onUnknown(listener: (message: unknown) => void): () => void {
    this.unknownListeners.add(listener)
    return () => this.unknownListeners.delete(listener)
  }

  close(): Promise<void> {
    return this.transport.close()
  }

  private receive(value: unknown): void {
    const routed = routeRpcMessage(value)
    if (routed.type === "request") { for (const listener of this.requestListeners) listener(routed.value); return }
    if (routed.type === "notification") { for (const listener of this.notificationListeners) listener(routed.value); return }
    if (routed.type === "unknown") return this.emitUnknown(routed.value)
    const pending = this.pending.take(routed.value.id)
    if (!pending) return this.emitUnknown(value)
    if (isRecord(routed.value.error) && typeof routed.value.error.code === "number" && typeof routed.value.error.message === "string") {
      pending.reject(new RpcRequestError(pending.method, routed.value.error.code, routed.value.error.message, routed.value.error.data))
    } else if ("result" in routed.value) pending.resolve(routed.value.result)
    else pending.reject(new Error(`${pending.method}: malformed response`))
  }

  private emitUnknown(message: unknown): void {
    for (const listener of this.unknownListeners) listener(message)
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
