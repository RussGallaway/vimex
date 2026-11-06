import {
  prepareCompactTextLayout,
  type CompactPreparedTextLayout,
} from "./compact-prepared-text-layout"
import type { PrepareTextLayoutInput } from "./prepared-text-layout"
import {
  prepareTextNavigation,
  type PreparedTextNavigation,
} from "./prepared-text-navigation"
import {
  prepareTextViewport,
  type PreparedTextViewport,
} from "./prepared-text-viewport"

export interface PreparedTextRequest {
  /** Include presentation/thread identity; revisions must change with content. */
  readonly identity: string
  readonly contentRevision: string
  /** Changes for layout-affecting style, folds, or presentation variant. */
  readonly layoutRevision: string
  readonly input: PrepareTextLayoutInput
}

export interface PreparedTextCacheOptions {
  /** Prepare current-renderer cursor compatibility in the same bounded job.
   * Unsupported compatibility rejects the complete cache entry. */
  readonly navigation?: boolean
  /** Also retain visible-row source access; implies navigation compatibility.
   * Source strings and their indexes participate in the retained byte budget. */
  readonly viewport?: boolean
  readonly maxEntries?: number
  /** Typed-array payload + UTF-16 key/source bytes, not total JavaScript heap. */
  readonly maxBytes?: number
  readonly maxQueued?: number
  readonly maxQueuedCodeUnits?: number
  readonly maxBlockCodeUnits?: number
  readonly maxBlockGraphemes?: number
  readonly maxBlockRows?: number
}

/** Standalone derived-data cache. Lookup never prepares. A caller supplies a
 * destination-first preparation horizon and explicitly schedules each drain.
 * Replacing that horizon cancels work, never semantic navigation intent.
 * Native preparation is synchronous: the time budget is checked BETWEEN jobs.
 */
export class PreparedTextCache {
  private readonly limits: Required<
    Omit<PreparedTextCacheOptions, "navigation" | "viewport">
  >
  private readonly navigation: boolean
  private readonly viewport: boolean
  private readonly entries = new Map<
    string,
    {
      layout: CompactPreparedTextLayout
      navigation?: PreparedTextNavigation
      viewport?: PreparedTextViewport
      bytes: number
    }
  >()
  private queue: { key: string; input: PrepareTextLayoutInput }[] = []
  private bytes = 0
  private queuedCodeUnits = 0

  constructor(options: PreparedTextCacheOptions = {}) {
    this.viewport = options.viewport ?? false
    this.navigation = this.viewport || (options.navigation ?? false)
    this.limits = {
      maxEntries: options.maxEntries ?? 256,
      maxBytes: options.maxBytes ?? 4 * 1024 * 1024,
      maxQueued: options.maxQueued ?? 16,
      maxQueuedCodeUnits: options.maxQueuedCodeUnits ?? 32_768,
      maxBlockCodeUnits: options.maxBlockCodeUnits ?? 4096,
      maxBlockGraphemes: options.maxBlockGraphemes ?? 4096,
      maxBlockRows: options.maxBlockRows ?? 4096,
    }
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("Prepared text cache limits must be positive integers")
  }

  private normalize(request: PreparedTextRequest) {
    if (
      [request.identity, request.contentRevision, request.layoutRevision].some(
        (value) => value.length > 512,
      )
    )
      return undefined
    const input: PrepareTextLayoutInput = {
      ...request.input,
      limits: {
        maxCodeUnits: Math.min(
          request.input.limits?.maxCodeUnits ?? this.limits.maxBlockCodeUnits,
          this.limits.maxBlockCodeUnits,
        ),
        maxGraphemes: Math.min(
          request.input.limits?.maxGraphemes ?? this.limits.maxBlockGraphemes,
          this.limits.maxBlockGraphemes,
        ),
        maxRows: Math.min(
          request.input.limits?.maxRows ?? this.limits.maxBlockRows,
          this.limits.maxBlockRows,
        ),
      },
    }
    // Never retain canonical text in the key. Only viewport entries retain a
    // bounded source reference. The caller owns immutable content revision
    // identity; reusing a revision for changed text is invalid.
    const key = JSON.stringify([
      request.identity,
      request.contentRevision,
      request.layoutRevision,
      input.width,
      input.widthMethod,
      input.wrapMode,
      input.tabWidth ?? 2,
      input.firstLineOffset ?? 0,
      input.kind ?? "plain",
      input.conceal ?? false,
      input.limits,
    ])
    return { key, input }
  }

  private getEntry(request: PreparedTextRequest) {
    const normalized = this.normalize(request)
    if (!normalized) return undefined
    const entry = this.entries.get(normalized.key)
    if (!entry) return undefined
    this.entries.delete(normalized.key)
    this.entries.set(normalized.key, entry)
    return entry
  }

  get(request: PreparedTextRequest): CompactPreparedTextLayout | undefined {
    return this.getEntry(request)?.layout
  }

  /** Lookup only. Available when this cache was constructed with navigation:
   * true; coordinates and compact rows always share the same accepted entry. */
  getNavigation(
    request: PreparedTextRequest,
  ): PreparedTextNavigation | undefined {
    return this.getEntry(request)?.navigation
  }

  /** Lookup only; available with viewport:true, prepared and evicted together
   * with navigation and compact layout under one shared retention budget. */
  getViewport(request: PreparedTextRequest): PreparedTextViewport | undefined {
    return this.getEntry(request)?.viewport
  }

  /** Replace obsolete speculative work on reversal, resize, or revision change.
   * Supply a bounded neighborhood, not the entire transcript. Refused work must
   * use the existing renderer; no canonical data is removed by this cache. */
  replaceRequests(requests: readonly PreparedTextRequest[]) {
    this.queue = []
    this.queuedCodeUnits = 0
    let cached = 0,
      refused = 0,
      duplicate = 0
    const seen = new Set<string>()
    // Bound admission work as well as retention, even for an oversized horizon.
    refused = Math.max(0, requests.length - this.limits.maxQueued)
    for (
      let index = 0;
      index < Math.min(requests.length, this.limits.maxQueued);
      index++
    ) {
      const request = requests[index]!
      const normalized = this.normalize(request)
      if (!normalized) {
        refused++
        continue
      }
      if (seen.has(normalized.key)) {
        duplicate++
        continue
      }
      seen.add(normalized.key)
      if (this.get(request)) {
        cached++
        continue
      }
      const length = normalized.input.text.length
      if (
        length > this.limits.maxBlockCodeUnits ||
        this.queuedCodeUnits + length > this.limits.maxQueuedCodeUnits
      ) {
        refused++
        continue
      }
      this.queue.push(normalized)
      this.queuedCodeUnits += length
    }
    return { queued: this.queue.length, cached, refused, duplicate }
  }

  drain(options: { maxJobs: number; maxMs: number }) {
    if (
      !Number.isSafeInteger(options.maxJobs) ||
      options.maxJobs <= 0 ||
      !Number.isFinite(options.maxMs) ||
      options.maxMs < 0
    )
      throw new Error("Invalid preparation drain budget")
    const started = performance.now()
    let prepared = 0,
      unsupported = 0,
      unretained = 0,
      jobs = 0
    while (
      this.queue.length &&
      jobs < options.maxJobs &&
      performance.now() - started < options.maxMs
    ) {
      const job = this.queue.shift()!
      this.queuedCodeUnits -= job.input.text.length
      jobs++
      const result = prepareCompactTextLayout(job.input)
      if (result.status !== "ready") {
        unsupported++
        continue
      }
      let navigation: PreparedTextNavigation | undefined
      if (this.navigation) {
        const layout = result.layout
        const compatible = prepareTextNavigation(job.input.text, {
          width: layout.width,
          rowCount: layout.rowCount,
          graphemeCount: layout.graphemeCount,
          firstLineOffset: layout.firstLineOffset,
          // Pass the compact closure directly: do not capture job/source text.
          pointAt: layout.point,
        })
        if (compatible.status !== "ready") {
          unsupported++
          continue
        }
        navigation = compatible.navigation
      }
      let viewport: PreparedTextViewport | undefined
      if (this.viewport) {
        const painted = prepareTextViewport(job.input.text, result.layout)
        if (painted.status !== "ready") {
          unsupported++
          continue
        }
        viewport = painted.viewport
      }
      const bytes =
        result.layout.payloadBytes +
        (navigation?.boundaryPayloadBytes ?? 0) +
        (viewport
          ? viewport.sourceIndexBytes + viewport.sourceCodeUnits * 2
          : 0) +
        job.key.length * 2
      if (bytes > this.limits.maxBytes) {
        unretained++
        continue
      }
      while (
        this.entries.size >= this.limits.maxEntries ||
        this.bytes + bytes > this.limits.maxBytes
      ) {
        const oldest = this.entries.keys().next().value!
        this.bytes -= this.entries.get(oldest)!.bytes
        this.entries.delete(oldest)
      }
      this.entries.set(job.key, {
        layout: result.layout,
        navigation,
        viewport,
        bytes,
      })
      this.bytes += bytes
      prepared++
    }
    return {
      jobs,
      prepared,
      unsupported,
      unretained,
      remaining: this.queue.length,
    }
  }

  get stats() {
    return {
      entries: this.entries.size,
      accountedBytes: this.bytes,
      queued: this.queue.length,
      queuedCodeUnits: this.queuedCodeUnits,
    }
  }

  clear() {
    this.entries.clear()
    this.queue = []
    this.bytes = 0
    this.queuedCodeUnits = 0
  }
}
