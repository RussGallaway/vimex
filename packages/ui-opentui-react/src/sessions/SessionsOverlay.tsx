import type { ThreadId, ThreadSummary } from "@vimex/conversation"
import { OverlayFrame } from "../app/OverlayFrame"
import { emberTide } from "../theme"

export function SessionsOverlay(props: { threads: readonly ThreadId[]; summaries: Readonly<Record<string, ThreadSummary>>; active?: ThreadId; selected: number }) {
  return (
    <OverlayFrame title="Sessions" width={92}>
      <text fg={emberTide.textMuted}>j/k move · enter open · esc close</text>
      <scrollbox flexGrow={1} minHeight={5} marginTop={1}>
        {props.threads.map((id, index) => {
          const summary = props.summaries[id]
          const current = index === props.selected
          return (
            <box key={id} height={2} flexShrink={0} flexDirection="row" justifyContent="space-between"
              backgroundColor={current ? emberTide.selection : emberTide.backgroundRaised} paddingX={1}>
              <text fg={current ? emberTide.selectionText : emberTide.text} wrapMode="none">
                {summary?.status === "working" ? "◌ " : id === props.active ? "● " : "  "}{summary?.title ?? id}
              </text>
              <text fg={emberTide.textMuted}>{summary?.model ?? ""}</text>
            </box>
          )
        })}
      </scrollbox>
    </OverlayFrame>
  )
}
