import type { RequestId } from "../generated/v0_154_0/RequestId"

export interface ServerCall {
  method: string
  id: RequestId
  params: unknown
}
export interface ServerNotificationMessage {
  method: string
  params: unknown
}
export interface RpcResponseMessage {
  id: RequestId
  result?: unknown
  error?: unknown
}
export type RoutedRpcMessage =
  | { type: "request"; value: ServerCall }
  | { type: "notification"; value: ServerNotificationMessage }
  | { type: "response"; value: RpcResponseMessage }
  | { type: "unknown"; value: unknown }

/** Classifies one decoded wire value without assigning protocol meaning to payloads. */
export function routeRpcMessage(value: unknown): RoutedRpcMessage {
  if (!isRecord(value)) return { type: "unknown", value }
  if (typeof value.method === "string") {
    if (isRequestId(value.id))
      return {
        type: "request",
        value: { method: value.method, id: value.id, params: value.params },
      }
    return {
      type: "notification",
      value: { method: value.method, params: value.params },
    }
  }
  if (isRequestId(value.id))
    return {
      type: "response",
      value: {
        id: value.id,
        ...("result" in value ? { result: value.result } : {}),
        ...("error" in value ? { error: value.error } : {}),
      },
    }
  return { type: "unknown", value }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number"
}
