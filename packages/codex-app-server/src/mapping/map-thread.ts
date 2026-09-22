import { threadId, type ThreadSummary } from "@vimex/conversation"
import type { Thread } from "../generated/v0_154_0/v2/Thread"
import type { ThreadStatus } from "../generated/v0_154_0/v2/ThreadStatus"
import { isRecord } from "../rpc/request-router"

export type NormalizedThreadStatus = ThreadSummary["status"]
export interface ThreadRelation {
  threadId: ReturnType<typeof threadId>
  parentThreadId?: ReturnType<typeof threadId>
  agentNickname?: string
  agentRole?: string
  source: unknown
}

export function mapThreadSummary(thread: Thread): ThreadSummary {
  return {
    id: threadId(thread.id),
    title: thread.name || thread.preview || "Untitled thread",
    model: thread.model ?? "unknown",
    reasoningEffort: thread.reasoningEffort ?? "default",
    cwd: thread.cwd,
    ...(thread.gitInfo?.branch ? { gitBranch: thread.gitInfo.branch } : {}),
    status: mapThreadStatus(thread.status),
    updatedAt: (thread.recencyAt ?? thread.updatedAt) * 1_000,
  }
}

export function mapThreadRelation(thread: Thread): ThreadRelation {
  return {
    threadId: threadId(thread.id),
    ...(thread.parentThreadId
      ? { parentThreadId: threadId(thread.parentThreadId) }
      : {}),
    ...(thread.agentNickname ? { agentNickname: thread.agentNickname } : {}),
    ...(thread.agentRole ? { agentRole: thread.agentRole } : {}),
    source: thread.source,
  }
}

export function mapThreadStatus(status: ThreadStatus): NormalizedThreadStatus {
  switch (status.type) {
    case "idle":
    case "notLoaded":
      return "idle"
    case "systemError":
      return "disconnected"
    case "active":
      return status.activeFlags.includes("waitingOnApproval") ||
        status.activeFlags.includes("waitingOnUserInput")
        ? "blocked"
        : "working"
  }
}

export function isThreadLike(value: unknown): value is Thread {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.cwd === "string" &&
    isThreadStatus(value.status)
  )
}

export function isThreadStatus(value: unknown): value is ThreadStatus {
  if (!isRecord(value) || typeof value.type !== "string") return false
  return (
    value.type === "idle" ||
    value.type === "notLoaded" ||
    value.type === "systemError" ||
    (value.type === "active" && Array.isArray(value.activeFlags))
  )
}
