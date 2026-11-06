import { TextRenderable, type CliRenderer } from "@opentui/core"
import {
  blockKey,
  type GeometryStyleRevision,
  type TranscriptFrame,
} from "@vimex/transcript"
import {
  PreparedTextCache,
  type PreparedTextRequest,
} from "./prepared-text-cache"
import {
  invalidateRenderedBlock,
  type MeasureRenderedBlockInput,
  type NativePoint,
} from "./measure-rendered-block"
import { PreparedOutputRenderable } from "./PreparedOutput"

interface Job {
  readonly key: string
  readonly scope: string
  readonly input: MeasureRenderedBlockInput
  readonly text: string
  readonly body: TextRenderable
  readonly request: PreparedTextRequest
}
export interface PreparedRuntimeGeometryScheduler {
  schedule(task: () => void): unknown
  cancel(handle: unknown): void
}
interface PreparationViewport {
  readonly screenY: number
  readonly height: number
}
const scheduler: PreparedRuntimeGeometryScheduler = {
  schedule: (task) => setTimeout(task, 0),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Opt-in bridge for one exact plain-text subtree. Preparation never publishes
 * runtime geometry: completion only invalidates its still-current mounted root.
 * Existing measurement/publication owns placement, revisions, and coherence. */
export class PreparedRuntimeGeometryBridge {
  private readonly cache: PreparedTextCache
  readonly paintEnabled: boolean
  readonly viewportFirst: boolean
  private readonly viewport?: () => PreparationViewport
  private readonly painters = new Map<
    PreparedOutputRenderable,
    { job: Job; release: () => void }
  >()
  private readonly pending = new Map<string, Job>()
  private readonly failures = new Map<string, true>()
  private frame?: TranscriptFrame
  private style?: GeometryStyleRevision
  private scope = ""
  private timer: unknown
  private scheduled = false
  private disposed = false
  private readonly counts = {
    hits: 0,
    queued: 0,
    prepared: 0,
    fallbacks: 0,
    stale: 0,
    failed: 0,
    preparedPaints: 0,
    nativePaintFallbacks: 0,
    preparedRowsPainted: 0,
    reprioritized: 0,
    displaced: 0,
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly scheduling: PreparedRuntimeGeometryScheduler = scheduler,
    options: { paint?: boolean; viewport?: () => PreparationViewport } = {},
  ) {
    this.paintEnabled = options.paint ?? false
    this.viewport = options.viewport
    this.viewportFirst = Boolean(options.viewport)
    this.cache = new PreparedTextCache({
      navigation: true,
      viewport: this.paintEnabled,
      maxQueued: 1,
    })
  }

  get diagnostics() {
    return {
      ...this.counts,
      pending: this.pending.size,
      cache: this.cache.stats,
      attachedPainters: this.painters.size,
    }
  }

  begin(frame: TranscriptFrame, styleRevision: GeometryStyleRevision) {
    this.style = styleRevision
    this.synchronize(frame)
  }

  /** May run from window synchronization before a new measurement pass. */
  synchronize(frame: TranscriptFrame) {
    if (this.disposed) return
    const scope = JSON.stringify([
      frame.threadId,
      frame.canonicalGeneration,
      frame.geometry.generation,
      this.style,
    ])
    if (scope !== this.scope) {
      this.cancelPending()
      this.releasePainters()
      this.cache.clear()
      this.failures.clear()
      this.scope = scope
    }
    this.frame = frame
    for (const [body, entry] of this.painters) {
      if (!this.current(entry.job)) {
        entry.release()
        this.painters.delete(body)
      }
    }
    for (const [key, job] of this.pending)
      if (!this.current(job)) {
        this.pending.delete(key)
        this.counts.stale++
      }
    if (!this.pending.size && this.scheduled) {
      this.scheduling.cancel(this.timer)
      this.scheduled = false
    }
  }

  private cancelPending() {
    if (this.scheduled) this.scheduling.cancel(this.timer)
    this.scheduled = false
    this.counts.stale += this.pending.size
    this.pending.clear()
  }

  dispose() {
    this.cancelPending()
    this.releasePainters()
    this.cache.clear()
    this.failures.clear()
    this.frame = undefined
    this.disposed = true
  }

  private releasePainters() {
    for (const entry of this.painters.values()) entry.release()
    this.painters.clear()
  }

  private attachPainter(job: Job) {
    if (!this.paintEnabled || !(job.body instanceof PreparedOutputRenderable))
      return
    const body = job.body
    const prior = this.painters.get(body)
    if (prior?.job.key === job.key && prior.job.input.block === job.input.block)
      return
    prior?.release()
    this.painters.delete(body)
    // Bound renderable/provider retention independently of the derived cache.
    if (this.painters.size >= 128) {
      const oldest = this.painters.entries().next().value!
      oldest[1].release()
      this.painters.delete(oldest[0])
    }
    const release = body.installPreparedPaint(
      () => {
        if (!this.current(job)) return undefined
        const viewport = this.cache.getViewport(job.request)
        return viewport?.rowCount === body.height ? viewport : undefined
      },
      (rows, prepared) => {
        if (prepared) {
          this.counts.preparedPaints++
          this.counts.preparedRowsPainted += rows
        } else this.counts.nativePaintFallbacks++
      },
    )
    this.painters.set(body, { job, release })
  }

  private current(job: Job): boolean {
    const { input, body, text } = job
    const frame = this.frame
    const key = blockKey(input.block)
    return Boolean(
      !this.disposed &&
      frame &&
      job.scope === this.scope &&
      frame.window.blocks.includes(input.block) &&
      "item" in input.block &&
      !frame.transcript.folded[input.block.key.itemId] &&
      !frame.window.activityPresentation[key] &&
      !input.renderable.isDestroyed &&
      !body.isDestroyed &&
      input.renderable.findDescendantById(body.id) === body &&
      body.plainText === text &&
      body.width === job.request.input.width &&
      body.wrapMode === "word" &&
      body.scrollX === 0 &&
      body.scrollY === 0 &&
      !body.truncate &&
      input.styleRevision === this.style,
    )
  }

  private fail(key: string) {
    this.failures.delete(key)
    this.failures.set(key, true)
    if (this.failures.size > 256)
      this.failures.delete(this.failures.keys().next().value!)
    this.counts.failed++
  }

  /** Read current native placement at admission/drain time, never queued position.
   * The viewport, not a cursor or focused surface, owns this priority. */
  private priority(job: Job, viewport: PreparationViewport): number {
    const top = job.body.screenY
    const bottom = top + job.body.height
    const center = viewport.screenY + viewport.height / 2
    return Math.max(top - center, center - bottom, 0)
  }

  private nextJob() {
    let next = this.pending.entries().next().value
    const viewport = this.viewport?.()
    if (!next || !viewport) return next
    const original = next
    let priority = this.priority(next[1], viewport)
    for (const entry of this.pending) {
      const candidate = this.priority(entry[1], viewport)
      if (candidate < priority) {
        next = entry
        priority = candidate
      }
    }
    if (next !== original) this.counts.reprioritized++
    return next
  }

  private admit(job: Job): boolean {
    if (this.pending.size < 16) return true
    const viewport = this.viewport?.()
    if (!viewport) return false
    // A full queue from the previous viewport must not exclude the new landing.
    // Evicted work retains its native fallback and may be requested again.
    let worst: [string, Job] | undefined
    let priority = this.priority(job, viewport)
    for (const entry of this.pending) {
      const candidate = this.priority(entry[1], viewport)
      if (candidate > priority) {
        worst = entry
        priority = candidate
      }
    }
    if (!worst) return false
    this.pending.delete(worst[0])
    this.counts.displaced++
    return true
  }

  private schedule() {
    if (this.scheduled || this.disposed || !this.pending.size) return
    this.scheduled = true
    this.timer = this.scheduling.schedule(() => {
      this.scheduled = false
      const first = this.nextJob()
      if (!first || this.disposed) return
      const [key, job] = first
      this.pending.delete(key)
      if (!this.current(job)) this.counts.stale++
      else {
        const admission = this.cache.replaceRequests([job.request])
        const result = this.cache.drain({ maxJobs: 1, maxMs: 4 })
        if (admission.refused || result.unsupported || result.unretained)
          this.fail(key)
        else if (this.current(job) && this.cache.getNavigation(job.request)) {
          this.counts.prepared++
          invalidateRenderedBlock(job.input.renderable)
          this.renderer.requestRender()
        } else this.counts.stale++
      }
      this.schedule()
    })
  }

  /** Read prepared points or queue a bounded future job. No native preparation
   * runs here; the caller may immediately take its unchanged native fallback. */
  readonly points = (
    input: MeasureRenderedBlockInput,
    text: string,
  ): Record<number, NativePoint> | undefined => {
    const block = input.block
    const fragment = "item" in block ? block.fragment : undefined
    if (
      this.disposed ||
      !this.frame ||
      this.style === undefined ||
      !("item" in block) ||
      block.renderItem.kind !== "command" ||
      block.renderItem.status !== "complete" ||
      input.folded ||
      (input.presentation ?? "item") !== "item" ||
      fragment?.kind !== "command-output" ||
      fragment.index !== fragment.count - 1 ||
      block.projection.plain !== block.projection.source ||
      !text.length ||
      text.length > 4096 ||
      text.includes("\t") ||
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text)
    ) {
      this.counts.fallbacks++
      return undefined
    }
    const suffix = block.key.blockId === "root" ? "" : `:${block.key.blockId}`
    const body = input.renderable.findDescendantById(
      `tool-output:${block.key.itemId}${suffix}`,
    )
    if (
      !(body instanceof TextRenderable) ||
      body.plainText !== text ||
      body.width < 1
    ) {
      this.counts.fallbacks++
      return undefined
    }
    const request: PreparedTextRequest = {
      identity: blockKey(block),
      contentRevision: String(block.contentRevision),
      layoutRevision: this.scope,
      input: {
        text,
        width: body.width,
        widthMethod: this.renderer.widthMethod,
        wrapMode: "word",
      },
    }
    const key = JSON.stringify([
      request.identity,
      request.contentRevision,
      this.scope,
      body.width,
      this.renderer.widthMethod,
    ])
    const job: Job = { key, scope: this.scope, input, text, body, request }
    if (!this.current(job)) {
      this.counts.fallbacks++
      return undefined
    }
    const navigation = this.cache.getNavigation(request)
    if (navigation) {
      if (navigation.rowCount !== body.height) {
        this.counts.fallbacks++
        return undefined
      }
      const points: Record<number, NativePoint> = {}
      for (let offset = 0; offset <= navigation.graphemeCount; offset++) {
        const point = navigation.pointAt(offset)
        if (point)
          points[offset] = {
            graphemeOffset: offset,
            x: body.x + point.column,
            y: body.y + point.row,
          }
      }
      this.counts.hits++
      // Attach only from the normal measurement turn, after compatibility and
      // native dimensions agree. Painting never publishes or rewrites source.
      this.attachPainter(job)
      return points
    }
    if (!this.failures.has(key) && !this.pending.has(key) && this.admit(job)) {
      this.pending.set(key, job)
      this.counts.queued++
      this.schedule()
    }
    this.counts.fallbacks++
    return undefined
  }
}
