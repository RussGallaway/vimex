import { useKeyboard } from "@opentui/react"
import { useEffect, useState } from "react"
import { emberTide } from "../theme"

/** Notices are informational as well as errors; Escape also retains its normal action. */
export function NoticeStrip({ message }: { message?: string }) {
  const [dismissed, setDismissed] = useState<string | undefined>()
  useEffect(() => {
    setDismissed(undefined)
    if (!message) return
    const timer = setTimeout(() => setDismissed(message), 12000)
    return () => clearTimeout(timer)
  }, [message])
  useKeyboard((event) => {
    if (event.name.toLowerCase() === "escape") setDismissed(message)
  })
  if (!message || dismissed === message) return null
  return (
    <box
      id="notice-strip"
      flexShrink={0}
      maxHeight={3}
      paddingX={2}
      overflow="hidden"
      backgroundColor={emberTide.backgroundPanel}
    >
      <text wrapMode="word" fg={emberTide.amber}>
        {message}
      </text>
    </box>
  )
}
