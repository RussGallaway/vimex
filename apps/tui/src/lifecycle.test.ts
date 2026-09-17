import { test, expect } from "bun:test"
import { Lifecycle } from "./lifecycle"
test("terminal restoration still runs when other cleanup fails; close is idempotent", async () => {
  const lifecycle = new Lifecycle()
  const calls: string[] = []
  lifecycle.add(() => { calls.push("terminal restored") })
  lifecycle.add(() => { calls.push("server stopped"); throw new Error("exit failure") })
  lifecycle.add(() => { calls.push("UI unmounted") })
  const closing = lifecycle.close()
  expect(lifecycle.close()).toBe(closing)
  await expect(closing).rejects.toThrow("Vimex shutdown failed")
  expect(calls).toEqual(["UI unmounted", "server stopped", "terminal restored"])
})
