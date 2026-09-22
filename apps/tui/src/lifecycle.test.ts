import { test, expect } from "bun:test"
import { FailureNotice, Lifecycle, shutdownApplication } from "./lifecycle"
test("terminal restoration still runs when other cleanup fails; close is idempotent", async () => {
  const lifecycle = new Lifecycle()
  const calls: string[] = []
  lifecycle.add(() => {
    calls.push("terminal restored")
  })
  lifecycle.add(() => {
    calls.push("server stopped")
    throw new Error("exit failure")
  })
  lifecycle.add(() => {
    calls.push("UI unmounted")
  })
  const closing = lifecycle.close()
  expect(lifecycle.close()).toBe(closing)
  await expect(closing).rejects.toThrow("Vimex shutdown failed")
  expect(calls).toEqual(["UI unmounted", "server stopped", "terminal restored"])
})

test("restores the terminal before slow resource cleanup and detaches handlers last", async () => {
  const calls: string[] = []
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let resourceCleanupStarted!: () => void
  const started = new Promise<void>((resolve) => {
    resourceCleanupStarted = resolve
  })
  const closing = shutdownApplication({
    unmount() {
      calls.push("unmount")
    },
    restoreTerminal() {
      calls.push("restore terminal")
    },
    async releaseResources() {
      calls.push("release resources")
      resourceCleanupStarted()
      await blocked
    },
    detachHandlers() {
      calls.push("detach handlers")
    },
  })
  await started
  expect(calls).toEqual(["unmount", "restore terminal", "release resources"])
  release()
  await closing
  expect(calls.at(-1)).toBe("detach handlers")
})

test("continues shutdown after failures and retains handlers until every step ran", async () => {
  const calls: string[] = []
  await expect(
    shutdownApplication({
      unmount() {
        calls.push("unmount")
        throw new Error("render")
      },
      restoreTerminal() {
        calls.push("restore")
      },
      releaseResources() {
        calls.push("release")
        throw new Error("port")
      },
      detachHandlers() {
        calls.push("detach")
      },
    }),
  ).rejects.toThrow("Vimex shutdown failed")
  expect(calls).toEqual(["unmount", "restore", "release", "detach"])
})

test("deduplicates persistence notices until a successful write rearms them", () => {
  const reporter = new FailureNotice()
  const messages: string[] = []
  reporter.fail(new Error("disk full"), (message) => messages.push(message))
  reporter.fail(new Error("disk full again"), (message) =>
    messages.push(message),
  )
  expect(messages).toEqual(["disk full"])
  reporter.clear()
  reporter.fail(new Error("read only"), (message) => messages.push(message))
  expect(messages).toEqual(["disk full", "read only"])
})
