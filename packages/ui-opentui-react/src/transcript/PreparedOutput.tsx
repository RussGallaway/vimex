import {
  ScrollBoxRenderable,
  TextRenderable,
  type OptimizedBuffer,
  type TextOptions,
  type RenderContext,
} from "@opentui/core"
import { extend, type ExtendedComponentProps } from "@opentui/react"
import type { PreparedTextViewport } from "./prepared-text-viewport"

/** Prepared painting retains the original native source buffer for layout,
 * hit-testing, selection, and immediate fallback. It does not replace layout. */
export class PreparedOutputRenderable extends TextRenderable {
  private preparedPaint?: {
    provider: () => PreparedTextViewport | undefined
    onPaint?: (rows: number, prepared: boolean) => void
  }
  private readonly counts = {
    preparedPaints: 0,
    nativePaints: 0,
    selectionFallbacks: 0,
    staleFallbacks: 0,
    rowsPainted: 0,
  }

  constructor(context: RenderContext, options: TextOptions) {
    super(context, options)
  }

  get paintDiagnostics() {
    return { ...this.counts }
  }

  /** The bridge owns validity and retention. Installing never changes source
   * text, wrapping, height, selection, or runtime geometry. */
  installPreparedPaint(
    provider: () => PreparedTextViewport | undefined,
    onPaint?: (rows: number, prepared: boolean) => void,
  ): () => void {
    const binding = { provider, onPaint }
    this.preparedPaint = binding
    this.requestRender()
    return () => {
      if (this.preparedPaint !== binding) return
      this.preparedPaint = undefined
      if (!this.isDestroyed) this.requestRender()
    }
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const native = () => {
      this.counts.nativePaints++
      super.renderSelf(buffer)
      this.preparedPaint?.onPaint?.(0, false)
    }
    const binding = this.preparedPaint
    if (!binding) return native()
    if (this.hasSelection() || this.lastLocalSelection?.isActive) {
      this.counts.selectionFallbacks++
      return native()
    }
    const prepared = binding.provider()
    // drawText and TextBuffer width policies are not universally equivalent.
    // This first painter certifies unicode, transparent backgrounds and the
    // unscrolled plain Text body used by completed command-output fragments.
    if (
      !prepared ||
      buffer.widthMethod !== "unicode" ||
      this.buffered ||
      this.bg.a !== 0 ||
      this.scrollX !== 0 ||
      this.scrollY !== 0 ||
      this._firstLineOffset !== 0 ||
      this.truncate ||
      prepared.width !== this.width ||
      prepared.rowCount !== this.height
    ) {
      this.counts.staleFallbacks++
      return native()
    }
    const x = this.screenX
    const y = this.screenY
    let left = Math.max(0, x)
    let top = Math.max(0, y)
    let right = Math.min(buffer.width, x + this.width)
    let bottom = Math.min(buffer.height, y + this.height)
    // Parent scissors still govern actual writes. This intersection also
    // bounds source-row extraction when a tall body extends offscreen.
    for (let ancestor = this.parent; ancestor; ancestor = ancestor.parent) {
      if (!(ancestor instanceof ScrollBoxRenderable)) continue
      const viewport = ancestor.viewport
      left = Math.max(left, viewport.screenX)
      top = Math.max(top, viewport.screenY)
      right = Math.min(right, viewport.screenX + viewport.width)
      bottom = Math.min(bottom, viewport.screenY + viewport.height)
    }
    if (right <= left || bottom <= top) return
    const start = Math.max(0, Math.ceil(top - y))
    const end = Math.min(this.height, Math.floor(bottom - y))
    const rows = prepared.rows(start, Math.max(0, end - start))
    buffer.pushScissorRect(left, top, right - left, bottom - top)
    try {
      for (const row of rows)
        buffer.drawText(
          row.text,
          x,
          y + row.row,
          this.fg,
          this.bg,
          this.attributes,
        )
    } finally {
      buffer.popScissorRect()
    }
    this.counts.preparedPaints++
    this.counts.rowsPainted += rows.length
    binding.onPaint?.(rows.length, true)
  }

  override destroy(): void {
    this.preparedPaint = undefined
    super.destroy()
  }
}

extend({ preparedOutputText: PreparedOutputRenderable })
declare module "@opentui/react" {
  interface OpenTUIComponents {
    preparedOutputText: typeof PreparedOutputRenderable
  }
}

export function PreparedOutput(
  props: ExtendedComponentProps<typeof PreparedOutputRenderable>,
) {
  return <preparedOutputText {...props} />
}
