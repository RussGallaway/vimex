import { useSyncExternalStore } from "react"

const frames = ["◌", "◍"] as const
const intervalMs = 450
const listeners = new Set<() => void>()
let phase = 0
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === undefined) {
    timer = setInterval(() => {
      phase = (phase + 1) % frames.length
      for (const notify of listeners) notify()
    }, intervalMs)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
      phase = 0
    }
  }
}

const inactiveSubscribe = () => () => {}
const getPhase = () => phase
const getInactivePhase = () => 0

/** One slow pulse for mounted running agents, with no timer per row. */
export function useAgentPulse(active: boolean): string {
  const current = useSyncExternalStore(
    active ? subscribe : inactiveSubscribe,
    active ? getPhase : getInactivePhase,
    getInactivePhase,
  )
  return frames[current]!
}
