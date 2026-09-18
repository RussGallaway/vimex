import { itemId, threadId, turnId, type ConversationEvent, type ConversationItem, type ItemStatus } from "@vimex/conversation"
import type { ThreadItem } from "../generated/v0_154_0/v2/ThreadItem"
import type { Turn } from "../generated/v0_154_0/v2/Turn"
import type { UserInput } from "../generated/v0_154_0/v2/UserInput"
import { commandTitle } from "./command-presentation"
import { isRecord } from "../rpc/request-router"

export function mapThreadItem(item: ThreadItem, ownerTurnId: string, completed: boolean): ConversationItem {
  const id = itemId(item.id)
  const owner = turnId(ownerTurnId)
  const fallbackStatus: ItemStatus = completed ? "complete" : "running"
  switch (item.type) {
    case "userMessage": return { id, turnId: owner, kind: "user", markdown: inputText(item.content), status: fallbackStatus }
    case "agentMessage": return { id, turnId: owner, kind: "assistant", markdown: item.text, status: fallbackStatus }
    case "plan": return { id, turnId: owner, kind: "assistant", markdown: item.text, status: fallbackStatus }
    case "reasoning": return { id, turnId: owner, kind: "reasoning", markdown: item.summary.join("\n\n") || item.content.join("\n\n"), status: fallbackStatus }
    case "commandExecution": return { id, turnId: owner, kind: "command", title: commandTitle(item.command, item.commandActions ?? []), executionCommand: item.command, detail: item.aggregatedOutput ?? "", durationMs: item.durationMs ?? undefined, status: mapItemStatus(item.status) }
    case "fileChange": return {
      id, turnId: owner, kind: "edit", title: item.changes.map(change => change.path).join(", ") || "File changes",
      patch: item.changes.map(change => change.diff).filter(Boolean).join("\n"), status: mapItemStatus(item.status),
    }
    case "mcpToolCall": return toolItem(id, owner, `${item.server} · ${item.tool}`, item.result ?? item.error ?? item.arguments, mapItemStatus(item.status), item.durationMs)
    case "dynamicToolCall": return toolItem(id, owner, [item.namespace, item.tool].filter(Boolean).join(" · "), item.contentItems ?? item.arguments, mapItemStatus(item.status), item.durationMs)
    case "collabAgentToolCall": return toolItem(id, owner, `Agent · ${safeStringify(item.tool)}`, { prompt: item.prompt, agents: item.agentsStates }, mapItemStatus(item.status))
    case "functionCallOutput": return toolItem(id, owner, [item.namespace, item.name].filter(Boolean).join(" · "), item.output, fallbackStatus)
    case "webSearch": return toolItem(id, owner, "Web search", item, fallbackStatus)
    case "imageView": return toolItem(id, owner, "View image", item.path, fallbackStatus)
    case "imageGeneration": return toolItem(id, owner, "Image generation", item, fallbackStatus)
    case "subAgentActivity": return toolItem(id, owner, `Subagent · ${item.kind}`, item.agentPath, fallbackStatus)
    case "sleep": return toolItem(id, owner, "Wait", item, fallbackStatus)
    case "enteredReviewMode":
    case "exitedReviewMode": return toolItem(id, owner, item.type === "enteredReviewMode" ? "Review started" : "Review completed", item.review, fallbackStatus)
    case "contextCompaction": return toolItem(id, owner, "Context compacted", "", fallbackStatus)
    case "hookPrompt": return toolItem(id, owner, "Hook", item.fragments, fallbackStatus)
    default: return { id, turnId: owner, kind: "unknown", title: itemType(item), detail: safeStringify(item), status: fallbackStatus }
  }
}

export function hydrateTurns(turns: readonly Turn[], ownerThreadId: string): ConversationEvent[] {
  const events: ConversationEvent[] = []
  const owner = threadId(ownerThreadId)
  for (const turn of turns) {
    const key = turnId(turn.id)
    events.push({ type: "turn.started", threadId: owner, turnId: key })
    for (const item of turn.items) {
      const completed = turn.status !== "inProgress"
      events.push({ type: "item.started", threadId: owner, item: mapThreadItem(item, turn.id, completed) })
      if (completed) events.push({ type: "item.completed", threadId: owner, item: mapThreadItem(item, turn.id, true) })
    }
    if (turn.status !== "inProgress") events.push({ type: "turn.completed", threadId: owner, turnId: key, outcome: mapTurnStatus(turn.status) })
  }
  return events
}

export function mapTurnStatus(status: unknown): "complete" | "failed" | "interrupted" | "running" {
  switch (status) {
    case "completed": return "complete"
    case "failed": return "failed"
    case "interrupted": return "interrupted"
    default: return "running"
  }
}

export function safeStringify(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function mapItemStatus(status: unknown): ItemStatus {
  switch (status) {
    case "completed": return "complete"
    case "failed":
    case "declined": return "error"
    case "interrupted": return "interrupted"
    default: return "running"
  }
}
function toolItem(id: ReturnType<typeof itemId>, owner: ReturnType<typeof turnId>, title: string, detail: unknown, status: ItemStatus, durationMs?: number | null): ConversationItem {
  return { id, turnId: owner, kind: "tool", title, detail: typeof detail === "string" ? detail : safeStringify(detail), status, ...(durationMs == null ? {} : { durationMs }) }
}
function inputText(content: readonly UserInput[]): string {
  return content.filter((input): input is Extract<UserInput, { type: "text" }> => input.type === "text").map(input => input.text).join("\n")
}
function itemType(item: never): string {
  const value = item as unknown
  return isRecord(value) && typeof value.type === "string" ? value.type : "Unknown item"
}
