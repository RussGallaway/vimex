import type { BackgroundTerminal, ThreadSummary } from "@vimex/conversation"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useEffect, useRef } from "react"
import { OverlayFrame } from "../app/OverlayFrame"
import { emberTide } from "../theme"

export function ProcessesOverlay(props: {
  rows: readonly BackgroundTerminal[]
  summaries: Readonly<Record<string, ThreadSummary>>
  loading: boolean
  error?: string
  selected: number
}) {
  const listRef = useRef<ScrollBoxRenderable>(null)
  const selected = props.rows[props.selected]
  useEffect(() => {
    if (!selected) return
    listRef.current?.scrollChildIntoView(
      `process-row:${selected.threadId}:${selected.processId}`,
    )
  }, [selected])
  return (
    <OverlayFrame title="Background terminals · this conversation" width={100}>
      <text fg={emberTide.textMuted}>
        ↑/↓ select · enter close · x stop · r refresh · esc close
      </text>
      <scrollbox ref={listRef} flexGrow={1} minHeight={4} marginTop={1}>
        {props.rows.map((row, index) => {
          const owner = props.summaries[row.threadId]
          return (
            <box
              key={`${row.threadId}:${row.processId}`}
              id={`process-row:${row.threadId}:${row.processId}`}
              flexDirection="column"
              paddingX={1}
              marginBottom={1}
              backgroundColor={
                index === props.selected ? emberTide.selection : undefined
              }
            >
              <text wrapMode="none" truncate fg={emberTide.text}>
                {owner?.agentNickname || owner?.title || row.threadId} ·{" "}
                {row.processId}
                {row.osPid === null ? "" : ` · PID ${row.osPid}`}
              </text>
              <text wrapMode="none" truncate fg={emberTide.blueBright}>
                {row.command}
              </text>
              <text wrapMode="none" truncate fg={emberTide.textMuted}>
                {row.cwd}
                {row.cpuPercent === null
                  ? ""
                  : ` · CPU ${row.cpuPercent.toFixed(1)}%`}
                {row.rssKb === null
                  ? ""
                  : ` · RSS ${Math.round(row.rssKb / 1024)} MiB`}
              </text>
            </box>
          )
        })}
      </scrollbox>
      {props.loading ? (
        <text fg={emberTide.textMuted}>Loading running terminals…</text>
      ) : props.rows.length === 0 ? (
        <text fg={emberTide.textMuted}>No running background terminals</text>
      ) : null}
      {props.error ? <text fg={emberTide.amber}>{props.error}</text> : null}
    </OverlayFrame>
  )
}
