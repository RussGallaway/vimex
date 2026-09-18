import { EventEmitter } from "node:events"
import { expect, test } from "bun:test"
import { createHerdrRunner, detectHerdr, type HerdrSpawn } from "./herdr-client"

test("detects only an explicitly managed pane and preserves the release-matched binary", () => {
  expect(detectHerdr({ HERDR_PANE_ID: "w1:p1" })).toBeUndefined()
  expect(detectHerdr({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: "/opt/herdr" }))
    .toEqual({ paneId: "w1:p1", binPath: "/opt/herdr" })
})

test("runner escalates a timed-out subprocess from SIGTERM to SIGKILL", async () => {
  class FakeChild extends EventEmitter {
    stderr = new EventEmitter()
    signals: NodeJS.Signals[] = []
    kill(signal: NodeJS.Signals = "SIGTERM") { this.signals.push(signal); return true }
  }
  const child = new FakeChild()
  let executable = ""
  const spawnProcess: HerdrSpawn = command => { executable = command; return child }
  const run = createHerdrRunner({ executable: "/opt/herdr", timeoutMs: 2, killGraceMs: 2, spawnProcess })
  await expect(run(["pane", "list"])).rejects.toThrow("timed out")
  expect(executable).toBe("/opt/herdr")
  expect(child.signals).toEqual(["SIGTERM", "SIGKILL"])
})

test("runner caps stderr and reports a nonzero exit", async () => {
  class FakeChild extends EventEmitter {
    stderr = new EventEmitter()
    kill() { return true }
  }
  const child = new FakeChild()
  const run = createHerdrRunner({ timeoutMs: 0, spawnProcess: (() => child) as HerdrSpawn })
  const result = run(["pane", "list"])
  child.stderr.emit("data", `discarded-${"x".repeat(5000)}-tail`)
  child.emit("exit", 2, null)
  await expect(result).rejects.toThrow(/tail$/)
})
