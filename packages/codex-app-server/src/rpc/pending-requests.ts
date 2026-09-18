import type { RequestId } from "../generated/v0_154_0/RequestId"

export interface PendingRequest {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
}

/** Owns correlation, deadlines, and cleanup for outstanding JSON-RPC requests. */
export class PendingRequests {
  private readonly values = new Map<RequestId, PendingRequest>()
  constructor(private readonly timeoutMs = 30_000) {}

  create<T>(id: RequestId, method: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = { method, resolve: resolve as (value: unknown) => void, reject }
      if (this.timeoutMs > 0) pending.timer = setTimeout(() => {
        if (!this.values.delete(id)) return
        reject(new Error(`${method}: timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.values.set(id, pending)
    })
  }

  take(id: RequestId): PendingRequest | undefined {
    const pending = this.values.get(id)
    if (!pending) return undefined
    this.values.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    return pending
  }

  reject(id: RequestId, error: Error): void { this.take(id)?.reject(error) }
  rejectAll(error: Error): void { for (const id of [...this.values.keys()]) this.take(id)?.reject(error) }
}
