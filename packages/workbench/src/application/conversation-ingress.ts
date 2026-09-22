import type { ConversationEvent } from "@vimex/conversation"

export interface ConversationIngressScheduler {
  schedule(task: () => void, delayMs: number): () => void
}

export interface ConversationIngressOptions {
  scheduler?: ConversationIngressScheduler
  cadenceMs?: number
  /** Maximum distinct delta streams reduced in one scheduled event-loop turn. */
  maxEventsPerTurn?: number
  onError?(error: unknown): void
}

export const systemConversationIngressScheduler: ConversationIngressScheduler =
  {
    schedule(task, delayMs) {
      const timer = setTimeout(task, delayMs)
      return () => clearTimeout(timer)
    },
  }

/**
 * Settles item-local token deltas on a bounded cadence while preserving every
 * semantic boundary in protocol order. It owns delivery cadence, not state.
 */
export class ConversationIngress {
  private pending = new Map<number, ConversationEvent>()
  private deltaSequences = new Map<string, number>()
  private nextSequence = 0
  /** A failed explicit flush is retried as one ordered prefix, never as capped token work. */
  private atomicRetryThrough?: number
  private cancelScheduled?: () => void
  private closed = false

  constructor(
    /** The sink must apply the complete batch atomically or throw before commit. */
    private readonly emit: (events: readonly ConversationEvent[]) => void,
    private readonly options: ConversationIngressOptions = {},
  ) {}

  private get scheduler(): ConversationIngressScheduler {
    return this.options.scheduler ?? systemConversationIngressScheduler
  }
  private get cadenceMs(): number {
    return this.options.cadenceMs ?? 16
  }
  private get maxEventsPerTurn(): number {
    const configured = this.options.maxEventsPerTurn ?? 64
    return Number.isFinite(configured)
      ? Math.max(1, Math.floor(configured))
      : 64
  }

  get hasPending(): boolean {
    return this.pending.size > 0
  }

  private deltaKey(
    event: Extract<ConversationEvent, { type: "item.delta" }>,
  ): string {
    return `${event.threadId.length}:${event.threadId}${event.itemId}`
  }

  private reindexDeltas(): void {
    this.deltaSequences.clear()
    for (const [sequence, event] of this.pending) {
      // A retained semantic boundary separates later input from the failed
      // atomic prefix; deltas may only coalesce within its suffix.
      if (event.type !== "item.delta") this.deltaSequences.clear()
      else this.deltaSequences.set(this.deltaKey(event), sequence)
    }
  }

  private enqueue(event: ConversationEvent): number {
    const sequence = this.nextSequence++
    this.pending.set(sequence, event)
    if (event.type === "item.delta")
      this.deltaSequences.set(this.deltaKey(event), sequence)
    else this.deltaSequences.clear()
    return sequence
  }

  private schedule(delayMs = this.cadenceMs): void {
    if (this.cancelScheduled || !this.pending.size || this.closed) return
    this.cancelScheduled = this.scheduler.schedule(() => {
      this.cancelScheduled = undefined
      const atomicCount =
        this.atomicRetryThrough === undefined
          ? undefined
          : this.atomicPrefixCount(this.atomicRetryThrough)
      try {
        this.drain(
          atomicCount ?? this.maxEventsPerTurn,
          atomicCount !== undefined,
        )
      } catch (error) {
        // A permanent sink failure must not create a hot retry loop. New input
        // or an explicit lifecycle flush will retry the retained batch.
        const cancelRetry = this.cancelScheduled as (() => void) | undefined
        cancelRetry?.()
        this.cancelScheduled = undefined
        try {
          this.options.onError?.(error)
        } catch {
          /* error reporting is advisory */
        }
      }
    }, delayMs)
  }

  private atomicPrefixCount(through: number): number | undefined {
    let count = 0
    for (const sequence of this.pending.keys()) {
      count++
      if (sequence === through) return count
    }
    this.atomicRetryThrough = undefined
    return undefined
  }

  private drain(limit: number, atomicOnFailure = false): void {
    if (!this.pending.size) return
    const selected: Array<readonly [number, ConversationEvent]> = []
    for (const entry of this.pending) {
      if (selected.length >= limit) break
      selected.push(entry)
    }
    if (!selected.length) return
    for (const [sequence, event] of selected) {
      this.pending.delete(sequence)
      if (
        event.type === "item.delta" &&
        this.deltaSequences.get(this.deltaKey(event)) === sequence
      )
        this.deltaSequences.delete(this.deltaKey(event))
    }
    const through = selected.at(-1)![0]
    const completesAtomicRetry =
      this.atomicRetryThrough !== undefined &&
      selected.some(([sequence]) => sequence === this.atomicRetryThrough)
    try {
      this.emit(selected.map(([, event]) => event))
    } catch (error) {
      this.pending = new Map([...selected, ...this.pending])
      this.reindexDeltas()
      if (atomicOnFailure) this.atomicRetryThrough = through
      this.schedule()
      throw error
    }
    if (completesAtomicRetry) this.atomicRetryThrough = undefined
    if (this.pending.size) this.schedule(0)
  }

  push(event: ConversationEvent): void {
    if (this.closed) return
    if (event.type !== "item.delta") {
      this.enqueue(event)
      this.flush()
      return
    }
    const key = this.deltaKey(event)
    const existingSequence = this.deltaSequences.get(key)
    const previous =
      existingSequence === undefined
        ? undefined
        : this.pending.get(existingSequence)
    if (previous?.type === "item.delta") {
      this.pending.set(existingSequence!, {
        ...previous,
        delta: previous.delta + event.delta,
      })
    } else {
      this.enqueue(event)
    }
    this.schedule()
  }

  flush(): void {
    this.cancelScheduled?.()
    this.cancelScheduled = undefined
    if (!this.pending.size) return
    this.drain(this.pending.size, true)
  }

  /** Applies a finite authoritative replay immediately through the same sink. */
  replay(events: readonly ConversationEvent[]): void {
    if (this.closed || !events.length) return
    this.flush()
    for (const event of events) this.enqueue(event)
    this.flush()
  }

  close(): void {
    if (!this.closed) this.closed = true
    this.flush()
  }
}
