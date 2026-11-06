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

test("navigation preparation shares its job with compact rows and lookup remains cold", () => {
  const cache = new PreparedTextCache({ navigation: true })
  const item = request("a", "a\nb界")
  const later = request("later")
  cache.replaceRequests([item, later])
  expect(cache.get(item)).toBeUndefined()
  expect(cache.getNavigation(item)).toBeUndefined()
  expect(cache.drain({ maxJobs: 1, maxMs: 0 }).jobs).toBe(0)
  expect(cache.getNavigation(item)).toBeUndefined()
  expect(drain(cache, 1)).toEqual({
    jobs: 1,
    prepared: 1,
    unsupported: 0,
    unretained: 0,
    remaining: 1,
  })
  const layout = cache.get(item)!
  const navigation = cache.getNavigation(item)!
  expect(navigation.rowCount).toBe(layout.rowCount)
  // Existing newline/EOF cursor policy differs from native insertion ends.
  expect(layout.point(1)?.row).toBe(0)
  expect(navigation.pointAt(1)).toEqual({
    graphemeOffset: 1,
    row: 1,
    column: 0,
  })
  expect(layout.point(4)?.column).toBe(3)
  expect(navigation.pointAt(4)).toEqual({
    graphemeOffset: 4,
    row: 1,
    column: 2,
  })
  expect(cache.getNavigation(item)).toBe(navigation)
  expect(cache.get(later)).toBeUndefined()
  expect(cache.getNavigation(later)).toBeUndefined()
  expect(cache.getNavigation({ ...item, contentRevision: "2" })).toBeUndefined()
})

test("navigation boundary bytes participate in refusal and eviction accounting", () => {
  const item = request("a", "a\nb\nc")
  const layoutOnly = new PreparedTextCache()
  layoutOnly.replaceRequests([item])
  drain(layoutOnly)
  expect(layoutOnly.getNavigation(item)).toBeUndefined()
  const cache = new PreparedTextCache({ navigation: true })
  cache.replaceRequests([item])
  drain(cache)
  const boundaryBytes = cache.getNavigation(item)!.boundaryPayloadBytes
  expect(boundaryBytes).toBeGreaterThan(0)
  expect(cache.stats.accountedBytes).toBe(
    layoutOnly.stats.accountedBytes + boundaryBytes,
  )
  const limited = new PreparedTextCache({
    navigation: true,
    maxBytes: layoutOnly.stats.accountedBytes,
  })
  limited.replaceRequests([item])
  expect(drain(limited).unretained).toBe(1)
  expect(limited.stats.accountedBytes).toBe(0)
  expect(limited.get(item)).toBeUndefined()
  expect(limited.getNavigation(item)).toBeUndefined()
  const oneEntry = new PreparedTextCache({
    navigation: true,
    maxBytes: cache.stats.accountedBytes,
  })
  oneEntry.replaceRequests([item, { ...item, identity: "b" }])
  expect(drain(oneEntry).prepared).toBe(2)
  expect(oneEntry.stats.entries).toBe(1)
  expect(oneEntry.getNavigation(item)).toBeUndefined()
  expect(oneEntry.getNavigation({ ...item, identity: "b" })).toBeDefined()
  oneEntry.clear()
  expect(oneEntry.stats.accountedBytes).toBe(0)
  expect(oneEntry.getNavigation({ ...item, identity: "b" })).toBeUndefined()
})

test("unsupported navigation rejects the whole entry without consuming later jobs", () => {
  const tabbed = request("tabbed", "a\tb")
  const shifted = {
    ...request("shifted"),
    input: { ...request("shifted").input, firstLineOffset: 1 },
  }
  const ready = request("ready")
  const cache = new PreparedTextCache({ navigation: true })
  cache.replaceRequests([tabbed, shifted, ready])
  expect(drain(cache, 1)).toEqual({
    jobs: 1,
    prepared: 0,
    unsupported: 1,
    unretained: 0,
    remaining: 2,
  })
  expect(cache.get(tabbed)).toBeUndefined()
  expect(cache.getNavigation(tabbed)).toBeUndefined()
  expect(drain(cache, 1).unsupported).toBe(1)
  expect(cache.get(shifted)).toBeUndefined()
  expect(cache.getNavigation(shifted)).toBeUndefined()
  expect(drain(cache).prepared).toBe(1)
  expect(cache.getNavigation(ready)).toBeDefined()
  expect(cache.stats.queuedCodeUnits).toBe(0)
})

test("viewport mode prepares navigation and source indexing in the same job", () => {
  const cache = new PreparedTextCache({ viewport: true, navigation: false })
  const item = request("source", "ab界\ncd")
  cache.replaceRequests([item, request("later")])
  expect(cache.getViewport(item)).toBeUndefined()
  expect(cache.getNavigation(item)).toBeUndefined()
  expect(drain(cache, 1).remaining).toBe(1)
  const viewport = cache.getViewport(item)!
  expect(viewport.rows(0, 2)).toEqual([
    { row: 0, text: "ab界" },
    { row: 1, text: "cd" },
  ])
  expect(cache.getNavigation(item)).toBeDefined()
  expect(cache.getViewport(item)).toBe(viewport)
  expect(cache.getViewport(request("later"))).toBeUndefined()
  expect(cache.getViewport({ ...item, contentRevision: "2" })).toBeUndefined()
})

test("viewport retention accounts source and source indexes and evicts as one entry", () => {
  const item = request("a", "ab界\ncd")
  const navigationOnly = new PreparedTextCache({ navigation: true })
  navigationOnly.replaceRequests([item])
  drain(navigationOnly)
  expect(navigationOnly.getViewport(item)).toBeUndefined()
  const cache = new PreparedTextCache({ viewport: true })
  cache.replaceRequests([item])
  drain(cache)
  const viewport = cache.getViewport(item)!
  expect(cache.stats.accountedBytes).toBe(
    navigationOnly.stats.accountedBytes +
      viewport.sourceIndexBytes +
      item.input.text.length * 2,
  )
  const tooSmall = new PreparedTextCache({
    viewport: true,
    maxBytes: navigationOnly.stats.accountedBytes,
  })
  tooSmall.replaceRequests([item])
  expect(drain(tooSmall).unretained).toBe(1)
  expect(tooSmall.stats.entries).toBe(0)
  expect(tooSmall.get(item)).toBeUndefined()
  expect(tooSmall.getNavigation(item)).toBeUndefined()
  expect(tooSmall.getViewport(item)).toBeUndefined()
  const bounded = new PreparedTextCache({
    viewport: true,
    maxBytes: cache.stats.accountedBytes,
  })
  bounded.replaceRequests([item, { ...item, identity: "b" }])
  expect(drain(bounded).prepared).toBe(2)
  expect(bounded.get(item)).toBeUndefined()
  expect(bounded.getNavigation(item)).toBeUndefined()
  expect(bounded.getViewport(item)).toBeUndefined()
  expect(bounded.getViewport({ ...item, identity: "b" })).toBeDefined()
  bounded.clear()
  expect(bounded.stats.accountedBytes).toBe(0)
})

test("unsupported partial-cell painting refuses all prepared representations", () => {
  const item = {
    ...request("wide", "界"),
    input: {
      ...request("wide", "界").input,
      width: 1,
      wrapMode: "none" as const,
    },
  }
  const navigationOnly = new PreparedTextCache({ navigation: true })
  navigationOnly.replaceRequests([item])
  expect(drain(navigationOnly).prepared).toBe(1)
  const cache = new PreparedTextCache({ viewport: true })
  cache.replaceRequests([item])
  expect(drain(cache).unsupported).toBe(1)
  expect(cache.get(item)).toBeUndefined()
  expect(cache.getNavigation(item)).toBeUndefined()
  expect(cache.getViewport(item)).toBeUndefined()
  expect(cache.stats.accountedBytes).toBe(0)
})
