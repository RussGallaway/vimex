import { expect, test } from "bun:test"
import { openRestoredRuntime } from "./restored-runtime"

test("offline restore stays in its pane and retries the same target on input", async () => {
  let calls = 0
  let key!: (key: { name: string }) => void
  let removals = 0
  const messages: string[] = []
  const result = openRestoredRuntime(
    async () => {
      if (++calls === 1) throw new Error("offline")
      return "exact runtime"
    },
    {
      finished: new Promise(() => {}),
      render: (text) => messages.push(text),
      onKey(handler) {
        key = handler
        return () => {
          removals++
        }
      },
      quit() {},
    },
  )
  await Bun.sleep(1)
  key({ name: "r" })
  expect(await result).toBe("exact runtime")
  expect(messages[0]).toContain("offline")
  expect(calls).toBe(2)
  expect(removals).toBe(1)
})

test("quitting recovery cancels retries and removes listeners", async () => {
  let finish!: () => void
  let key!: (key: { name: string }) => void
  let calls = 0,
    removals = 0
  const result = openRestoredRuntime(
    async () => {
      calls++
      throw new Error("offline")
    },
    {
      finished: new Promise<void>((resolve) => {
        finish = resolve
      }),
      render() {},
      onKey(handler) {
        key = handler
        return () => {
          removals++
        }
      },
      quit() {
        finish()
      },
    },
    5,
  )
  await Bun.sleep(1)
  key({ name: "q" })
  expect(await result).toBeUndefined()
  await Bun.sleep(10)
  expect(calls).toBe(1)
  expect(removals).toBe(1)
})

test("recovery can be quit while the remote directory check is still pending", async () => {
  let finish!: () => void
  let key!: (key: { name: string }) => void
  let removed = false
  const result = openRestoredRuntime(() => new Promise(() => {}), {
    finished: new Promise<void>((resolve) => {
      finish = resolve
    }),
    render() {},
    onKey(handler) {
      key = handler
      return () => {
        removed = true
      }
    },
    quit: () => finish(),
  })
  key({ name: "q" })
  expect(await result).toBeUndefined()
  expect(removed).toBe(true)
})
