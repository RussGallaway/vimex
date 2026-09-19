import type { ConversationEvent } from "@vimex/conversation"

export interface ConversationIngressScheduler {
  schedule(task: () => void, delayMs: number): () => void
}

export interface ConversationIngressOptions {
  scheduler?: ConversationIngressScheduler
  cadenceMs?: number
  onError?(error: unknown): void
}

export const systemConversationIngressScheduler: ConversationIngressScheduler = {
  schedule(task, delayMs) {
    const timer = setTimeout(task, delayMs)
    return () => clearTimeout(timer)
  },
}

/**
 * Settles adjacent token deltas on a bounded cadence while preserving every
 * semantic boundary in protocol order. It owns delivery cadence, not state.
 */
export class ConversationIngress {
  private pending: ConversationEvent[] = []
  private cancelScheduled?: () => void
  private closed = false

  constructor(
    /** The sink must apply the complete batch atomically or throw before commit. */
    private readonly emit: (events: readonly ConversationEvent[]) => void,
    private readonly options: ConversationIngressOptions = {},
  ) {}

  private get scheduler(): ConversationIngressScheduler { return this.options.scheduler ?? systemConversationIngressScheduler }
  private get cadenceMs(): number { return this.options.cadenceMs ?? 16 }

  get hasPending(): boolean { return this.pending.length > 0 }

  private schedule(): void {
    if (this.cancelScheduled || !this.pending.length || this.closed) return
    this.cancelScheduled = this.scheduler.schedule(() => {
      this.cancelScheduled = undefined
      try { this.flush() } catch (error) {
        // A permanent sink failure must not create a hot retry loop. New input
        // or an explicit lifecycle flush will retry the retained batch.
        const cancelRetry = this.cancelScheduled as (() => void) | undefined
        cancelRetry?.()
        this.cancelScheduled = undefined
        try { this.options.onError?.(error) } catch { /* error reporting is advisory */ }
      }
    }, this.cadenceMs)
  }

  push(event: ConversationEvent): void {
    if (this.closed) return
    if (event.type !== "item.delta") {
      this.pending.push(event)
      this.flush()
      return
    }
    const previous = this.pending.at(-1)
    if (previous?.type === "item.delta" && previous.threadId === event.threadId && previous.itemId === event.itemId) {
      this.pending[this.pending.length - 1] = { ...previous, delta: previous.delta + event.delta }
    } else {
      this.pending.push(event)
    }
    this.schedule()
  }

  flush(): void {
    this.cancelScheduled?.()
    this.cancelScheduled = undefined
    if (!this.pending.length) return
    const events = this.pending
    this.pending = []
    try {
      this.emit(events)
    } catch (error) {
      this.pending = [...events, ...this.pending]
      this.schedule()
      throw error
    }
  }

  /** Applies a finite authoritative replay immediately through the same sink. */
  replay(events: readonly ConversationEvent[]): void {
    if (this.closed || !events.length) return
    this.flush()
    this.pending.push(...events)
    this.flush()
  }

  close(): void {
    if (!this.closed) this.closed = true
    this.flush()
  }
}
