import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { ChildProcess, spawn } from "node:child_process"
import { createCaffeinate } from "./caffeinate"

function fixture(platform = "darwin") {
  const children: Array<
    EventEmitter & { kills: number; kill(): boolean; unref(): void }
  > = []
  const calls: unknown[][] = []
  const saved: boolean[] = []
  const power = createCaffeinate({
    platform,
    pid: 123,
    saveEnabled: async (value) => {
      saved.push(value)
    },
    spawn: ((...args: unknown[]) => {
      calls.push(args)
      const child = Object.assign(new EventEmitter(), {
        kills: 0,
        kill() {
          this.kills++
          return true
        },
        unref() {},
      })
      children.push(child)
      return child as unknown as ChildProcess
    }) as typeof spawn,
  })
  return { power, children, calls, saved }
}
test("one idle-sleep assertion follows active turns, preferences, and parent lifetime", async () => {
  const h = fixture()
  h.power.setRequired(true)
  expect(h.calls[0]?.slice(0, 2)).toEqual([
    "/usr/bin/caffeinate",
    ["-i", "-w", "123"],
  ])
  expect(h.power.getSnapshot().active).toBe(false)
  h.children[0]!.emit("spawn")
  expect(h.power.getSnapshot().active).toBe(true)
  h.power.setRequired(true)
  expect(h.calls).toHaveLength(1)
  await h.power.setEnabled(false)
  expect(h.children[0]!.kills).toBe(1)
  expect(h.power.getSnapshot()).toMatchObject({ enabled: false, active: false })
  await h.power.setEnabled(true)
  h.children[1]!.emit("spawn")
  h.power.setRequired(false)
  expect(h.children[1]!.kills).toBe(1)
  expect(h.power.getSnapshot().active).toBe(false)
  h.power.setRequired(true)
  h.power.dispose()
  expect(h.children[2]!.kills).toBe(1)
  h.children[2]!.emit("spawn")
  expect(h.power.getSnapshot().active).toBe(false)
  expect(h.saved).toEqual([false, true])
})
test("unsupported systems and process failures never report a fake active assertion or spin retries", async () => {
  const unsupported = fixture("linux")
  unsupported.power.setRequired(true)
  expect(unsupported.calls).toHaveLength(0)
  expect(unsupported.power.getSnapshot()).toMatchObject({
    supported: false,
    active: false,
  })
  const h = fixture()
  h.power.setRequired(true)
  h.children[0]!.emit("error", new Error("spawn failed"))
  expect(h.power.getSnapshot()).toMatchObject({
    active: false,
    error: "spawn failed",
  })
  h.power.setRequired(true)
  expect(h.calls).toHaveLength(1)
  await h.power.setEnabled(true)
  h.children[1]!.emit("spawn")
  h.children[1]!.emit("exit", 1)
  expect(h.power.getSnapshot().active).toBe(false)
  expect(h.power.getSnapshot().error).toContain("exited")
  h.power.dispose()
})

test("shutdown preserves accepted preference writes without restarting an assertion", async () => {
  const h = fixture()
  h.power.setRequired(true)
  h.children[0]!.emit("spawn")
  const saving = h.power.setEnabled(false)
  h.power.dispose()
  await saving
  expect(h.saved).toEqual([false])
  expect(h.children[0]!.kills).toBe(1)
  expect(h.power.getSnapshot().active).toBe(false)
  await h.power.setEnabled(true)
  expect(h.saved).toEqual([false])
  expect(h.calls).toHaveLength(1)
})
