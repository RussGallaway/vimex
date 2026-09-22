import type { ConversationItem } from "@vimex/conversation"
import { emberTide } from "../theme"
import { itemStatusGlyph } from "./item-status"

type AgentItem = Extract<ConversationItem, { kind: "agent" }>

function actionLabel(item: AgentItem): string {
  if (item.action === "activity") return `Subagent ${item.activity}`
  switch (item.action) {
    case "spawn":
      return "Start agent"
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
