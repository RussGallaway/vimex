import { mapGoal } from "./map-goal"
import { itemId, threadId, turnId, type ConversationEvent, type ThreadSummary } from "@vimex/conversation"
import type { RequestId } from "../generated/v0_154_0/RequestId"
import type { Thread } from "../generated/v0_154_0/v2/Thread"
import type { ThreadItem } from "../generated/v0_154_0/v2/ThreadItem"
import type { ThreadTokenUsage } from "../generated/v0_154_0/v2/ThreadTokenUsage"
import { isRecord, type ServerNotificationMessage } from "../rpc/request-router"
import { mapTerminalTurnStatus, mapThreadItem, mapTurnStatus, safeStringify } from "./map-item"
import { isThreadLike, isThreadStatus, mapThreadRelation, mapThreadStatus, mapThreadSummary, type NormalizedThreadStatus, type ThreadRelation } from "./map-thread"
import type { ServerRequestEvent } from "./map-server-request"

export interface SubagentLink {
  ownerThreadId: ReturnType<typeof threadId>
  agentThreadId: ReturnType<typeof threadId>
  itemId: ReturnType<typeof itemId>
  relation: "spawned" | "activity" | "target"
  agentPath?: string
}

export type CodexAdapterEvent =
  | { type: "compaction"; threadId: ReturnType<typeof threadId>; turnId: ReturnType<typeof turnId>; phase: "started" | "completed" }
  | { type: "thread.goal"; threadId: ReturnType<typeof threadId>; goal: import("@vimex/conversation").ThreadGoal | null }
  | { type: "connection"; status: "connected" | "disconnected" | "error"; error?: string }
  | { type: "conversation"; event: ConversationEvent }
  | { type: "thread.summary"; summary: ThreadSummary; relation: ThreadRelation }
  | { type: "subagent.link"; link: SubagentLink }
  | { type: "thread.status"; threadId: ReturnType<typeof threadId>; status: NormalizedThreadStatus }
  | { type: "thread.tokenUsage"; threadId: ReturnType<typeof threadId>; turnId: ReturnType<typeof turnId>; used: number; contextLimit?: number; raw: ThreadTokenUsage }
  | { type: "approval.resolved"; requestId: RequestId; threadId: ReturnType<typeof threadId> }
  | { type: "approval.cancelled"; requestId: RequestId; approvalId?: string; error: string }
  | { type: "warning"; threadId?: ReturnType<typeof threadId>; message: string }
  | { type: "error"; willRetry?: boolean; threadId?: ReturnType<typeof threadId>; turnId?: ReturnType<typeof turnId>; message: string }
  | ServerRequestEvent

export function mapNotification(notification: ServerNotificationMessage): CodexAdapterEvent {
  const params = notification.params
  if (!isRecord(params)) return { type: "unknown", method: notification.method, payload: params }
  switch (notification.method) {
    case "thread/goal/updated": {
      const goal = mapGoal(params.goal)
      if (typeof params.threadId === "string" && goal) return { type: "thread.goal", threadId: threadId(params.threadId), goal }
      break
    }
    case "thread/goal/cleared":
      if (typeof params.threadId === "string") return { type: "thread.goal", threadId: threadId(params.threadId), goal: null }
      break
    case "thread/started": {
      const thread = params.thread
      return isThreadLike(thread)
        ? { type: "thread.summary", summary: mapThreadSummary(thread), relation: mapThreadRelation(thread) }
        : { type: "unknown", method: notification.method, payload: params }
    }
    case "thread/compacted":
      if (typeof params.threadId === "string" && typeof params.turnId === "string") return { type: "compaction", phase: "completed", threadId: threadId(params.threadId), turnId: turnId(params.turnId) }
      break
    case "thread/status/changed":
      if (typeof params.threadId === "string" && isThreadStatus(params.status)) return { type: "thread.status", threadId: threadId(params.threadId), status: mapThreadStatus(params.status) }
      break
    case "thread/tokenUsage/updated": {
      if (typeof params.threadId !== "string" || typeof params.turnId !== "string" || !isTokenUsage(params.tokenUsage)) break
      const usage = params.tokenUsage
      return { type: "thread.tokenUsage", threadId: threadId(params.threadId), turnId: turnId(params.turnId), used: usage.last.totalTokens, ...(usage.modelContextWindow === null ? {} : { contextLimit: usage.modelContextWindow }), raw: usage }
    }
    case "turn/started": {
      const turn = params.turn
      if (typeof params.threadId === "string" && isRecord(turn) && typeof turn.id === "string") return { type: "conversation", event: { type: "turn.started", threadId: threadId(params.threadId), turnId: turnId(turn.id), startedAt: timestampMs(turn.startedAt) } }
      break
    }
    case "turn/completed": {
      const turn = params.turn
      const outcome = isRecord(turn) ? mapTerminalTurnStatus(turn.status) : undefined
      if (typeof params.threadId === "string" && isRecord(turn) && typeof turn.id === "string" && outcome) return { type: "conversation", event: {
        type: "turn.completed", threadId: threadId(params.threadId), turnId: turnId(turn.id), outcome,
        startedAt: timestampMs(turn.startedAt), completedAt: timestampMs(turn.completedAt), durationMs: finiteNumber(turn.durationMs),
      } }
      break
    }
    case "item/started":
    case "item/completed": {
      if (typeof params.threadId !== "string" || typeof params.turnId !== "string" || !isRecord(params.item) || typeof params.item.id !== "string") break
      const completed = notification.method === "item/completed"
      const item = safeMapThreadItem(params.item, params.turnId, completed)
      if (item) return { type: "conversation", event: { type: completed ? "item.completed" : "item.started", threadId: threadId(params.threadId), item } }
      break
    }
    case "item/agentMessage/delta":
    case "item/reasoning/summaryTextDelta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
      if (typeof params.threadId === "string" && typeof params.itemId === "string" && typeof params.delta === "string") return { type: "conversation", event: { type: "item.delta", threadId: threadId(params.threadId), itemId: itemId(params.itemId), delta: params.delta } }
      break
    case "item/reasoning/summaryPartAdded":
      if (typeof params.threadId === "string" && typeof params.itemId === "string" && typeof params.summaryIndex === "number") return { type: "conversation", event: { type: "item.delta", threadId: threadId(params.threadId), itemId: itemId(params.itemId), delta: params.summaryIndex > 0 ? "\n\n" : "" } }
      break
    case "item/fileChange/patchUpdated":
      if (typeof params.threadId === "string" && typeof params.turnId === "string" && typeof params.itemId === "string" && Array.isArray(params.changes)) return {
        type: "conversation", event: { type: "item.completed", threadId: threadId(params.threadId), item: mapThreadItem({ type: "fileChange", id: params.itemId, changes: params.changes, status: "inProgress" } as ThreadItem, params.turnId, false) },
      }
      break
    case "item/mcpToolCall/progress":
      if (typeof params.threadId === "string" && typeof params.itemId === "string" && typeof params.message === "string") return { type: "conversation", event: { type: "item.delta", threadId: threadId(params.threadId), itemId: itemId(params.itemId), delta: `\n${params.message}` } }
      break
    case "serverRequest/resolved":
      if (typeof params.threadId === "string" && isRequestId(params.requestId)) return { type: "approval.resolved", requestId: params.requestId, threadId: threadId(params.threadId) }
      break
    case "warning":
    case "configWarning": {
      const message = typeof params.message === "string" ? params.message : typeof params.summary === "string" ? params.summary : safeStringify(params)
      return { type: "warning", ...(typeof params.threadId === "string" ? { threadId: threadId(params.threadId) } : {}), message }
    }
    case "error": {
      const error = params.error
      const message = isRecord(error) && typeof error.message === "string" ? error.message : safeStringify(error)
      return { type: "error", willRetry: params.willRetry === true, ...(typeof params.threadId === "string" ? { threadId: threadId(params.threadId) } : {}), ...(typeof params.turnId === "string" ? { turnId: turnId(params.turnId) } : {}), message }
    }
  }
  return { type: "unknown", method: notification.method, payload: params }
}

/** Adds structural subagent relationships beside the primary normalized event. */
export function mapNotificationEvents(notification: ServerNotificationMessage): CodexAdapterEvent[] {
  const primary = mapNotification(notification)
  const events: CodexAdapterEvent[] = [primary]
  const params = notification.params
  if (notification.method === "thread/started" && isRecord(params) && isThreadLike(params.thread)) {
    const relation = mapThreadRelation(params.thread)
    if (relation.parentThreadId) events.push({ type: "subagent.link", link: { ownerThreadId: relation.parentThreadId, agentThreadId: relation.threadId, itemId: itemId(`thread:${relation.threadId}`), relation: "spawned" } })
  }
  if ((notification.method === "item/started" || notification.method === "item/completed") && isRecord(params) && typeof params.threadId === "string" && isRecord(params.item) && typeof params.item.id === "string") {
    if (params.item.type === "contextCompaction" && typeof params.turnId === "string") events.push({ type: "compaction", phase: notification.method === "item/started" ? "started" : "completed", threadId: threadId(params.threadId), turnId: turnId(params.turnId) })
    const normalized = primary.type === "conversation" && (primary.event.type === "item.started" || primary.event.type === "item.completed") ? primary.event.item : undefined
    if (normalized?.kind === "agent" && normalized.action === "activity") events.push({
      type: "subagent.link", link: { ownerThreadId: threadId(params.threadId), agentThreadId: normalized.agentThreadIds[0]!, itemId: normalized.id, relation: "activity", agentPath: normalized.agentPath },
    })
    if (normalized?.kind === "agent" && normalized.action !== "activity") for (const receiver of normalized.agentThreadIds) {
      events.push({ type: "subagent.link", link: { ownerThreadId: threadId(params.threadId), agentThreadId: receiver, itemId: normalized.id, relation: normalized.action === "spawn" ? "spawned" : "target" } })
    }
  }
  return events
}

function isTokenUsage(value: unknown): value is ThreadTokenUsage {
  return isRecord(value) && isRecord(value.total) && typeof value.total.totalTokens === "number"
    && isRecord(value.last) && typeof value.last.totalTokens === "number"
    && (value.modelContextWindow === null || typeof value.modelContextWindow === "number")
}
function isRequestId(value: unknown): value is RequestId { return typeof value === "string" || typeof value === "number" }
function safeMapThreadItem(value: Record<string, unknown>, ownerTurnId: string, completed: boolean) {
  try { return mapThreadItem(value as ThreadItem, ownerTurnId, completed) } catch { return undefined }
}
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined }
function timestampMs(value: unknown): number | undefined {
  const seconds = finiteNumber(value)
  if (seconds === undefined) return undefined
  const milliseconds = seconds * 1000
  return Number.isFinite(milliseconds) ? milliseconds : undefined
}

export type { NormalizedUserQuestion, ServerRequestEvent } from "./map-server-request"
export type { NormalizedThreadStatus, ThreadRelation } from "./map-thread"
export { hydrateTurns, mapThreadItem } from "./map-item"
export { mapServerRequest } from "./map-server-request"
export { mapThreadRelation, mapThreadStatus, mapThreadSummary } from "./map-thread"
