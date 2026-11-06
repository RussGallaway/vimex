# Compact prepared rows and bounded preparation

Date: 2026-11-05 (local). Baseline: `3ae2f3f`; branch: `feat/transcript-prepared-navigation`.

## Result

This standalone follow-up makes prepared geometry cheaper to retain and reusable without invoking native preparation during lookup. It also adds an explicit compatibility adapter for the existing renderer's cursor-address policy. Nothing is connected to the production viewport yet; this is not evidence that held Ctrl-U/D has become faster.

- [Compact layout](../../../packages/ui-opentui-react/src/transcript/prepared/compact-prepared-text-layout.ts) stores rows and runs of sequential equal-width source points in private typed arrays. Row lookup is constant time; source-point lookup binary-searches runs. No canonical source text, verbose point array, or native resource is retained by this layout.
- [Preparation cache](../../../packages/ui-opentui-react/src/transcript/prepared/prepared-text-cache.ts) provides lookup without preparation, LRU retention, and an explicitly drained destination-first queue. Replacing the preparation horizon discards obsolete speculative jobs; it does not own or cancel navigation intent.
- [Navigation compatibility](../../../packages/ui-opentui-react/src/transcript/prepared/prepared-text-navigation.ts) adapts compact points to current renderer cursor addresses without materializing a permanent point-per-grapheme array. Only newline/EOF exceptions require additional retained numeric data.

## Boundary findings

Existing `measureRaw`/`cellsIn` behavior differs from native insertion geometry beyond newline and EOF: consumed wrapping whitespace and source cells outside a non-wrapping viewport can still receive clamped cursor addresses. Tabs can use different width policies. Replacing those addresses with native insertion coordinates would silently change behavior.

The compatibility adapter deliberately preserves current addresses, including the last-cell-start-plus-one EOF convention, blank-only unmapped content, empty-text origin, and wrapped/clipped whitespace. It refuses mismatched legacy/native grapheme widths and nonzero first-line offsets. Tabs therefore remain a fallback in the tested configuration. It supports one unconcealed Text/Code root with matching source, no internal padding or height clipping. Content/layout identity remains a caller contract. It is not a general Markdown mapping or a geometry publisher, and point equality does not certify selection overlay painting or copy behavior through a future viewport.

## Bounds and identity

Cache keys include presentation/block identity, immutable content revision, layout revision, width, width method, wrap mode, tab width, first-line offset, kind/concealment, and effective work limits. The caller must change revisions for changed content or layout-affecting style/folds; identity is trusted rather than rehashing source on each lookup. Cached geometry retains keys but not source. Keys have bounded identity-string lengths.

Defaults retain at most 256 entries and 4 MiB of accounted typed-array/key bytes, queue at most 16 requests and 32,768 UTF-16 source units, and prepare at most 4,096 code units/graphemes/rows per block. Admission only inspects the first bounded horizon. Caller-supplied limits cannot widen cache work caps. Cache accounting is not a total-heap measurement: object/Map overhead is bounded separately by entry count; queued source limits describe logical string length, not allocator residency. Unsupported or oversized content requires the existing correct renderer path.

Each explicit drain has a job limit and an elapsed-time limit checked **between** jobs. A native operation remains synchronous and uninterruptible. There is no automatic idle drain, worker, timer, or promise of a hard frame deadline. Clearing the cache releases queued sources and retained derived maps. Reversal/resize/thread changes can replace pending work; old completed entries are bounded and isolated by keys.

## Evidence and limits

The compact tests compare every point and row against the original preparation adapter across three width modes, three wrapping modes, seven fixtures, widths 3/7/21, and first-line offsets 0/2, for native-supported inputs. The navigation tests independently compare all source offsets, including newline/EOF and consumed whitespace, against mounted Text/Code measurement at widths 13/7/21. Mounted coverage uses the renderer's `unicode` width method. Cache tests exercise cold lookup, reversal, revision isolation, eviction, queue/source budgets, unsupported work, zero-time drains, input snapshots, and caller-limit enforcement.

Validation: 83 new tests pass (12 compact, 9 cache, 62 native navigation compatibility), followed by the full `bun run check` gate. Local full-check log: `/tmp/vimex-compact-preparation-check.log`. The focused groups contain 6,780, 52, and 748 assertions respectively. Independent implementation/documentation review found no blockers.

Reproduce the diagnostic with `bun scripts/benchmark-compact-text-layout.ts`. [Retained evidence](evidence/2026-11-05-compact-text.json) includes raw samples and source hashes. For the 13,000-grapheme code fixture, retained typed-array payload is 60,080 bytes at width 80 and 100,080 bytes at width 24. The previous verbose layout serializes to about 1.14–1.18 MB. These are different representation-size measurements, not an observed heap-reduction percentage. Alternating narrow/wide characters compress less: the 4,000-grapheme irregular fixture retains about 163–170 KB.

Compaction has not removed cold preparation cost. The current producer still constructs verbose data transiently, then compacts it. Large-code samples take roughly 8–12 ms synchronously; cache defaults intentionally refuse that block size. Source-point lookup batches of 10,000 complete in roughly 1–2 ms in this run, but this is a microbenchmark, not input-to-paint or held-navigation evidence. Navigation boundary preparation also performs a source walk and is not included in the cache's preparation timing or byte accounting; a future integrated cache must account for both.

## Next experiment

Follow-up: the [isolated prepared viewport](prepared-viewport-prototype.md) now integrates compatibility/source-index preparation into cache budgets and runs held/reversed movement through a PTY with delayed real highlighting. Production integration and broader UX acceptance remain pending.

Build a narrow plain/code viewport over these prepared rows and keep the existing semantic cursor/anchor owner. Include compatibility preparation in its work/retention budget. Deliberately delay rich rendering, then test held movement, immediate reversal, release, and cold destinations in a credential-free terminal fixture. Verify actual source selection/copy and native placement, not just point lookup. Unsupported content must retain the current correct path.

Before expanding to large blocks, investigate producing compact data directly and bounding work inside a block. The current per-job cap is a useful guard, not proof that preparation can never interrupt movement. Markdown, tables, diffs, folds, streaming reconciliation, coherent geometry publication, and actual-terminal UX acceptance remain open.
