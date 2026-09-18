import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { ActivityIndicator } from "./ActivityIndicator"

test("active heartbeat changes without inventing server progress", async () => {
  const setup = await testRender(<ActivityIndicator active label="Thinking" />, { width: 40, height: 2 })
  try {
    await act(async () => setup.flush())
    const initial = setup.captureCharFrame()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); await setup.flush() })
    const next = setup.captureCharFrame()
    expect(next).toContain("Thinking")
    expect(next).not.toBe(initial)
    expect(next).not.toContain("elapsed")
    expect(next).not.toContain("%")
  } finally { await act(async () => setup.renderer.destroy()) }
})

test("static fallback retains a clear waiting label and observed elapsed time", async () => {
  const setup = await testRender(<ActivityIndicator active animate={false} label="Awaiting approval" tone="waiting" startedAt={Date.now() - 65_000} />, { width: 60, height: 2 })
  try {
    await act(async () => setup.flush())
    expect(setup.captureCharFrame()).toContain("⋯ Awaiting approval 1m 5s elapsed")
  } finally { await act(async () => setup.renderer.destroy()) }
})

test("inactive indicator remains static and does not present a running clock", async () => {
  const setup = await testRender(<ActivityIndicator active={false} label="Idle" startedAt={0} />, { width: 30, height: 2 })
  try {
    await act(async () => setup.flush())
    expect(setup.captureCharFrame()).toContain("· Idle")
    expect(setup.captureCharFrame()).not.toContain("elapsed")
  } finally { await act(async () => setup.renderer.destroy()) }
})


test("unmount clears the heartbeat interval", async () => {
  const intervals = spyOn(globalThis, "setInterval")
  const cleared = spyOn(globalThis, "clearInterval")
  let setup: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    setup = await testRender(<ActivityIndicator active label="Working" />, { width: 30, height: 2 })
    await act(async () => setup!.flush())
    const call = intervals.mock.calls.findIndex(args => args[1] === 120)
    expect(call).toBeGreaterThanOrEqual(0)
    const timer = intervals.mock.results[call]!.value
    await act(async () => setup!.renderer.destroy())
    setup = undefined
    expect(cleared.mock.calls.some(args => args[0] === timer)).toBe(true)
  } finally {
    if (setup) await act(async () => setup!.renderer.destroy())
    intervals.mockRestore()
    cleared.mockRestore()
  }
})
