import { expect, test } from "bun:test"
import {
  PreparedTextCache,
  type PreparedTextRequest,
} from "./prepared-text-cache"

const request = (
  identity: string,
  text = "hello world",
): PreparedTextRequest => ({
  identity,
  contentRevision: "1",
  layoutRevision: "plain-v1",
  input: { text, width: 8, widthMethod: "unicode", wrapMode: "word" },
})
const drain = (cache: PreparedTextCache, maxJobs = 100) =>
  cache.drain({ maxJobs, maxMs: 10_000 })

test("lookup stays cold until explicit preparation and preserves warm layout identity", () => {
  const cache = new PreparedTextCache()
  const item = request("a")
  expect(cache.get(item)).toBeUndefined()
  expect(cache.replaceRequests([item])).toEqual({
    queued: 1,
    cached: 0,
    refused: 0,
    duplicate: 0,
  })
  expect(cache.get(item)).toBeUndefined()
  expect(drain(cache).prepared).toBe(1)
  const layout = cache.get(item)!
  expect(layout.point(0)?.column).toBe(0)
  expect(cache.get(item)).toBe(layout)
  expect(cache.replaceRequests([item]).cached).toBe(1)
  expect(drain(cache).jobs).toBe(0)
})

test("reversal replaces only pending preparation and retains useful completed data", () => {
  const cache = new PreparedTextCache()
  const forward = [request("a"), request("b"), request("c")]
  cache.replaceRequests(forward)
  expect(drain(cache, 1).remaining).toBe(2)
  cache.replaceRequests([request("behind"), forward[0]!])
  expect(drain(cache).prepared).toBe(1)
  expect(cache.get(forward[0]!)).toBeDefined()
  expect(cache.get(forward[1]!)).toBeUndefined()
  expect(cache.get(request("behind"))).toBeDefined()
  expect(cache.stats.queuedCodeUnits).toBe(0)
})

test("content, width, layout, tabs and presentation identity invalidate lookup", () => {
  const cache = new PreparedTextCache()
  const base = request("thread-a/block-a")
  cache.replaceRequests([base])
  drain(cache)
  const variants = [
    { ...base, identity: "thread-b/block-a" },
    { ...base, contentRevision: "2" },
    { ...base, layoutRevision: "folded" },
    { ...base, input: { ...base.input, width: 9 } },
    { ...base, input: { ...base.input, tabWidth: 4 } },
    { ...base, input: { ...base.input, wrapMode: "char" as const } },
    { ...base, input: { ...base.input, widthMethod: "wcwidth" as const } },
    { ...base, input: { ...base.input, firstLineOffset: 1 } },
    { ...base, input: { ...base.input, conceal: true } },
    { ...base, input: { ...base.input, kind: "code" as const } },
  ]
  for (const variant of variants) expect(cache.get(variant)).toBeUndefined()
  cache.replaceRequests([variants[1]!])
  drain(cache)
  expect(cache.get(base)).toBeDefined()
  expect(cache.get(variants[1]!)).toBeDefined()
})

test("entry eviction uses recency and clear releases queued source and derived data", () => {
  const cache = new PreparedTextCache({ maxEntries: 2 })
  const [a, b, c] = [request("a"), request("b"), request("c")]
  cache.replaceRequests([a!, b!])
  drain(cache)
  cache.get(a!)
  cache.replaceRequests([c!])
  drain(cache)
  expect(cache.get(a!)).toBeDefined()
  expect(cache.get(b!)).toBeUndefined()
  expect(cache.get(c!)).toBeDefined()
  cache.replaceRequests([request("pending")])
  cache.clear()
  expect(cache.stats).toEqual({
    entries: 0,
    accountedBytes: 0,
    queued: 0,
    queuedCodeUnits: 0,
  })
})

test("byte retention evicts old layouts and refuses individually excessive output", () => {
  const probe = new PreparedTextCache()
  probe.replaceRequests([request("a")])
  drain(probe)
  const oneEntryBytes = probe.stats.accountedBytes
  const cache = new PreparedTextCache({ maxBytes: oneEntryBytes })
  cache.replaceRequests([request("a"), request("b")])
  expect(drain(cache).prepared).toBe(2)
  expect(cache.stats.entries).toBe(1)
  expect(cache.stats.accountedBytes).toBe(oneEntryBytes)
  expect(cache.get(request("a"))).toBeUndefined()
  const tiny = new PreparedTextCache({ maxBytes: 1 })
  tiny.replaceRequests([request("a")])
  expect(drain(tiny).unretained).toBe(1)
  expect(tiny.stats.entries).toBe(0)
})

test("admission bounds horizon, per-block work and total queued source", () => {
  const cache = new PreparedTextCache({
    maxQueued: 4,
    maxQueuedCodeUnits: 10,
    maxBlockCodeUnits: 6,
  })
  const outcome = cache.replaceRequests([
    request("huge", "x".repeat(7)),
    request("a", "123456"),
    request("b", "12345"),
    request("c", "1234"),
    request("outside", "x"),
  ])
  expect(outcome).toEqual({ queued: 2, refused: 3, cached: 0, duplicate: 0 })
  expect(cache.stats.queuedCodeUnits).toBe(10)
  expect(drain(cache).prepared).toBe(2)
  expect(cache.stats.queuedCodeUnits).toBe(0)
  expect(cache.get(request("outside", "x"))).toBeUndefined()
})

test("zero time performs no work; count budget leaves work pending; unsupported consumes a job", () => {
  const cache = new PreparedTextCache({ maxBlockRows: 2 })
  cache.replaceRequests([request("rows", "a\nb\nc"), request("ok")])
  expect(cache.drain({ maxJobs: 1, maxMs: 0 }).jobs).toBe(0)
  expect(drain(cache, 1)).toEqual({
    jobs: 1,
    prepared: 0,
    unsupported: 1,
    unretained: 0,
    remaining: 1,
  })
  expect(drain(cache).prepared).toBe(1)
  expect(() => cache.drain({ maxJobs: 0, maxMs: 1 })).toThrow()
})

test("queue snapshots mutable inputs and deduplicates repeated requests", () => {
  const cache = new PreparedTextCache()
  const item = { ...request("a"), input: { ...request("a").input } }
  expect(cache.replaceRequests([item, item]).duplicate).toBe(1)
  item.input.width = 1
  drain(cache)
  expect(cache.get(item)).toBeUndefined()
  expect(cache.get(request("a"))?.width).toBe(8)
})

test("caller limits cannot widen cache caps and queued limits cannot be mutated", () => {
  const cache = new PreparedTextCache({ maxBlockGraphemes: 2 })
  const excessive = {
    ...request("a", "abc"),
    input: { ...request("a", "abc").input, limits: { maxGraphemes: 100 } },
  }
  cache.replaceRequests([excessive])
  expect(drain(cache).unsupported).toBe(1)
  expect(cache.stats.entries).toBe(0)
  const limits = { maxGraphemes: 1 }
  const limited = {
    ...request("b", "ab"),
    input: { ...request("b", "ab").input, limits },
  }
  cache.replaceRequests([limited])
  limits.maxGraphemes = 2
  expect(drain(cache).unsupported).toBe(1)
  cache.replaceRequests([limited])
  expect(drain(cache).prepared).toBe(1)
})
