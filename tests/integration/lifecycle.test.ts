import { expect, test } from "bun:test"
import { failureAfterCleanup, Lifecycle } from "../../apps/tui/src/lifecycle"

test("primary runtime failure remains first when shutdown also fails", () => {
  const primary = new Error("render crashed")
  const cleanup = new AggregateError(
    [new Error("server close failed"), new Error("terminal restore failed")],
    "shutdown",
  )
  const combined = failureAfterCleanup(primary, cleanup)
  expect(combined).toBeInstanceOf(AggregateError)
  expect((combined as AggregateError).cause).toBe(primary)
  expect((combined as AggregateError).errors).toEqual([
    primary,
    ...cleanup.errors,
  ])
})

test("lifecycle still releases every resource in reverse order", async () => {
  const lifecycle = new Lifecycle()
  const calls: string[] = []
  lifecycle.add(() => {
    calls.push("terminal")
  })
  lifecycle.add(() => {
    calls.push("backend")
    throw new Error("close failed")
  })
  lifecycle.add(() => {
    calls.push("root")
  })
  await expect(lifecycle.close()).rejects.toThrow("Vimex shutdown failed")
  expect(calls).toEqual(["root", "backend", "terminal"])
})
