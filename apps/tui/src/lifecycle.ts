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
