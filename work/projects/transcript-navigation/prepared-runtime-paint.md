# Opt-in prepared painting in the real transcript

Date: 2026-11-05 (local). Baseline: `73a60c8`; branch: `feat/transcript-prepared-navigation`.

## User-facing scope

`VIMEX_NAV_PREPARED_PAINT=1 bun run start` enables prepared visible-row painting in the real application and implies the prepared-geometry experiment. It remains off by default. The supported subset is still completed, unfolded, final output fragments of oversized command output. It does not change Markdown messages or every command, and it is not a release/default behavior change.

This pass connects the painter, not just its geometry. Connected OFF/ON tests require nonzero prepared-paint counts while scrolling; a test cannot pass solely by using native fallback. The expected appearance is unchanged: the same text, colors, cursor, and selection behavior. This establishes a usable experimental rendering path, not a demonstrated reduction in perceived lag.

## Atomic painting and fallback

[PreparedOutput](../../../packages/ui-opentui-react/src/transcript/PreparedOutput.tsx) subclasses native Text and overrides only painting. The original source buffer, native layout, hit grid, and selection API remain intact. A valid prepared binding draws already-wrapped rows intersecting the current scroll viewport and output buffer, with native foreground/background/attributes and clipping. It does not rewrite the native text to prewrapped strings or publish geometry from paint.

The [runtime bridge](../../../packages/ui-opentui-react/src/transcript/prepared-runtime-geometry.ts) installs a binding during the normal measurement turn only after prepared/native dimensions agree. Every paint validates its block/content/width/lifetime and looks up the current cache entry. Missing, evicted, changed, or incompatible preparation falls back to the original native painter immediately. Scope changes, disable, and disposal release bindings.

Active native selection—including keyboard Visual selection and mouse drag—uses native painting so original source addressing and copy semantics remain authoritative. Clearing selection resumes prepared painting when eligible. The initial painter certifies the native `unicode` width mode and transparent body backgrounds; other width modes, opaque body backgrounds, buffering, scroll offsets, truncation, and unsupported clipping use native painting. The surrounding command-output panel background is unchanged.

The paint flag adds viewport/source indexing to the existing cache job. Geometry, cursor compatibility, and source access share the same accounted cache budget. Bindings are independently capped at 128 and retain source/root references separately from cache arrays; cache accounting alone is not total retained heap. Native buffers/layout are deliberately still retained for fallback and selection. A cold miss can therefore incur native work followed by extra prepared work. Native preparation remains synchronous within its bounded job.

## Validation

- Twelve native production-wrapper tests require actual prepared painting and compare glyphs, foreground/background, attributes, wrapping, Unicode, blanks, clipped scrolling, and reversal. Selection forces native painting with unchanged copied text/highlight, then resumes prepared painting. Resize, source mutation, and disposal cannot draw stale rows.
- A connected application OFF/ON comparison exercises settled Ctrl-U/D, eight-key bursts in both directions, Visual selection, resize, yank into a fake clipboard port, and mouse drag-copy inside the eligible fragment. The paint flag is tested with the separate geometry flag off to establish implication. It never touches the host clipboard.
- Existing geometry/runtime tests remain applicable because native source and publication ownership are unchanged. The new flag is separately exercised through the existing scroll-continuity suite.

These are native/headless tests, not human/physical-terminal UX acceptance. Manual use of the opt-in source command above is possible; normal installed builds have not been changed by this work.

Validation passed: 13 new painter tests (12 native, 1 connected), all 39 scroll-continuity tests with `VIMEX_NAV_PREPARED_PAINT=1`, the paired cost probe with matching character frames, and the complete default `bun run check` gate. Independent review found no blockers. Local gate logs: `/tmp/vimex-prepared-paint-check.log` and `/tmp/vimex-prepared-paint-enabled-scroll.log`.

## Cost investigation

Reproduce with `bun scripts/benchmark-prepared-runtime-paint.tsx`. The [retained probe](evidence/2026-11-05-prepared-paint.json) includes raw samples, matching character-frame hashes, diagnostics, and source hashes. It mounts the production wrapper for a 50-source-row final command fragment and traverses 48 forward/reverse scroll positions at each width. A diagnostic wrapper measures actual body `renderSelf` invocations separately from test renderer/React `act` frame pacing.

| Width | Native median paint invocation | Prepared median paint invocation | Extra cold preparation |
| ----- | -----------------------------: | -------------------------------: | ---------------------: |
| 40    |                       0.010 ms |                         0.236 ms |                12.4 ms |
| 80    |                       0.012 ms |                         0.343 ms |                 5.8 ms |

This probe does **not** show a plain-command-output speedup. Native bulk text painting is already cheaper than this JavaScript row extraction/drawing path. Full redraw medians stayed around 17–18 ms and include renderer pacing; they are not input-to-paint measurements. The single native-first ordering is subject to JIT/allocator effects, so cold/native timing differences are not meaningful improvement estimates. Paint samples represent invocations, not one sample per key or frame. Geometry and source checks remain additional hot-path work.

## Next investigation

Keep the experiment off by default. The real prepared painter now provides a place to test decoupling without corrupting source semantics, but optimizing already-cheap command painting is unlikely to address the reported UX. Measure cold row preparation, source checking, runtime point materialization, and expensive Markdown/code reconciliation while holding/reversing navigation. Investigate avoiding duplicate native/prepared layout and producing compact data directly; extend rich-content painting only with the appropriate concealment/source/selection contracts. Promote a path only after it demonstrates the desired movement behavior in relevant long, cold transcripts.
