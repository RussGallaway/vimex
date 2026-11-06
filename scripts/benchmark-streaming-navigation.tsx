import assert from "node:assert/strict"
import { MarkdownRenderable, type Renderable } from "@opentui/core"
import { markdownMeasurementCacheStats } from "../packages/ui-opentui-react/src/transcript/native-layout/measure-rendered-block"
import { act } from "react"
import {
  answer,
  thread,
  wheelHarness,
} from "../packages/ui-opentui-react/src/transcript/navigation/scroll-continuity-harness"
import {
  subscribeNavigationTrace,
  type NavigationTraceRecord,
} from "../packages/ui-opentui-react/src/transcript/navigation/trace"

function cacheStats(root: Renderable) {
  const cache = { hits: 0, misses: 0, entries: 0, points: 0 }
  const pending: Renderable[] = [root]
  while (pending.length) {
    const node = pending.pop()!
    const stats =
      node instanceof MarkdownRenderable
        ? markdownMeasurementCacheStats(node)
        : undefined
    if (stats)
      for (const key of ["hits", "misses", "entries", "points"] as const)
        cache[key] += stats[key]
    pending.push(...node.getChildren())
  }
  return cache
}

// Offline connected diagnostic. Each cycle includes token settlement, input,
// native preparation, and explicit paint; it is NOT input-to-paint latency.
const sizes = (process.env.VIMEX_STREAM_SIZES ?? "3000,30000")
  .split(",")
  .map(Number)
const steps = Number(process.env.VIMEX_STREAM_STEPS ?? 24)
assert(
  sizes.every(
    (size) => Number.isSafeInteger(size) && size > 0 && size <= 200_000,
  ),
)
assert(Number.isSafeInteger(steps) && steps > 0 && steps <= 300)
process.env.VIMEX_NAV_RETAINED_WINDOW = "1"
process.env.VIMEX_NAV_REPEAT_CONTROL = "1"
process.env.VIMEX_NAV_PREPARED_PAINT = "1"
process.env.VIMEX_NAV_LANDING_DIAGNOSTICS = "1"
const results = []
for (const size of sizes)
  for (const streaming of [false, true]) {
    const h = await wheelHarness(0)
    let unsubscribe = () => {}
    try {
      const original = h.workspace().conversation.items[answer]!
      assert(original.kind === "assistant")
      const suffix =
        "\n\nReadable active answer with [a link](https://vimex.test) and more text."
      await act(async () => {
        h.emit({
          type: "conversation",
          event: {
            type: "item.delta",
            threadId: thread,
            itemId: answer,
            delta: suffix.repeat(
              Math.ceil(
                Math.max(0, size - original.markdown.length) / suffix.length,
              ),
            ),
          },
        })
        await h.controller.settle()
        await h.flush({ maxPasses: 500 })
        await h.renderOnce()
        h.controller.dispatchInteraction({ type: "mode.normal" })
        h.controller.dispatchInteraction({
          type: "focus.set",
          surface: "transcript",
        })
      })
      await h.keys("G")
      await act(async () => {
        h.mockInput.pressKey("u", { ctrl: true })
        await h.flush({ maxPasses: 500 })
        await h.renderOnce()
      })
      const cacheAtStart = cacheStats(h.renderer.root)
      const records: NavigationTraceRecord[] = []
      unsubscribe = subscribeNavigationTrace(h.renderer, (record) =>
        records.push(record),
      )
      const samples: number[] = []
      for (let index = 0; index < steps; index++) {
        const start = performance.now()
        await act(async () => {
          if (streaming)
            h.emit({
              type: "conversation",
              event: {
                type: "item.delta",
                threadId: thread,
                itemId: answer,
                delta: " next token",
              },
            })
          h.mockInput.pressKey(index % 2 ? "e" : "y", { ctrl: true })
          await h.controller.settle()
          await h.flush({ maxPasses: 500 })
          await h.renderOnce()
        })
        samples.push(performance.now() - start)
      }
      const sorted = [...samples].sort((a, b) => a - b)
      const percentile = (fraction: number) =>
        sorted[
          Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
        ]!
      const passes = records.filter(
        (record) => record.kind === "landing.prepare-pass",
      )
      const sum = (key: string) =>
        passes.reduce(
          (total, record) => total + (Number(record.details[key]) || 0),
          0,
        )
      const item = h.workspace().conversation.items[answer]!
      const cache = cacheStats(h.renderer.root)
      results.push({
        cache,
        cacheAtStart,
        cacheDuringCycles: {
          hits: cache.hits - cacheAtStart.hits,
          misses: cache.misses - cacheAtStart.misses,
        },
        requestedSourceChars: size,
        finalSourceChars:
          item.kind === "assistant" ? item.markdown.length : null,
        streaming,
        cycles: steps,
        cycleMs: {
          median: percentile(0.5),
          p95: percentile(0.95),
          max: sorted.at(-1),
          samples,
        },
        preparationPasses: passes.length,
        nativeLayoutMs: sum("nativeLayoutMs"),
        measureAndPublishMs: sum("measureAndPublishMs"),
        viewport: h.workspace().transcript.viewport,
        cursor: h.workspace().transcript.cursor,
      })
    } finally {
      unsubscribe()
      await h.close()
    }
  }
console.log(
  JSON.stringify(
    {
      benchmark: "connected-growing-markdown-navigation",
      qualification:
        "Offline headless connected harness. A cycle includes optional token settlement, one Ctrl-Y/E input, native preparation, and explicit render. Cycle duration is not input-to-paint latency; compare source size, actual anchors, and stage costs. No real threads or host clipboard.",
      markdownMeasurementCache:
        process.env.VIMEX_NAV_MARKDOWN_MEASUREMENT_CACHE === "1",
      machine: {
        platform: process.platform,
        arch: process.arch,
        bun: Bun.version,
      },
      results,
    },
    null,
    2,
  ),
)
