interface RecoveryScreen {
  finished: Promise<void>
  render(message: string): void
  onKey(handler: (key: { name: string; ctrl?: boolean }) => void): () => void
  quit(): void
}

/** Keep an exact restore target recoverable while SSH or its checkout is unavailable. */
export async function openRestoredRuntime<T>(
  open: () => Promise<T>,
  screen: RecoveryScreen,
  retryMs = 30_000,
): Promise<T | undefined> {
  let stopped = false
  let retry: (() => void) | undefined
  const finished = screen.finished.then(() => {
    stopped = true
  })
  const remove = screen.onKey((key) => {
    if (key.name === "r") retry?.()
    else if (key.name === "q" || (key.ctrl && key.name === "c")) screen.quit()
  })
  try {
    while (!stopped) {
      try {
        const attempt = open()
        return await Promise.race([attempt, finished.then(() => undefined)])
      } catch (error) {
        if (stopped) return undefined
        screen.render(
          `Unable to reopen this conversation: ${String(error)}\n\nRetrying shortly. Press r to retry or q to leave Vimex.`,
        )
        const ready = new Promise<void>((resolve) => {
          retry = resolve
        })
        const timer = setTimeout(() => retry?.(), retryMs)
        try {
          await Promise.race([ready, finished])
        } finally {
          clearTimeout(timer)
          retry = undefined
        }
      }
    }
    return undefined
  } finally {
    remove()
  }
}
