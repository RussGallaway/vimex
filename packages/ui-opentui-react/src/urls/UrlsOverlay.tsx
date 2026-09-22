import type { ScrollBoxRenderable } from "@opentui/core"
import type { UrlCandidate } from "@vimex/transcript"
import { useEffect, useRef } from "react"
import { OverlayFrame } from "../app/OverlayFrame"
import { emberTide } from "../theme"

export function UrlsOverlay(props: {
  choices: readonly UrlCandidate[]
  selected: number
}) {
  const listRef = useRef<ScrollBoxRenderable>(null)
  const selectedChoice = props.choices[props.selected]
  const selectedId = selectedChoice
    ? `url-row:${selectedChoice.itemId}:${selectedChoice.from.graphemeOffset}`
    : undefined
  useEffect(() => {
    const list = listRef.current
    if (!selectedId || !list) return
    list.scrollChildIntoView(selectedId)
    list.requestRender()
  }, [selectedId])
  return (
    <OverlayFrame title="Links" width={92}>
      <text fg={emberTide.textMuted}>↑/↓ move · enter open · esc close</text>
      <scrollbox ref={listRef} flexGrow={1} minHeight={4} marginTop={1}>
        {props.choices.map((choice, index) => (
          <box
            id={`url-row:${choice.itemId}:${choice.from.graphemeOffset}`}
            key={`${choice.itemId}:${choice.from.graphemeOffset}:${choice.url}`}
            height={2}
            flexShrink={0}
            paddingX={1}
            backgroundColor={
              index === props.selected
                ? emberTide.selection
                : emberTide.backgroundRaised
            }
          >
            <text
              fg={
                index === props.selected
                  ? emberTide.selectionText
                  : emberTide.text
              }
              wrapMode="none"
            >
              {choice.text || choice.url}
            </text>
            <text fg={emberTide.textMuted} wrapMode="none">
              {choice.url}
            </text>
          </box>
        ))}
        {props.choices.length === 0 ? (
          <text fg={emberTide.textMuted}>No links in this scope</text>
        ) : null}
      </scrollbox>
    </OverlayFrame>
  )
}
