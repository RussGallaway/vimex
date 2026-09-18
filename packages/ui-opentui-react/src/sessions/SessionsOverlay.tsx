import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import type { ThreadId } from "@vimex/conversation"
import { useEffect, useRef, type RefObject } from "react"
import { OverlayFrame } from "../app/OverlayFrame"
import { emberTide } from "../theme"
import { sessionRecency, type SessionRow } from "./session-search"

export function SessionsOverlay(props: { rows: readonly SessionRow[]; query: string; searchRef: RefObject<InputRenderable | null>; onQuery(value: string): void; onSubmit(): void; active?: ThreadId; selected: number }) {
  const listRef = useRef<ScrollBoxRenderable>(null)
  const selectedId = props.rows[props.selected]?.id
  useEffect(() => {
    const list = listRef.current
    if (!selectedId || !list) return
    list.scrollChildIntoView(`session-row:${selectedId}`)
    list.requestRender()
  }, [selectedId])
  return (
    <OverlayFrame title="Sessions" width={92}>
      <box height={1} flexDirection="row"><text fg={emberTide.blueBright}>/ </text><input id="session-search" ref={props.searchRef} flexGrow={1}
        focused value={props.query} placeholder="fuzzy search title, cwd, branch…" textColor={emberTide.text} cursorColor={emberTide.blueBright}
        backgroundColor={emberTide.backgroundPanel} focusedBackgroundColor={emberTide.backgroundPanel} onInput={props.onQuery} onSubmit={props.onSubmit} /></box>
      <text fg={emberTide.textMuted}>↑/↓ or ctrl-n/p move · enter open · esc close</text>
      <scrollbox ref={listRef} flexGrow={1} minHeight={5} marginTop={1}>
        {props.rows.map(({ id, summary }, index) => {
          const current = index === props.selected
          return (
            <box id={`session-row:${id}`} key={id} height={3} flexShrink={0} backgroundColor={current ? emberTide.selection : emberTide.backgroundRaised} paddingX={1}>
              <box height={1} flexDirection="row" justifyContent="space-between"
              >
                <text fg={current ? emberTide.selectionText : emberTide.text} wrapMode="none">
                  {summary?.status === "working" ? "◌ " : id === props.active ? "● " : "  "}{summary?.title ?? id}
                </text>
                <text fg={summary?.status === "working" ? emberTide.blueBright : emberTide.textMuted}>{summary?.status ?? ""} {sessionRecency(summary?.updatedAt)}</text>
              </box>
              <box height={1} flexDirection="row" justifyContent="space-between"
              backgroundColor={current ? emberTide.selection : emberTide.backgroundRaised} paddingX={1}>
                <text fg={emberTide.textMuted} wrapMode="none">{summary?.cwd ?? ""}</text>
                <text fg={emberTide.textMuted}>{summary?.gitBranch ? `git:${summary.gitBranch}` : ""} {summary?.model ?? ""}</text>
              </box>
            </box>
          )
        })}
        {props.rows.length === 0 ? <text fg={emberTide.textMuted}>No matching sessions</text> : null}
      </scrollbox>
    </OverlayFrame>
  )
}
