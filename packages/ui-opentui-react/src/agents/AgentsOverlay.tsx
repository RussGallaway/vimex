import type { ScrollBoxRenderable } from "@opentui/core"
import type {
  AgentRelationship,
  ThreadId,
  ThreadSummary,
} from "@vimex/conversation"
import { useEffect, useRef } from "react"
import { OverlayFrame } from "../app/OverlayFrame"
import { emberTide } from "../theme"

export interface AgentNavigationRow {
  direction: "parent" | "child"
  threadId: ThreadId
  link: AgentRelationship
}
export function agentNavigationRows(
  active: ThreadId | undefined,
  links: readonly AgentRelationship[],
): AgentNavigationRow[] {
  if (!active) return []
  const rows: AgentNavigationRow[] = []
  for (const link of links) {
    if (link.childId === active)
      rows.push({ direction: "parent", threadId: link.parentId, link })
    else if (link.parentId === active)
      rows.push({ direction: "child", threadId: link.childId, link })
  }
  return rows
}

export function AgentsOverlay(props: {
  rows: readonly AgentNavigationRow[]
  summaries: Readonly<Record<string, ThreadSummary>>
  selected: number
}) {
  const listRef = useRef<ScrollBoxRenderable>(null)
  const selectedRow = props.rows[props.selected]
  useEffect(() => {
    const list = listRef.current
    if (!selectedRow || !list) return
    list.scrollChildIntoView(
      `agent-row:${selectedRow.direction}:${selectedRow.threadId}`,
    )
    list.requestRender()
  }, [selectedRow])
  return (
    <OverlayFrame title="Agent sessions" width={88}>
      <text fg={emberTide.textMuted}>
        ↑/↓ move · enter navigate · esc close
      </text>
      <scrollbox ref={listRef} flexGrow={1} minHeight={4} marginTop={1}>
        {props.rows.map((row, index) => (
          <box
            id={`agent-row:${row.direction}:${row.threadId}`}
            key={`${row.direction}:${row.threadId}`}
            height={2}
            flexShrink={0}
            paddingX={1}
            backgroundColor={
              index === props.selected ? emberTide.selection : undefined
            }
          >
            <box height={1} flexDirection="row" justifyContent="space-between">
              <text
                fg={
                  index === props.selected
                    ? emberTide.selectionText
                    : emberTide.text
                }
              >
                {row.direction === "parent" ? "↑ parent" : "↓ child"} ·{" "}
                {props.summaries[row.threadId]?.title ?? row.threadId}
              </text>
              <text fg={emberTide.textMuted}>{row.link.relation}</text>
            </box>
            <text fg={emberTide.textMuted}>
              {row.link.agentPath ?? props.summaries[row.threadId]?.cwd ?? ""}
            </text>
          </box>
        ))}
      </scrollbox>
      {props.rows.length === 0 ? (
        <text marginTop={1} fg={emberTide.textMuted}>
          No linked agent sessions
        </text>
      ) : null}
    </OverlayFrame>
  )
}
