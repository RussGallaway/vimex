import {
  itemId,
  threadId,
  turnId,
  type AgentCoordinationAction,
  type AgentStateStatus,
  type ConversationEvent,
  type ConversationItem,
  type ItemActivity,
  type ItemStatus,
  type TurnOutcome,
} from "@vimex/conversation"
import type { ThreadItem } from "../generated/v0_154_0/v2/ThreadItem"
import type { Turn } from "../generated/v0_154_0/v2/Turn"
import type { UserInput } from "../generated/v0_154_0/v2/UserInput"
import type { CollabAgentStatus } from "../generated/v0_154_0/v2/CollabAgentStatus"
import { commandTitle } from "./command-presentation"
import { isRecord } from "../rpc/request-router"

export function mapThreadItem(
  item: ThreadItem,
  ownerTurnId: string,
  completed: boolean,
): ConversationItem {
  const id = itemId(item.id)
  const owner = turnId(ownerTurnId)
  const fallbackStatus: ItemStatus = completed ? "complete" : "running"
  switch (item.type) {
    case "userMessage":
      return {
        id,
        turnId: owner,
        kind: "user",
        markdown: inputText(item.content),
        status: fallbackStatus,
      }
    case "agentMessage":
      return {
        id,
        turnId: owner,
        kind: "assistant",
        markdown: item.text,
        status: fallbackStatus,
      }
    case "plan":
      return {
        id,
        turnId: owner,
        kind: "assistant",
        markdown: item.text,
        status: fallbackStatus,
      }
    case "reasoning":
      return {
        id,
        turnId: owner,
        kind: "reasoning",
        markdown: item.summary.join("\n\n") || item.content.join("\n\n"),
        status: fallbackStatus,
      }
    case "commandExecution": {
      const activity = commandActivity(item.commandActions ?? [])
      return {
        id,
        turnId: owner,
        kind: "command",
        title: commandTitle(item.command, item.commandActions ?? []),
        executionCommand: item.command,
        ...(item.source === "userShell" ? { userInitiated: true } : {}),
        detail: item.aggregatedOutput ?? "",
        durationMs: durationMs(item.durationMs),
        ...(activity ? { activity } : {}),
        status: mapItemStatus(item.status, fallbackStatus),
      }
    }
    case "fileChange":
      return {
        id,
        turnId: owner,
        kind: "edit",
        title:
          item.changes.map((change) => change.path).join(", ") ||
          "File changes",
        changes: item.changes.map((change) => ({
          path: change.path,
          action: change.kind.type,
          ...(change.kind.type === "update" && change.kind.move_path
            ? { movePath: change.kind.move_path }
            : {}),
          patch: change.diff,
        })),
        patch: item.changes
          .map((change) => change.diff)
          .filter(Boolean)
          .join("\n"),
        status: mapItemStatus(item.status, fallbackStatus),
      }
    case "mcpToolCall":
      return toolItem(
        id,
        owner,
        `${item.server} · ${item.tool}`,
        item.result ?? item.error ?? item.arguments,
        mapItemStatus(item.status, fallbackStatus),
        item.durationMs,
        item.readOnlyHint === true
          ? providerActivity(item.server, item.tool, item.appContext?.appName)
          : undefined,
      )
    case "dynamicToolCall":
      return toolItem(
        id,
        owner,
        [item.namespace, item.tool].filter(Boolean).join(" · "),
        item.contentItems ?? item.arguments,
        mapItemStatus(item.status, fallbackStatus),
        item.durationMs,
      )
    case "collabAgentToolCall": {
      if (
        !isAgentTool(item.tool) ||
        typeof item.senderThreadId !== "string" ||
        !Array.isArray(item.receiverThreadIds) ||
        !item.receiverThreadIds.every((id) => typeof id === "string")
      ) {
        return {
          id,
          turnId: owner,
          kind: "unknown",
          title: "Invalid agent activity",
          detail: safeStringify(item),
          status: fallbackStatus,
          transcript: "diagnostic",
        }
      }
      const action = mapAgentAction(item.tool)
      const states = isRecord(item.agentsStates) ? item.agentsStates : {}
      return {
        id,
        turnId: owner,
        kind: "agent",
        action,
        detail: typeof item.prompt === "string" ? item.prompt : "",
        status: mapItemStatus(item.status, fallbackStatus),
        senderThreadId: threadId(item.senderThreadId),
        agentThreadIds: item.receiverThreadIds.map(threadId),
        agentStates: Object.entries(states).flatMap(([id, state]) =>
          isRecord(state) && isAgentStateStatus(state.status)
            ? [
                {
                  threadId: threadId(id),
                  status: mapAgentStateStatus(state.status),
                  ...(typeof state.message === "string" && state.message
                    ? { message: state.message }
                    : {}),
                },
              ]
            : [],
        ),
      }
    }
    case "functionCallOutput":
      return toolItem(
        id,
        owner,
        [item.namespace, item.name].filter(Boolean).join(" · "),
        item.output,
        fallbackStatus,
      )
    case "webSearch":
      return toolItem(
        id,
        owner,
        "Web search",
        item,
        fallbackStatus,
        undefined,
        { family: "web-research" },
      )
    case "imageView":
      return toolItem(id, owner, "View image", item.path, fallbackStatus)
    case "imageGeneration":
      return toolItem(id, owner, "Image generation", item, fallbackStatus)
    case "subAgentActivity":
      return typeof item.agentThreadId === "string" &&
        typeof item.agentPath === "string" &&
        isAgentActivity(item.kind)
        ? {
            id,
            turnId: owner,
            kind: "agent",
            action: "activity",
            activity: item.kind,
            detail: "",
            agentThreadIds: [threadId(item.agentThreadId)],
            agentPath: item.agentPath,
            status: fallbackStatus,
          }
        : {
            id,
            turnId: owner,
            kind: "unknown",
            title: "Invalid subagent activity",
            detail: safeStringify(item),
            status: fallbackStatus,
            transcript: "diagnostic",
          }
    case "sleep":
      return toolItem(id, owner, "Wait", item, fallbackStatus)
    case "enteredReviewMode":
    case "exitedReviewMode":
      return toolItem(
        id,
        owner,
        item.type === "enteredReviewMode"
          ? "Review started"
          : "Review completed",
        item.review,
        fallbackStatus,
      )
    case "contextCompaction":
      return toolItem(id, owner, "Context compacted", "", fallbackStatus)
    case "hookPrompt":
      return toolItem(id, owner, "Hook", item.fragments, fallbackStatus)
    default:
      return {
        id,
        turnId: owner,
        kind: "unknown",
        title: itemType(item),
        detail: safeStringify(item),
        status: fallbackStatus,
      }
  }
}

export function hydrateTurns(
  turns: readonly Turn[],
  ownerThreadId: string,
): ConversationEvent[] {
  const events: ConversationEvent[] = []
  const owner = threadId(ownerThreadId)
  for (const turn of turns) {
    const key = turnId(turn.id)
    events.push({
      type: "turn.started",
      threadId: owner,
      turnId: key,
      startedAt: timestampMs(turn.startedAt),
    })
    for (const item of turn.items) {
      const completed = turn.status !== "inProgress"
      events.push({
        type: "item.started",
        threadId: owner,
        item: mapThreadItem(item, turn.id, completed),
      })
      if (completed)
        events.push({
          type: "item.completed",
          threadId: owner,
          item: mapThreadItem(item, turn.id, true),
        })
    }
    const outcome = mapTerminalTurnStatus(turn.status)
    if (outcome)
      events.push({
        type: "turn.completed",
        threadId: owner,
        turnId: key,
        outcome,
        startedAt: timestampMs(turn.startedAt),
        completedAt: timestampMs(turn.completedAt),
        durationMs: durationMs(turn.durationMs),
      })
  }
  return events
}

export function mapTurnStatus(
  status: unknown,
): "complete" | "failed" | "interrupted" | "running" {
  switch (status) {
    case "completed":
      return "complete"
    case "failed":
      return "failed"
    case "interrupted":
      return "interrupted"
    default:
      return "running"
  }
}
export function mapTerminalTurnStatus(
  status: unknown,
): TurnOutcome | undefined {
  const mapped = mapTurnStatus(status)
  return mapped === "running" ? undefined : mapped
}

export function safeStringify(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function mapItemStatus(
  status: unknown,
  fallback: ItemStatus = "running",
): ItemStatus {
  switch (status) {
    case "completed":
      return "complete"
    case "failed":
    case "declined":
      return "error"
    case "interrupted":
      return "interrupted"
    case "inProgress":
      return "running"
    default:
      return fallback
  }
}
function mapAgentAction(
  tool: Extract<ThreadItem, { type: "collabAgentToolCall" }>["tool"],
): AgentCoordinationAction {
  switch (tool) {
    case "spawnAgent":
      return "spawn"
    case "sendInput":
      return "send-input"
    case "sendMessage":
      return "send-message"
    case "followupTask":
      return "follow-up"
    case "resumeAgent":
      return "resume"
    case "wait":
      return "wait"
    case "interruptAgent":
      return "interrupt"
    case "closeAgent":
      return "close"
    case "listAgents":
      return "list"
  }
}
function isAgentTool(
  value: unknown,
): value is Extract<ThreadItem, { type: "collabAgentToolCall" }>["tool"] {
  return (
    value === "spawnAgent" ||
    value === "sendInput" ||
    value === "sendMessage" ||
    value === "followupTask" ||
    value === "resumeAgent" ||
    value === "wait" ||
    value === "interruptAgent" ||
    value === "closeAgent" ||
    value === "listAgents"
  )
}
function mapAgentStateStatus(status: CollabAgentStatus): AgentStateStatus {
  switch (status) {
    case "pendingInit":
      return "pending"
    case "running":
      return "running"
    case "interrupted":
      return "interrupted"
    case "completed":
      return "complete"
    case "errored":
      return "error"
    case "shutdown":
      return "closed"
    case "notFound":
      return "missing"
  }
}
function isAgentStateStatus(value: unknown): value is CollabAgentStatus {
  return (
    value === "pendingInit" ||
    value === "running" ||
    value === "interrupted" ||
    value === "completed" ||
    value === "errored" ||
    value === "shutdown" ||
    value === "notFound"
  )
}
function isAgentActivity(
  value: unknown,
): value is Extract<ThreadItem, { type: "subAgentActivity" }>["kind"] {
  return (
    value === "started" ||
    value === "interacted" ||
    value === "interrupted" ||
    value === "completed"
  )
}
function timestampMs(seconds: number | null): number | undefined {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0)
    return undefined
  const milliseconds = seconds * 1000
  return Number.isFinite(milliseconds) ? milliseconds : undefined
}
function durationMs(value: number | null | undefined): number | undefined {
  return value === null ||
    value === undefined ||
    !Number.isFinite(value) ||
    value < 0
    ? undefined
    : value
}
function toolItem(
  id: ReturnType<typeof itemId>,
  owner: ReturnType<typeof turnId>,
  title: string,
  detail: unknown,
  status: ItemStatus,
  durationMs?: number | null,
  activity?: ItemActivity,
): ConversationItem {
  const duration =
    durationMs === undefined ||
    durationMs === null ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
      ? undefined
      : durationMs
  return {
    id,
    turnId: owner,
    kind: "tool",
    title,
    detail: typeof detail === "string" ? detail : safeStringify(detail),
    status,
    ...(duration === undefined ? {} : { durationMs: duration }),
    ...(activity ? { activity } : {}),
  }
}
function commandActivity(
  actions: readonly { type: string }[],
): ItemActivity | undefined {
  return actions.length > 0 && actions.every((action) => action.type === "read")
    ? { family: "read" }
    : undefined
}
function displayProvider(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ")
}
function providerActivity(
  namespace: string,
  tool: string,
  appName?: string | null,
): ItemActivity {
  const provider =
    appName?.trim() ||
    (namespace === "codex_apps" ? tool.split(/[._]/u)[0]! : namespace)
  return { family: "provider", label: displayProvider(provider) }
}
function inputText(content: readonly UserInput[]): string {
  let image = 0
  let result = ""
  let previous: "text" | "image" | undefined
  for (const input of content) {
    const kind =
      input.type === "text"
        ? "text"
        : input.type === "image" || input.type === "localImage"
          ? "image"
          : undefined
    if (!kind) continue
    const value = input.type === "text" ? input.text : `[Image ${++image}]`
    if (!value) continue
    const separator =
      previous === "text" && kind === "text"
        ? "\n"
        : result && !/\s$/u.test(result) && !/^\s/u.test(value)
          ? " "
          : ""
    result += separator + value
    previous = kind
  }
  return result
}
function itemType(item: never): string {
  const value = item as unknown
  return isRecord(value) && typeof value.type === "string"
    ? value.type
    : "Unknown item"
}
