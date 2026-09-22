import type { TranscriptActivityBatch } from "@vimex/transcript"
import { useTerminalDimensions } from "@opentui/react"
import { emberTide } from "../theme"

function durationLabel(durationMs: number): string {
  return durationMs < 1000
    ? `${Math.round(durationMs)}ms`
    : `${(durationMs / 1000).toFixed(1)}s`
}

export function ActivityBatch({ batch }: { batch: TranscriptActivityBatch }) {
  const terminal = useTerminalDimensions()
  // Duration is useful context, but identity and count win in constrained panes.
  const duration =
    batch.durationMs !== undefined && terminal.width >= 48
      ? ` · ${durationLabel(batch.durationMs)}`
      : ""
  const summary = `${batch.label} · ${batch.countLabel}${duration}`
  return (
    <box backgroundColor={emberTide.backgroundRaised} paddingX={1}>
      <box height={1} flexDirection="row" gap={1}>
        <text
          id={`decoration:fold:${batch.leadItemId}`}
          flexShrink={0}
          fg={emberTide.textMuted}
        >
          ▸
        </text>
        <text
          id={`decoration:status:${batch.leadItemId}`}
          flexShrink={0}
          fg={emberTide.sage}
        >
          ✓
        </text>
        <text
          fg={emberTide.text}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          wrapMode="none"
          truncate
        >
          {summary}
        </text>
      </box>
    </box>
  )
}
