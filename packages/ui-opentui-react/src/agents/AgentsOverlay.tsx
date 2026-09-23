import type { ScrollBoxRenderable } from "@opentui/core"
import type { AgentRosterRow } from "@vimex/workbench"
import { useEffect, useRef } from "react"
import { OverlayFrame } from "../app/OverlayFrame"
import { emberTide } from "../theme"

const glyph: Record<AgentRosterRow["status"], string> = {
  running: "◌",
  complete: "✓",
  error: "✕",
  interrupted: "■",
}

export function AgentsOverlay(props: {
  rows: readonly AgentRosterRow[]
  selected: number
  hideFinished: boolean
  scoped: boolean
}) {
  const listRef = useRef<ScrollBoxRenderable>(null)
  const selectedThreadId = props.rows[props.selected]?.threadId
  useEffect(() => {
    const list = listRef.current
    if (!selectedThreadId || !list) return
    list.scrollChildIntoView(`agent-row:${selectedThreadId}`)
    list.requestRender()
  }, [selectedThreadId])
  let runningHeader = false
  let finishedHeader = false
  return (
    <OverlayFrame
      title={
        props.scoped ? "Choose child transcript" : "Agents · this conversation"
      }
      width={88}
    >
      <text fg={emberTide.textMuted}>
        ↑/↓ move · enter open ·{" "}
        {props.scoped
          ? ""
          : `h ${props.hideFinished ? "show" : "hide"} finished · `}
        esc close
      </text>
      <scrollbox ref={listRef} flexGrow={1} minHeight={4} marginTop={1}>
        {props.rows.map((row, index) => {
          const firstRunning = row.status === "running" && !runningHeader
          const firstFinished = row.status !== "running" && !finishedHeader
          if (firstRunning) runningHeader = true
          if (firstFinished) finishedHeader = true
          return (
            <box key={row.threadId} flexDirection="column">
              {firstRunning || firstFinished ? (
                <text marginTop={index ? 1 : 0} fg={emberTide.textMuted}>
                  {firstRunning ? "RUNNING" : "FINISHED"}
                </text>
              ) : null}
              <box
                id={`agent-row:${row.threadId}`}
                height={2}
                flexShrink={0}
                paddingX={1}
                backgroundColor={
                  index === props.selected ? emberTide.selection : undefined
                }
              >
                <box
                  height={1}
                  flexDirection="row"
                  justifyContent="space-between"
                  gap={1}
                >
                  <text
                    flexGrow={1}
                    flexShrink={1}
                    minWidth={0}
                    wrapMode="none"
                    truncate
                    fg={
                      index === props.selected
                        ? emberTide.selectionText
                        : emberTide.text
                    }
                  >
                    {glyph[row.status]} {row.name}
                  </text>
                  <text flexShrink={0} fg={emberTide.textMuted}>
                    {row.status === "running"
                      ? " · Working"
                      : row.status === "complete"
                        ? " · Completed"
                        : row.status === "error"
                          ? " · Failed"
                          : " · Interrupted"}
                  </text>
                </box>
                <text fg={emberTide.textMuted} wrapMode="none" truncate>
                  {row.result || row.assignment || ""}
                </text>
              </box>
            </box>
          )
        })}
      </scrollbox>
      {props.rows.length === 0 ? (
        <text marginTop={1} fg={emberTide.textMuted}>
          {props.hideFinished
            ? "No running agents"
            : "No agents in this conversation"}
        </text>
      ) : null}
    </OverlayFrame>
  )
}
