import { useEffect, useState } from "react"
import { emberTide } from "../theme"
import { formatDuration } from "./duration"

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

export interface ActivityClock {
  now(): number
  schedule(task: () => void, intervalMs: number): () => void
}

export const systemActivityClock: ActivityClock = {
  now: () => Date.now(),
  schedule(task, intervalMs) {
    const timer = setInterval(task, intervalMs)
    return () => clearInterval(timer)
  },
}

export interface ActivityIndicatorProps {
  active: boolean
  label: string
  /** Observed start time, supplied by the caller; never an estimate of completion. */
  startedAt?: number
  animate?: boolean
  tone?: "working" | "waiting"
  clock?: ActivityClock
}

/** An activity heartbeat, not a claim that the server made progress this tick. */
export function ActivityIndicator({
  active,
  label,
  startedAt,
  animate = true,
  tone = "working",
  clock = systemActivityClock,
}: ActivityIndicatorProps) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active || (!animate && startedAt === undefined)) return
    return clock.schedule(
      () => setTick((value) => value + 1),
      animate ? 120 : 1000,
    )
  }, [active, animate, clock, startedAt])
  const duration =
    startedAt === undefined ? "" : formatDuration(clock.now() - startedAt)
  return (
    <box height={1} flexDirection="row" gap={1} flexShrink={0}>
      <text fg={tone === "waiting" ? emberTide.amber : emberTide.blueBright}>
        {active ? (animate ? frames[tick % frames.length] : "⋯") : "·"}
      </text>
      <text fg={tone === "waiting" ? emberTide.amber : emberTide.textSoft}>
        {label}
      </text>
      {active && duration ? (
        <text fg={emberTide.textMuted}>· {duration}</text>
      ) : null}
    </box>
  )
}
