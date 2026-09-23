import { previewTitle, threadId, type ThreadSummary } from "@vimex/conversation"
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

function singleLine(value: string | null): string | undefined {
  return value?.replace(/\s+/gu, " ").trim() || undefined
}

export function mapThreadSummary(thread: Thread): ThreadSummary {
  const name = singleLine(thread.name)
  const preview = thread.preview?.trim()
  const agentNickname = singleLine(thread.agentNickname)
  const agentRole = singleLine(thread.agentRole)
  return {
    id: threadId(thread.id),
    title: name || previewTitle(thread.preview ?? ""),
    titleSource: name ? "name" : preview ? "preview" : "untitled",
    ...(thread.parentThreadId
      ? { parentThreadId: threadId(thread.parentThreadId) }
      : {}),
    ...(agentNickname ? { agentNickname } : {}),
    ...(agentRole ? { agentRole } : {}),
    ...(thread.canAcceptDirectInput !== null &&
    thread.canAcceptDirectInput !== undefined
      ? { canAcceptDirectInput: thread.canAcceptDirectInput }
      : {}),
    model: thread.model ?? "unknown",
    reasoningEffort: thread.reasoningEffort ?? "default",
    cwd: thread.cwd,
    ...(thread.gitInfo?.branch ? { gitBranch: thread.gitInfo.branch } : {}),
    status: mapThreadStatus(thread.status),
    updatedAt: (thread.recencyAt ?? thread.updatedAt) * 1_000,
  }
}

export function mapThreadRelation(thread: Thread): ThreadRelation {
  const agentNickname = singleLine(thread.agentNickname)
  const agentRole = singleLine(thread.agentRole)
  return {
    threadId: threadId(thread.id),
    ...(thread.parentThreadId
      ? { parentThreadId: threadId(thread.parentThreadId) }
      : {}),
    ...(agentNickname ? { agentNickname } : {}),
    ...(agentRole ? { agentRole } : {}),
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
