import type { Turn } from "@vimex/conversation"
import { memo } from "react"
import { formatDuration } from "../activity/duration"
import { emberTide } from "../theme"

/** Terminal turn metadata is presentation decoration, not transcript content. */
export const TurnActivity = memo(function TurnActivity({ turn }: { turn: Turn }) {
  if (!hasTurnActivity(turn)) return null
  const observedDuration = turn.durationMs ?? (turn.startedAt !== undefined && turn.completedAt !== undefined ? Math.max(0, turn.completedAt - turn.startedAt) : undefined)
  const duration = observedDuration === undefined ? undefined : formatDuration(observedDuration)
  const label = turn.status === "complete" ? duration ? `Worked for ${duration}` : "Worked"
    : turn.status === "failed" ? duration ? `Failed after ${duration}` : "Failed"
      : duration ? `Stopped after ${duration}` : "Stopped"
  return <box id={`decoration:turn:${turn.id}`} height={1} flexDirection="row" gap={1} paddingLeft={2} marginBottom={1} flexShrink={0}>
    <text fg={turn.status === "failed" ? emberTide.red : turn.status === "interrupted" ? emberTide.amber : emberTide.blueBright}>{turn.status === "complete" ? "✓" : turn.status === "failed" ? "×" : "■"}</text>
    <text fg={emberTide.textMuted}>{label}</text>
  </box>
})

export function hasTurnActivity(turn: Turn): boolean {
  return turn.status === "failed" || turn.status === "interrupted"
    || (turn.status === "complete" && (turn.durationMs !== undefined || (turn.startedAt !== undefined && turn.completedAt !== undefined)))
}
