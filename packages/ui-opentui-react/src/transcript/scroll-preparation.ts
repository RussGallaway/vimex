import { Renderable, type CliRenderer } from "@opentui/core"

/**
 * OpenTUI 0.5.11 caches placement by frame id, although Yoga may be recalculated
 * within that frame. Keep the version-specific invalidation at this boundary:
 * a preparation pass updates native placement without painting terminal cells.
 */
export function prepareNativeTranscriptLayout(renderer: CliRenderer): void {
  for (const renderable of renderer.getLifecyclePasses())
    if (!renderable.isDestroyed) renderable.onLifecyclePass?.call(renderable)
  const pending: Renderable[] = [renderer.root]
  while (pending.length) {
    const renderable = pending.pop()!
    ;(renderable as unknown as { _lastLayoutFrame: number })._lastLayoutFrame =
      -1
    pending.push(...Renderable.prototype.getChildren.call(renderable))
  }
  renderer.root.calculateLayout()
  renderer.root.updateLayout(0)
}
