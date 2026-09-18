/** Releases resources in reverse acquisition order, even when a disposer fails. */
export class Lifecycle {
  private disposers: Array<() => void | Promise<void>> = []
  private closing?: Promise<void>
  add(dispose: () => void | Promise<void>): void {
    if (this.closing) throw new Error("Cannot add resources during shutdown")
    this.disposers.push(dispose)
  }
  close(): Promise<void> {
    return this.closing ??= this.release()
  }
  private async release(): Promise<void> {
    const errors: unknown[] = []
    for (const dispose of this.disposers.reverse()) {
      try { await dispose() } catch (error) { errors.push(error) }
    }
    this.disposers = []
    if (errors.length) throw new AggregateError(errors, "Vimex shutdown failed")
  }
}

/** Keep the initiating failure primary while retaining every cleanup failure for diagnostics. */
export function failureAfterCleanup(primary: unknown, cleanup: unknown): unknown {
  if (primary === undefined) return cleanup
  if (cleanup === undefined) return primary
  const cleanupErrors = cleanup instanceof AggregateError ? cleanup.errors : [cleanup]
  return new AggregateError([primary, ...cleanupErrors], "Vimex failed and shutdown also failed", { cause: primary })
}
