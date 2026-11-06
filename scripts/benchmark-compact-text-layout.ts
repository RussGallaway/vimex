/** Standalone retention/lookup probe; not terminal or input-to-paint evidence. */
import { prepareTextLayout } from "../packages/ui-opentui-react/src/transcript/prepared-text-layout"
import {
  compactPreparedTextLayout,
  prepareCompactTextLayout,
} from "../packages/ui-opentui-react/src/transcript/compact-prepared-text-layout"
import {
  PreparedTextCache,
  type PreparedTextRequest,
} from "../packages/ui-opentui-react/src/transcript/prepared-text-cache"

const fixtures = [
  {
    name: "short-plain",
    text: "Read earlier messages, reverse direction, and stop on the intended row.\n".repeat(
      4,
    ),
  },
  { name: "long-code", text: "const answer = value + 1;\n".repeat(500) },
  {
    name: "unicode-tabs",
    text: "界面\tCafé 👩‍💻 🇺🇸\nA longer row with wide characters 界界 and ordinary words.\n".repeat(
      20,
    ),
  },
  { name: "irregular-widths", text: "a界b👩‍💻".repeat(1000) },
]
let checksum = 0
const results = []
for (const fixture of fixtures) {
  for (const width of [24, 80]) {
    const input = {
      text: fixture.text,
      width,
      widthMethod: "unicode" as const,
      wrapMode: "word" as const,
      tabWidth: 4,
    }
    const original = prepareTextLayout(input)
    if (original.status !== "ready") throw new Error(original.reason)
    const compact = compactPreparedTextLayout(original.layout)
    const preparationMs = []
    for (let round = 0; round < 5; round++) {
      const start = performance.now()
      const result = prepareCompactTextLayout(input)
      preparationMs.push(performance.now() - start)
      if (result.status !== "ready") throw new Error(result.reason)
      checksum += result.layout.rowCount
    }
    const lookups = 10_000
    const start = performance.now()
    for (let i = 0; i < lookups; i++)
      checksum += compact.point((i * 97) % (compact.graphemeCount + 1))!.column
    const lookupBatchMs = performance.now() - start
    results.push({
      name: fixture.name,
      width,
      rows: compact.rowCount,
      graphemes: compact.graphemeCount,
      runs: compact.runCount,
      compactTypedArrayBytes: compact.payloadBytes,
      verboseJsonBytes: Buffer.byteLength(JSON.stringify(original.layout)),
      preparationMs,
      lookupCount: lookups,
      lookupBatchMs,
    })
  }
}
const cache = new PreparedTextCache({
  maxEntries: 3,
  maxBytes: 64 * 1024,
  maxQueued: 4,
})
const requests: PreparedTextRequest[] = Array.from({ length: 8 }, (_, i) => ({
  identity: `fixture/block-${i}`,
  contentRevision: "1",
  layoutRevision: "plain-v1",
  input: {
    text: "source line for bounded preparation\n".repeat(40),
    width: 80,
    widthMethod: "unicode",
    wrapMode: "word",
  },
}))
const admission = cache.replaceRequests(requests.slice(0, 4))
const firstDrain = cache.drain({ maxJobs: 1, maxMs: 1000 })
const reversalAdmission = cache.replaceRequests([
  requests[7]!,
  requests[6]!,
  requests[0]!,
])
const reversalDrain = cache.drain({ maxJobs: 2, maxMs: 1000 })
const cacheStart = performance.now()
for (let i = 0; i < 10_000; i++) checksum += cache.get(requests[0]!)!.rowCount
const cacheLookupBatchMs = performance.now() - cacheStart
console.log(
  JSON.stringify({
    benchmark: "compact-prepared-text-v1",
    status: "diagnostic",
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    opentui: "0.5.11",
    qualification:
      "Standalone synchronous preparation after module import; no rich-render or input-to-paint comparison. Compact bytes count retained typed arrays only; verbose JSON is a different representation, neither measures heap. Preparation still constructs verbose output transiently. Lookup timings are aggregate loops, not UX latency distributions. Cache time limits apply between native jobs, never preempt a job.",
    results,
    cache: {
      admission,
      firstDrain,
      reversalAdmission,
      reversalDrain,
      stats: cache.stats,
      lookupCount: 10_000,
      lookupBatchMs: cacheLookupBatchMs,
    },
    checksum,
  }),
)
