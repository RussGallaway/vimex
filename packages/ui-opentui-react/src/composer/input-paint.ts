import type { CliRenderer } from "@opentui/core"

// One renderer may contain main and side panes. Both transcript layout owners
// must yield the same input frame, then resume on the following frame.
const pending = new WeakMap<CliRenderer, Set<() => void>>()
const listeners = new WeakMap<CliRenderer, Set<() => void>>()

export function subscribeComposerPaint(
  renderer: CliRenderer,
  listener: () => void,
): () => void {
  let subscribers = listeners.get(renderer)
  if (!subscribers) listeners.set(renderer, (subscribers = new Set()))
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

export function composerPaintPending(renderer: CliRenderer): boolean {
  return pending.has(renderer)
}

export function requestComposerPaint(
  renderer: CliRenderer,
  publish?: () => void,
): void {
  let callbacks = pending.get(renderer)
  if (!callbacks) {
    callbacks = new Set()
    pending.set(renderer, callbacks)
    const painted = () => {
      const completed = pending.get(renderer)
      pending.delete(renderer)
      renderer.off("destroy", destroyed)
      // Publication may reconcile a whole pane. It belongs after the native
      // character has been painted, outside this render callback stack.
      setTimeout(() => {
        if (renderer.isDestroyed) return
        const nextInput = pending.get(renderer)
        if (nextInput) {
          for (const callback of completed ?? []) nextInput.add(callback)
          return
        }
        for (const callback of completed ?? []) callback()
        // A React notification may replace subscriptions synchronously. Snapshot
        // the listeners so newly subscribed callbacks wait for the next paint.
        for (const listener of [...(listeners.get(renderer) ?? [])]) listener()
        renderer.requestRender()
      }, 0)
    }
    const destroyed = () => {
      pending.delete(renderer)
      renderer.off("frame", painted)
    }
    renderer.once("frame", painted)
    renderer.once("destroy", destroyed)
  }
  if (publish) callbacks.add(publish)
  renderer.requestRender()
}
