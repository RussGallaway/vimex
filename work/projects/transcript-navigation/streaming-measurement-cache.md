# Streaming Markdown measurement experiment

Russ reports that navigation feels good in the retained neighborhood, but slows while navigating and acting near the newest growing answer. This experiment targets that situation without changing navigation, window replenishment, repeat handling, or token cadence.

## Finding and scope

The installed OpenTUI Markdown renderer already incrementally parses and reuses native blocks. Vimex still walks and measures those sub-blocks again when the enclosing running message changes. Running messages remain one transcript block. This makes unchanged paragraphs a useful, narrow reuse boundary, but does not eliminate whole-message work.

`VIMEX_NAV_MARKDOWN_MEASUREMENT_CACHE=1` enables an experimental cache in `native-layout/measure-rendered-block.ts`. It remains **off by default**. Each native Markdown owner has a disposable cache of local sub-block coordinates. Reuse requires identical projected text, descendant identities, relative positions, dimensions, native text, and copied line metadata values. Absolute translation reuses local coordinates; logical offsets are recalculated when assembling the message map. Tables, unsupported descendants, oversized blocks, and empty measurements use fresh measurement. Existing readiness and geometry publication checks remain authoritative.

Retention is bounded per Markdown owner: 512 entries, 65,536 points, and 262,144 snapshot units (string code units plus other snapshot slots). Individual entries retain at most 8,192 points. Removed or destroyed sub-blocks are pruned. These are per-owner limits, not a global byte budget. No timer, queue, or new anchor owner was added.

## Reproducible experiment

Run serially, with other native tests stopped:

```sh
VIMEX_NAV_MARKDOWN_MEASUREMENT_CACHE=0 bun scripts/benchmark-streaming-navigation.tsx
VIMEX_NAV_MARKDOWN_MEASUREMENT_CACHE=1 bun scripts/benchmark-streaming-navigation.tsx
```

The offline connected harness uses approximately 3,000 and 30,000 source characters, including Markdown links. It moves up from the tail, then performs 24 alternating Ctrl-Y/E cycles with either no growth or one appended token chunk per cycle. Retained-window, repeat-control, and prepared-paint flags are held constant. `VIMEX_STREAM_SIZES` and `VIMEX_STREAM_STEPS` override sizes and cycle count. Output includes stage timings, actual anchors, source size, and cache counters excluding setup.

**These are update/input/settlement/render cycle durations, not physical input-to-paint latency.** The harness explicitly settles updates and bypasses production ingress cadence. It does not reproduce independent sustained key input or prove a terminal UX improvement.

Local macOS arm64, Bun 1.3.6, November 6, 2026:

| Workload                              | Cache off median | Cache on median |
| ------------------------------------- | ---------------: | --------------: |
| 3k, static                            |         38.12 ms |        37.68 ms |
| 3k, streaming                         |         42.69 ms |        42.22 ms |
| 30k, static                           |         37.77 ms |        37.52 ms |
| 30k, streaming                        |        140.40 ms |       123.72 ms |
| 30k, streaming, reversed-order repeat |        138.05 ms |       124.62 ms |

The first paired 30k streaming run reduced aggregate measurement/publication time from 1,995.96 to 1,515.81 ms across 24 cycles, with 18,016 cache hits and 24 misses. The repeat measured 1,873.52 versus 1,554.30 ms, with 18,918 hits and 24 misses. Both modes still performed 168 preparation passes. An earlier temporary probe measured roughly 130–132 ms uncached versus 129 ms cached, so the observed end-to-end benefit varies and is not grounds for default promotion.

The cache successfully removes repeated native sub-block measurement. It does not make streaming cost independent of answer size. The large gap from the roughly 37 ms static control remains.

## Correctness and next decision

Focused tests cover translation reuse, same-size text changes, relative placement, width changes, child replacement, in-place line metadata changes, semantic source changes, eviction, metadata limits, and empty measurements. A connected cached/uncached parity test exercises growing content, Ctrl-U/Y/E/D, resize, source replacement, semantic/native selection, visible cells, and a fake clipboard yank; it requires actual cache hits. The existing native measurement suite also passes with the flag enabled, including a completed-link transformation with unchanged height.

Keep this as an opt-in experiment. The next useful investigation is to separate remaining whole-message projection, point-map assembly/gap filling, geometry comparison/publication, and repeated preparation costs on this same workload. Those are candidates, not yet individually measured causes. Prefer reducing repeated work within the existing ownership boundaries before adding scheduling or changing the successful retained-window UX. A subsequent candidate needs an independent-input terminal reproduction and Russ's local assessment before promotion.
