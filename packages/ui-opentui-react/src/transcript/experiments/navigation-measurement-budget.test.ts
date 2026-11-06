import { expect, test } from "bun:test"
import { NavigationMeasurementBudget } from "./navigation-measurement-budget"

test("background budget survives same-frame preparation and required geometry bypasses it", () => {
  let now = 10
  const budget = new NavigationMeasurementBudget(() => now)
  // Startup is deliberately unrestricted until a half-page motion arms it.
  for (let i = 0; i < 20; i++) expect(budget.allow(0, false)).toBe(true)
  budget.motion()
  for (let i = 0; i < 8; i++) {
    expect(budget.allow(1, false)).toBe(true)
    budget.record(false, 0.1)
  }
  expect(budget.allow(1, false)).toBe(false)
  // A window/geometry publication cannot replenish the frame budget.
  budget.motion()
  expect(budget.allow(1, false)).toBe(false)
  expect(budget.allow(1, true)).toBe(true)
  budget.record(true, 5)
  expect(budget.allow(2, false)).toBe(true)
  budget.record(false, 2)
  expect(budget.allow(2, false)).toBe(false)
  now += 121
  expect(budget.allow(2, false)).toBe(true)
  expect(budget.diagnostics.deferredAttempts).toBe(3)
})

test("disposal removes the active budget and idle wait completes", async () => {
  const budget = new NavigationMeasurementBudget()
  budget.motion()
  expect(budget.active).toBe(true)
  budget.dispose()
  await budget.whenIdle()
  expect(budget.active).toBe(false)
  expect(budget.allow(1, false)).toBe(true)
})
