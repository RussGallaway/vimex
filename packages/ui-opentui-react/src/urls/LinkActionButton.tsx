import { useRef } from "react"
import { emberTide } from "../theme"
import { unmodifiedLeftMouse } from "./link-pointer"

/** Left-button controls deliberately do not depend on a terminal context menu. */
export function LinkActionButton(props: {
  id: string
  label: string
  onActivate(): void
}) {
  const down = useRef<
    { x: number; y: number; activate: () => void } | undefined
  >(undefined)
  return (
    <text
      id={props.id}
      flexShrink={0}
      fg={emberTide.blueBright}
      selectable={false}
      onMouseDown={(event) => {
        down.current = unmodifiedLeftMouse(event)
          ? { x: event.x, y: event.y, activate: props.onActivate }
          : undefined
        event.stopPropagation()
      }}
      onMouseDrag={() => {
        down.current = undefined
      }}
      onMouseUp={(event) => {
        const start = down.current
        down.current = undefined
        event.stopPropagation()
        if (
          start &&
          unmodifiedLeftMouse(event) &&
          start.x === event.x &&
          start.y === event.y
        )
          start.activate()
      }}
    >
      [{props.label}]
    </text>
  )
}
