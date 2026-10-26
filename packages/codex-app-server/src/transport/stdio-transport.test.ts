import { expect, test } from "bun:test"
import { StdioTransport, type StdioProcess } from "./stdio-transport"

async function fixture() {
  let stdout!: (chunk: string | Uint8Array) => void
  let exit!: (code: number | null, signal: string | null) => void
  const process: StdioProcess = {
    write: async () => {},
    end() {},
    kill() {},
    onStdout(listener) {
      stdout = listener
    },
    onStderr() {},
    onError() {},
    onExit(listener) {
      exit = listener
    },
  }
  const transport = new StdioTransport({ processFactory: () => process })
  await transport.start()
  return { transport, stdout, exit }
}

const lines = (start: number, end: number) =>
  Array.from({ length: end - start }, (_, index) =>
    JSON.stringify(start + index),
  ).join("\n") + "\n"

test("large stdout bursts yield to queued input work and preserve order across new chunks", async () => {
  const { transport, stdout } = await fixture()
  const received: number[] = []
  const complete = Promise.withResolvers<void>()
  transport.onMessage((message) => {
    received.push(message as number)
    if (received.length === 201) complete.resolve()
  })
  const input = new Promise<number>((resolve) =>
    setImmediate(() => resolve(received.length)),
  )
  stdout(lines(0, 200))
  const firstBatch = received.length
  expect(firstBatch).toBeGreaterThan(0)
  expect(firstBatch).toBeLessThan(200)
  stdout("200\n")
  expect(received).toHaveLength(firstBatch)
  expect(await input).toBe(firstBatch)
  await complete.promise
  expect(received).toEqual(Array.from({ length: 201 }, (_, index) => index))
  await transport.close()
})

test("expensive message callbacks yield before exhausting the message count limit", async () => {
  const { transport, stdout } = await fixture()
  const received: unknown[] = []
  transport.onMessage((message) => {
    received.push(message)
    const until = performance.now() + 5
    while (performance.now() < until) {
      /* simulate one expensive projection */
    }
  })
  stdout(lines(0, 3))
  expect(received).toEqual([0])
  await transport.close()
  expect(received).toEqual([0, 1, 2])
})

test("process exit drains queued lines, reports malformed data, and delivers a UTF-8 tail before close", async () => {
  const { transport, stdout, exit } = await fixture()
  const received: unknown[] = []
  const errors: string[] = []
  const closed: Array<{ count: number; error?: string }> = []
  transport.onMessage((message) => received.push(message))
  transport.onError((error) => errors.push(error.message))
  transport.onClose((error) =>
    closed.push({ count: received.length, error: error?.message }),
  )
  stdout(lines(0, 100) + "not-json\n")
  const tail = new TextEncoder().encode(JSON.stringify("👨"))
  stdout(tail.subarray(0, 3))
  stdout(tail.subarray(3))
  exit(1, null)
  expect(received).toEqual([...Array.from({ length: 100 }, (_, i) => i), "👨"])
  expect(errors).toHaveLength(1)
  expect(errors[0]).toContain("Invalid JSONL")
  expect(closed).toEqual([
    { count: 101, error: "codex app-server exited with code 1" },
  ])
  stdout("999\n")
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(received).toHaveLength(101)
  await transport.close()
  expect(closed).toHaveLength(1)
})

test("close requested by a message listener drains the remaining prefix once", async () => {
  const { transport, stdout } = await fixture()
  const received: unknown[] = []
  let closing: Promise<void> | undefined
  let closes = 0
  transport.onMessage((message) => {
    received.push(message)
    if (message === 0) closing = transport.close()
  })
  transport.onClose(() => closes++)
  stdout(lines(0, 100) + "100")
  await closing
  expect(received).toEqual(Array.from({ length: 101 }, (_, i) => i))
  expect(closes).toBe(1)
})

test("a throwing close observer cannot strand a reentrant close promise", async () => {
  const { transport, stdout } = await fixture()
  let closing: Promise<void> | undefined
  transport.onMessage(() => {
    closing = transport.close()
  })
  transport.onClose(() => {
    throw new Error("observer failed")
  })
  expect(() => stdout("0\n")).toThrow("observer failed")
  await closing
})

test("throwing error observers cannot interrupt a reentrant shutdown drain", async () => {
  const { transport, stdout } = await fixture()
  const received: unknown[] = []
  const errors: string[] = []
  const closing: Promise<void>[] = []
  let closed = false
  transport.onMessage((message) => {
    received.push(message)
    if (message === 0) {
      closing.push(transport.close(), transport.close())
    }
  })
  transport.onError(() => {
    throw new Error("observer failed")
  })
  transport.onError((error) => errors.push(error.message))
  transport.onClose(() => {
    closed = true
  })
  stdout("0\nmalformed\n1\n2")
  await Promise.all(closing)
  expect(closed).toBe(true)
  expect(received).toEqual([0, 1, 2])
  expect(errors).toHaveLength(1)
})
