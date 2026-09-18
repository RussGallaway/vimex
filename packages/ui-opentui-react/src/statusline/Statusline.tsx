import { useTerminalDimensions } from "@opentui/react"
import type { ThreadSummary } from "@vimex/conversation"
import type { VimMode } from "@vimex/interaction"
import { emberTide } from "../theme"

const modeColor = (): Record<VimMode, string> => ({
  normal: emberTide.blueBright,
  insert: emberTide.sage,
  visual: emberTide.amber,
  command: emberTide.ember,
})

function contextLabel(summary: ThreadSummary | undefined): string {
  if (summary?.contextUsed === undefined) return "context —"
  if (!summary.contextLimit) return `${summary.contextUsed.toLocaleString()} tok`
  const tokens = (value: number) => value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)
  return `${tokens(summary.contextUsed)}/${tokens(summary.contextLimit)} · ${Math.round((summary.contextUsed / summary.contextLimit) * 100)}% context`
}

export function Statusline(props: {
  mode: VimMode
  summary?: ThreadSummary
  pendingKeys: string
  unseenEntries: number
  selectionCount?: number
  pendingApprovals: number
  pendingQuestions: number
  activeTurn: boolean
}) {
  const narrow = useTerminalDimensions().width < 110
  const cwd = props.summary?.cwd ?? "No thread"
  const branch = props.summary?.gitBranch
  return (
    <box
      id="status-bar"
      height={narrow ? 2 : 1}
      flexShrink={0}
      flexDirection={narrow ? "column" : "row"}
      justifyContent="space-between"
      backgroundColor={emberTide.backgroundPanel}
      paddingX={1}
    >
      <box flexDirection="row" gap={1} minWidth={0} flexGrow={1} flexShrink={1} overflow="hidden">
        <text width={8} flexShrink={0} fg={modeColor()[props.mode]}>
          <b>{props.mode.toUpperCase()}</b>
        </text>
        {props.pendingKeys ? <text fg={emberTide.amber}>{props.pendingKeys}</text> : null}
        <text fg={emberTide.textMuted} wrapMode="none">{cwd}</text>
        {branch ? <text fg={emberTide.sage}>git:{branch}</text> : null}
      </box>
      <box flexDirection="row" gap={1} flexShrink={0}>
        {props.pendingApprovals > 0 ? <text fg={emberTide.amber}>{props.pendingApprovals} approval{props.pendingApprovals === 1 ? "" : "s"}</text> : null}
        {props.pendingQuestions > 0 ? <text fg={emberTide.amber}>{props.pendingQuestions} question{props.pendingQuestions === 1 ? "" : "s"}</text> : null}
        <text fg={emberTide.blueBright}>{props.activeTurn ? "working" : props.summary?.status ?? "disconnected"}</text>
        {props.selectionCount ? <text fg={emberTide.amber}>{props.selectionCount} selected</text> : null}
        {props.unseenEntries > 0 ? <text fg={emberTide.blueBright}>↓ {props.unseenEntries} new</text> : null}
        <text fg={emberTide.textMuted}>{contextLabel(props.summary)}</text>
        <text fg={emberTide.textSoft}>{props.summary?.reasoningEffort ?? "—"}</text>
        <text fg={emberTide.text}>{props.summary?.model ?? "disconnected"}</text>
      </box>
    </box>
  )
}
