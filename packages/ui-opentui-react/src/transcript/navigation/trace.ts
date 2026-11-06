import type { CliRenderer } from "@opentui/core"

export interface NavigationTraceRecord {
  readonly atMs: number
  readonly frameId: number
  readonly kind: string
  readonly details: Readonly<Record<string, unknown>>
}

type Listener = (record: NavigationTraceRecord) => void
const listeners = new WeakMap<CliRenderer, Set<Listener>>()

/** Opt-in sink; callers own retention limits and must unsubscribe on teardown. */
export function subscribeNavigationTrace(
  renderer: CliRenderer,
  listener: Listener,
): () => void {
  let subscriptions = listeners.get(renderer)
  if (!subscriptions) listeners.set(renderer, (subscriptions = new Set()))
  subscriptions.add(listener)
  return () => {
    subscriptions.delete(listener)
    if (!subscriptions.size) listeners.delete(renderer)
  }
}

export function traceNavigation(
  renderer: CliRenderer,
  kind: string,
  details: () => Readonly<Record<string, unknown>>,
): void {
  const subscriptions = listeners.get(renderer)
  if (!subscriptions?.size) return
  const record = {
    atMs: performance.now(),
    frameId: renderer.frameId,
    kind,
    details: details(),
  }
  for (const listener of subscriptions) listener(record)
}
