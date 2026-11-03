import { spawn, type ChildProcess } from "node:child_process"

export interface CaffeinateSnapshot {
  enabled: boolean
  supported: boolean
  active: boolean
  error?: string
}
/** One idle-sleep assertion, bounded by both the current turn and Vimex's PID. */
export function createCaffeinate(
  options: {
    enabled?: boolean
    platform?: string
    pid?: number
    spawn?: typeof spawn
    saveEnabled?(enabled: boolean): Promise<void>
  } = {},
) {
  let snapshot: CaffeinateSnapshot = {
    enabled: options.enabled ?? true,
    supported: (options.platform ?? process.platform) === "darwin",
    active: false,
  }
  let required = false
  let disposed = false
  let child: ChildProcess | undefined
  let failed = false
  let writes = Promise.resolve()
  const listeners = new Set<() => void>()
  const publish = (next: CaffeinateSnapshot) => {
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return
    snapshot = next
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        /* An observer cannot stop releasing an assertion. */
      }
    }
  }
  const stop = () => {
    const previous = child
    child = undefined
    previous?.kill()
    publish({ ...snapshot, active: false })
  }
  const reconcile = () => {
    if (disposed || !required || !snapshot.enabled || !snapshot.supported) {
      stop()
      return
    }
    if (child || failed) return
    let next: ChildProcess
    try {
      next = (options.spawn ?? spawn)(
        "/usr/bin/caffeinate",
        ["-i", "-w", String(options.pid ?? process.pid)],
        { stdio: "ignore" },
      )
      child = next
    } catch (error) {
      failed = true
      publish({ ...snapshot, active: false, error: String(error) })
      return
    }
    next.once("spawn", () => {
      if (child === next)
        publish({ ...snapshot, active: true, error: undefined })
    })
    next.once("error", (error) => {
      if (child !== next) return
      child = undefined
      failed = true
      publish({ ...snapshot, active: false, error: error.message })
    })
    next.once("exit", () => {
      if (child !== next) return
      child = undefined
      failed = true
      publish({
        ...snapshot,
        active: false,
        error: "Caffeinate exited before the local turn finished",
      })
    })
    next.unref()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setRequired(value: boolean) {
      if (disposed || value === required) return
      required = value
      if (!value) {
        failed = false
        publish({ ...snapshot, error: undefined })
      }
      reconcile()
    },
    setEnabled(value: boolean): Promise<void> {
      // A preference accepted before shutdown must still be saved, even if its
      // queued write begins after disposal. Disposal only prevents assertions.
      const accepted = !disposed
      const operation = writes
        .catch(() => {})
        .then(async () => {
          if (!accepted) return
          await options.saveEnabled?.(value)
          if (disposed) return
          failed = false
          publish({ ...snapshot, enabled: value, error: undefined })
          reconcile()
        })
      writes = operation
      return operation
    },
    dispose() {
      if (disposed) return
      disposed = true
      stop()
      listeners.clear()
    },
  }
}
