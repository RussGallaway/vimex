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

/** Resolve computed local placement for one measured subtree, including culled
 * descendants. This does not calculate Yoga layout or paint terminal cells. */
export function prepareNativeBlockPlacement(root: Renderable): void {
  const pending = [root]
  while (pending.length) {
    const renderable = pending.pop()!
    if (renderable.isDestroyed) continue
    const layout = renderable.getLayoutNode().getComputedLayout()
    // Newly reconciled children may not have participated in Yoga yet. Their
    // normal layout/resize pass will schedule a fresh measurement.
    if (
      ![layout.left, layout.top, layout.width, layout.height].every(
        Number.isFinite,
      )
    )
      continue
    renderable.updateFromLayout()
    pending.push(...Renderable.prototype.getChildren.call(renderable))
  }
}
