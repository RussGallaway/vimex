import type { ConversationItem } from "@vimex/conversation"
import { emberTide } from "../theme"
import { itemStatusGlyph } from "./item-status"

type AgentItem = Extract<ConversationItem, { kind: "agent" }>

function childTaskLabel(
  item: AgentItem,
  tasks: NonNullable<AgentItem["childTasks"]>,
): string {
  for (const [status, label] of [
    ["running", "Working"],
    ["pending", "Starting"],
    ["error", "Failed"],
    ["missing", "Unavailable"],
    ["interrupted", "Interrupted"],
  ] as const)
    if (tasks.some((task) => task.status === status)) return label
  if (tasks.length && tasks.length === item.agentThreadIds.length) {
    if (tasks.every((task) => task.status === "closed")) return "Closed"
    if (
      tasks.every(
        (task) => task.status === "complete" || task.status === "closed",
      )
    )
      return "Completed"
  }
  return {
    error: "Failed",
    interrupted: "Interrupted",
    running: "Starting",
    complete: "Started",
  }[item.status]
}

function actionLabel(item: AgentItem): string {
  if (item.action === "activity") return `Child ${item.activity}`
  switch (item.action) {
    case "spawn":
      return "CHILD"
    case "send-input":
      return "Send input to agent"
    case "send-message":
      return "Message agent"
    case "follow-up":
      return "Follow up with agent"
    case "resume":
      return "Resume agent"
    case "wait":
      return "Wait for agents"
    case "interrupt":
      return "Interrupt agent"
    case "close":
      return "Close agent"
    case "list":
      return "List agents"
  }
}

export function AgentActivity({
  item,
  folded,
}: {
  item: AgentItem
  folded: boolean
}) {
  const tasks = item.childTasks ?? item.agentStates ?? []
  if (item.action === "spawn") {
    const status = childTaskLabel(item, tasks)
    return (
      <box
        backgroundColor={emberTide.backgroundRaised}
        paddingX={1}
        paddingY={folded ? 0 : 1}
      >
        <box height={1} flexDirection="row" gap={1}>
          <text
            id={`decoration:fold:${item.id}`}
            flexShrink={0}
            fg={emberTide.textMuted}
          >
            {folded ? "▸" : "▾"}
          </text>
          <text
            id={`decoration:action:${item.id}`}
            flexShrink={0}
            fg={emberTide.blueBright}
          >
            CHILD ·
          </text>
          <text
            id={
              folded
                ? `agent-detail:${item.id}`
                : `decoration:assignment:${item.id}`
            }
            flexGrow={1}
            minWidth={0}
            flexShrink={1}
            truncate
            wrapMode="none"
            fg={emberTide.text}
          >
            {folded ? item.detail || "Delegated task" : "Assignment"}
          </text>
          <text
            id={`decoration:status:${item.id}`}
            flexShrink={0}
            fg={
              status === "Failed"
                ? emberTide.red
                : status === "Completed"
                  ? emberTide.sage
                  : emberTide.textMuted
            }
          >
            · {status}
          </text>
        </box>
        {!folded ? (
          <box marginTop={1}>
            <text
              id={`agent-detail:${item.id}`}
              fg={emberTide.textSoft}
              wrapMode="word"
            >
              {item.detail}
            </text>
            {tasks.map((task) => (
              <text
                key={task.threadId}
                id={`decoration:agent-state:${item.id}:${task.threadId}`}
                fg={emberTide.textMuted}
                wrapMode="word"
              >
                {task.threadId} · {task.status}
                {task.message
                  ? `\n${task.status === "complete" ? "Result" : "Update"}: ${task.message}`
                  : ""}
              </text>
            ))}
            {item.agentThreadIds.length ? (
              <text
                id={`decoration:open-child:${item.id}`}
                fg={emberTide.blueBright}
              >
                {item.agentThreadIds.length === 1
                  ? "gc Open child"
                  : "gc Choose child"}
              </text>
            ) : null}
          </box>
        ) : null}
      </box>
    )
  }
  const running = item.status === "running"
  const targetSummary =
    item.agentPath?.split("/").filter(Boolean).at(-1) ??
    (item.agentThreadIds.length
      ? `${item.agentThreadIds.length} agent${item.agentThreadIds.length === 1 ? "" : "s"}`
      : "")
  return (
    <box
      backgroundColor={emberTide.backgroundRaised}
      paddingX={1}
      paddingY={folded ? 0 : 1}
    >
      <box height={1} flexDirection="row" gap={1}>
        <text
          id={`decoration:fold:${item.id}`}
          flexShrink={0}
          fg={emberTide.textMuted}
        >
          {folded ? "▸" : "▾"}
        </text>
        <text
          id={`decoration:status:${item.id}`}
          flexShrink={0}
          fg={
            running
              ? emberTide.blueBright
              : item.status === "error"
                ? emberTide.red
                : emberTide.sage
          }
        >
          {running ? "⋯" : itemStatusGlyph[item.status]}
        </text>
        <text
          id={`decoration:action:${item.id}`}
          fg={emberTide.textSoft}
          flexShrink={0}
        >
          {actionLabel(item)}
        </text>
        {folded && item.detail ? (
          <text
            id={`agent-detail:${item.id}`}
            fg={emberTide.textMuted}
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            wrapMode="none"
            truncate
          >
            {item.detail}
          </text>
        ) : targetSummary ? (
          <text
            id={`decoration:targets:${item.id}`}
            fg={emberTide.textMuted}
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            wrapMode="none"
            truncate
          >
            {targetSummary}
          </text>
        ) : null}
      </box>
      {!folded &&
      (item.agentPath ||
        item.detail ||
        item.agentStates?.length ||
        item.agentThreadIds.length) ? (
        <box marginTop={1} flexDirection="column">
          {item.agentPath ? (
            <text id={`decoration:path:${item.id}`} fg={emberTide.textMuted}>
              {item.agentPath}
            </text>
          ) : null}
          {item.agentThreadIds.length ? (
            <text
              id={`decoration:target-ids:${item.id}`}
              fg={emberTide.textMuted}
            >
              {item.agentThreadIds.join(", ")}
            </text>
          ) : null}
          {item.detail ? (
            <text
              id={`agent-detail:${item.id}`}
              fg={emberTide.textMuted}
              wrapMode="word"
            >
              {item.detail}
            </text>
          ) : null}
          {item.agentStates?.map((state) => (
            <text
              id={`decoration:agent-state:${item.id}:${state.threadId}`}
              key={state.threadId}
              fg={
                state.status === "error" || state.status === "missing"
                  ? emberTide.red
                  : emberTide.textMuted
              }
            >
              {state.threadId} · {state.status}
              {state.message ? ` · ${state.message}` : ""}
            </text>
          ))}
        </box>
      ) : null}
    </box>
  )
}
