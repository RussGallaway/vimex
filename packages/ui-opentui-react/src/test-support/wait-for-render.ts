import { act } from "react"

interface RenderHarness {
  flush(): void | Promise<void>
  renderOnce(): void | Promise<void>
}

/** Poll asynchronous native rendering by outcome instead of runner speed. */
export async function waitForRender(
  harness: RenderHarness,
  ready: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  do {
    await act(async () => {
      await harness.flush()
      await harness.renderOnce()
    })
    if (ready()) return
    await act(async () => {
      await Bun.sleep(10)
    })
  } while (performance.now() < deadline)
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`)
}
