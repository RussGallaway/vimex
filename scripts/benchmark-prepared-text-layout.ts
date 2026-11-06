/** Standalone preparation cost probe; this is not input-to-paint UX evidence. */
import { prepareTextLayout } from "../packages/ui-opentui-react/src/transcript/prepared/prepared-text-layout"

const rounds = Number(process.env.VIMEX_PREPARED_TEXT_ROUNDS ?? 5)
if (!Number.isInteger(rounds) || rounds < 2 || rounds > 30)
  throw new Error("VIMEX_PREPARED_TEXT_ROUNDS must be an integer from 2 to 30")

const samples = [
  {
    name: "short-plain",
    kind: "plain" as const,
    text: "Read earlier messages, reverse direction, and stop on the intended row.\n".repeat(
      4,
    ),
  },
  {
    name: "code-100-lines",
    kind: "code" as const,
    text: Array.from(
      { length: 100 },
      (_, index) =>
        `const item_${index} = { state: "ready", count: ${index} };`,
    ).join("\n"),
  },
  {
    name: "unicode-and-tabs",
    kind: "plain" as const,
    text: "界面\tCafé 👩‍💻 🇺🇸\nA longer row with wide characters 界界 and ordinary words.\n".repeat(
      20,
    ),
  },
  {
    name: "long-code",
    kind: "code" as const,
    text: "const answer = value + 1;\n".repeat(500),
  },
  {
    name: "oversize-refusal",
    kind: "plain" as const,
    text: "x".repeat(1_000_000),
  },
]

const results = []
for (const sample of samples) {
  for (const width of [24, 80]) {
    const before = process.memoryUsage()
    const durations: number[] = []
    let result: ReturnType<typeof prepareTextLayout> | undefined
    for (let round = 0; round < rounds; round++) {
      const started = performance.now()
      result = prepareTextLayout({
        text: sample.text,
        kind: sample.kind,
        width,
        widthMethod: "unicode",
        wrapMode: "word",
        tabWidth: 4,
      })
      durations.push(Number((performance.now() - started).toFixed(3)))
    }
    const after = process.memoryUsage()
    results.push({
      name: sample.name,
      width,
      sourceUtf8Bytes: Buffer.byteLength(sample.text),
      status: result!.status,
      ...(result!.status === "ready"
        ? {
            rows: result!.layout.rowCount,
            graphemes: result!.layout.graphemeCount,
          }
        : { reason: result!.reason }),
      firstCallMs: durations[0],
      subsequentCallsMs: durations.slice(1),
      serializedResultBytes: Buffer.byteLength(JSON.stringify(result)),
      processMemoryDelta: {
        rss: after.rss - before.rss,
        heapUsed: after.heapUsed - before.heapUsed,
        external: after.external - before.external,
      },
    })
  }
}

console.log(
  JSON.stringify({
    benchmark: "standalone-prepared-text-layout-v1",
    status: "diagnostic",
    qualification:
      "Synchronous preparation and native cleanup after module import; no React tree, terminal, input dispatch, or rich-render comparison. Serialized result size is a portable output-size proxy, not retained heap. Process memory deltas include allocator retention and GC noise; they do not measure native lifetime or prove a leak. Width and source bounds are not a wall-clock guarantee.",
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    opentui: "0.5.11",
    rounds,
    widthMethod: "unicode",
    wrapMode: "word",
    results,
  }),
)
