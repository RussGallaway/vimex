# Opt-in prepared geometry in the production runtime

Date: 2026-11-05 (local). Baseline: `bb0a6e1`; branch: `feat/transcript-prepared-navigation`.

## Result and scope

The real transcript can now obtain source geometry from the prepared cache through its existing measurement/publication path. Enable the experiment with `VIMEX_NAV_PREPARED_GEOMETRY=1`; it is off by default. Explicit `RuntimeLayoutSource.preparedGeometry` injection supports deterministic native tests.

Eligibility is deliberately narrow: completed, unfolded, final `command-output` fragments with exact plain source/body agreement and supported wrapping. These are the final chunks of oversized command output, not every command or message. Running/folded content, nonfinal fragments, Markdown, tabs, transformed content, and incompatible native geometry keep the existing native measurement path.

Native painting remains unchanged. Command output already paints as plain text, so this checkpoint establishes production runtime integration and lifecycle safety, not a highlighting-speed improvement or the full prepared viewport in the application. The separate prepared viewport experiment remains the evidence for movement with delayed rich detail.

## Why geometry comes first

Prewrapped row strings omit consumed wrapping whitespace. Substituting them into the production Text renderer while retaining the ordinary source matcher would silently change cursor/selection mapping. Nonfinal command fragments also trim a trailing newline, requiring an explicit compatibility policy. We first integrate exact geometry while leaving the original source text and native selection intact.

The [bridge](../../../packages/ui-opentui-react/src/transcript/prepared/prepared-runtime-geometry.ts) queues bounded native preparation on later timer turns. A cold lookup immediately uses the existing measurement fallback. A ready hit supplies compatible source points to [block measurement](../../../packages/ui-opentui-react/src/transcript/native-layout/measure-rendered-block.ts); the existing code still owns source-span offsets, root-relative placement, line construction, monotonic native revisions, and immutable geometry.

[Rendered layout](../../../packages/ui-opentui-react/src/transcript/native-layout/rendered-layout.ts) remains the only publisher through the runtime's current measurement base. Preparation completion merely invalidates a still-current native root and requests a render. It never calls `reportMeasurements`, changes the semantic cursor/anchor, or publishes from a cursor/selection paint reader. Identical prepared/native geometry reuses the existing geometry object rather than manufacturing a new revision.

## Identity, lifecycle, and costs

Each scrollbox owns its bridge. Thread/canonical-generation/layout-generation/style changes cancel pending work and clear derived caches. Pending jobs are checked against the current mounted block, fold/activity presentation, native root/body identity, original text, width, wrapping, and clipping state. Content revisions and actual body width participate in cache identity. Departed or destroyed roots cannot receive completed work; unmount/disable cancels timers and releases the bridge.

The queue holds at most 16 jobs, each with at most 4,096 source code units; each timer prepares one job. The shared cache retains at most 256 entries and 4 MiB of accounted payload/key bytes. Failed keys have a bounded retry-suppression cache. Preparation remains synchronous within a job; the four-millisecond between-job budget is not preemption or a frame-time guarantee.

The runtime's current geometry interface still requires point records. Ready hits materialize those records from compact lookup before normal publication, so this does not yet remove all work from the navigation path. A cold miss can perform both ordinary native measurement and subsequent preparation. No latency improvement, memory-heap reduction, or whole-history isolation is claimed for this bridge.

## Validation

- The native production-wrapper matrix compares full points, lines, dimensions, and source offsets between native and prepared geometry for ASCII, Unicode, trailing blanks, and widths 24/40/80. Width/content changes and unsupported/folded cases exercise fallback. Native selection text and painted colors remain equal.
- Runtime publication tests verify that preparation completion and read-only layout access do not publish, warm measurement preserves geometry and screen placement, disable/unmount cancels work, and a layout-generation reset prevents a queued completion.
- A paired connected application test actually uses the bridge and compares OFF/ON Ctrl-U/D reversal, cursor/anchor, painted cells, Visual selection, resize, and yank through a test-owned clipboard port. It does not touch the host clipboard.
- Lifecycle tests cover scope changes, stale native content/root/window inputs, bounded scheduling, failure suppression, and disposal.

These are native/headless connected tests. No new physical-terminal or PTY performance claim is made here; the previous isolated viewport PTY evidence is a separate experiment.

Validation passed: all 25 focused bridge tests (9 lifecycle, 12 native parity, 3 publication, 1 connected), all 39 existing scroll-continuity tests with the flag enabled, and the complete default `bun run check` gate. Independent review found no blockers. [Validation record](evidence/2026-11-05-prepared-runtime.json) includes source/log hashes and scope qualifications. Local logs: `/tmp/vimex-prepared-runtime-check.log` and `/tmp/vimex-prepared-runtime-enabled-scroll.log`.

## Next step

Follow-up: [prepared runtime painting](prepared-runtime-paint.md) now connects visible-row drawing for this subset while preserving original native source/layout and selection fallback. It remains opt-in; the first cost probe shows no plain-text speedup.

Use the accepted prepared geometry to replace painting for the same supported subset, with an atomic switch that never mixes prepared row strings and native source matching. Verify native mouse selection/copy as well as keyboard selection, restore the native renderer on unsupported or changing content, and retain the existing coherent placement/publication protocol. Then extend nonfinal-fragment newline compatibility and investigate Markdown layout/concealment separately. Measure cold misses and warm revisits against the unchanged native path before claiming a user-visible speedup.
