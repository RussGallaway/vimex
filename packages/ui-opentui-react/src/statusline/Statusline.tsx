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
  if (!summary.contextLimit)
    return `${summary.contextUsed.toLocaleString()} tok`
  const tokens = (value: number) =>
    value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)
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
  const cwd = props.summary?.cwd ?? "No thread"
  const branch = props.summary?.gitBranch
  const metadata = [
    props.pendingApprovals > 0
      ? `${props.pendingApprovals} approval${props.pendingApprovals === 1 ? "" : "s"}`
      : undefined,
    props.pendingQuestions > 0
      ? `${props.pendingQuestions} question${props.pendingQuestions === 1 ? "" : "s"}`
      : undefined,
    props.activeTurn ? "working" : undefined,
    props.summary?.goal
      ? `goal ${props.summary.goal.status}${props.summary.goal.tokenBudget ? ` ${Math.floor((props.summary.goal.tokensUsed / props.summary.goal.tokenBudget) * 100)}%` : ""}`
      : undefined,
    props.selectionCount ? `${props.selectionCount} selected` : undefined,
    props.unseenEntries > 0 ? `↓ ${props.unseenEntries} new` : undefined,
    contextLabel(props.summary),
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <box
      id="status-bar"
      height={1}
      marginTop={1}
      gap={2}
      flexShrink={0}
      flexDirection="row"
      justifyContent="space-between"
      backgroundColor={emberTide.backgroundPanel}
      paddingX={1}
    >
      <box
        flexDirection="row"
        gap={1}
        minWidth={0}
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
      >
        <text width={8} flexShrink={0} fg={modeColor()[props.mode]}>
          <b>{props.mode.toUpperCase()}</b>
        </text>
        {props.pendingKeys ? (
          <text fg={emberTide.amber}>{props.pendingKeys}</text>
        ) : null}
        <text
          id="status-cwd"
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          fg={emberTide.textMuted}
          wrapMode="none"
          truncate
        >
          {cwd}
        </text>
        {branch ? (
          <text
            id="status-branch"
            maxWidth="30%"
            flexShrink={1}
            fg={emberTide.sage}
            wrapMode="none"
            truncate
          >
            git:{branch}
          </text>
        ) : null}
      </box>
      <text
        id="status-metadata"
        height={1}
        maxWidth="55%"
        flexShrink={0}
        fg={emberTide.textSoft}
        wrapMode="none"
        truncate
      >
        {metadata}
      </text>
    </box>
  )
}
