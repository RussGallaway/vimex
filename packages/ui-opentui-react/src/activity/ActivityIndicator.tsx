import { useEffect, useState } from "react"
import { emberTide } from "../theme"

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

export interface ActivityIndicatorProps {
  active: boolean
  label: string
  /** Observed start time, supplied by the caller; never an estimate of completion. */
  startedAt?: number
  animate?: boolean
  tone?: "working" | "waiting"
}

/** An activity heartbeat, not a claim that the server made progress this tick. */
export function ActivityIndicator({ active, label, startedAt, animate = true, tone = "working" }: ActivityIndicatorProps) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active || (!animate && startedAt === undefined)) return
    const timer = setInterval(() => setTick(value => value + 1), animate ? 120 : 1000)
    return () => clearInterval(timer)
  }, [active, animate, startedAt])
  const elapsed = startedAt === undefined ? undefined : Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const duration = elapsed === undefined ? "" : elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
  return <box height={1} flexDirection="row" gap={1} flexShrink={0}>
    <text fg={tone === "waiting" ? emberTide.amber : emberTide.blueBright}>{active ? animate ? frames[tick % frames.length] : "⋯" : "·"}</text>
    <text fg={tone === "waiting" ? emberTide.amber : emberTide.textSoft}>{label}</text>
    {active && duration ? <text fg={emberTide.textMuted}>{duration} elapsed</text> : null}
  </box>
}
