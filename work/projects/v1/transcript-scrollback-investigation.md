# Transcript scrollback investigation

Date: 2026-09-22. Status: implementation committed as `912f601`; positive hands-on feedback, with further latency profiling still open. The initial investigation below records the pre-implementation baseline; follow-up sections record the changes and validation.

## Product gate

Transcript scrollback and navigation are Vimex's primary feature. Further feature work pauses until the experience meets explicit visual, semantic, and latency criteria plus hands-on acceptance. Efficiency is a constraint, not evidence of a good reading experience. Keep windowing only if its implementation can satisfy that contract.

## Questions and competing explanations

1. Can window selection, measurement, anchor restoration, and paint agree before each visible frame?
2. Are inaccuracies primarily cold height estimates, invalidation of previously measured heights, post-paint corrections, or native layout cost?
3. Does a fully mounted reference eliminate the same failure under identical content and input? What does it cost at realistic sizes?
4. Can lightweight exact height and row information survive heavy native renderable eviction?
5. Which failures remain when there is no streaming, no syntax highlighting, or no activity grouping?

## Local source audit

- Installed OpenTUI 0.5.11 performs root rendering, postprocessing, and native rendering before emitting `CliRenderEvents.FRAME` (`node_modules/@opentui/core/chunk-bun-bwjmgnxw.js`, `loop`, around lines 10003–10052).
- `use-transcript-layout.ts` registers measurement and anchor restoration on that event. Corrections there affect a subsequent paint, not the paint that triggered the event.
- `rendered-layout.ts` reports new measurements to the runtime, then returns the supplied frame's old geometry. This protects frame ownership but creates an asynchronous handoff that must be measured for visual continuity.
- `use-transcript-layout.test.tsx` settles six native frames per operation in its anchor correction fixture. The Stage 5 implementation ledger permits up to eight native settlement passes. These establish eventual correctness and bounded work, not correctness of every intervening paint.

These facts identify a plausible failure mechanism. They do not alone establish which mechanism dominates the user's observed flicker.

## Capture contract

Capture painted cells and native state before the FRAME handlers mutate anchors; also record state after the handlers. Associate input sequence and direction, native scroll offset and extent, logical anchor, content/presentation/geometry revisions, mounted keys and spacer heights. Capture every native frame, including frames requested automatically during React flushes. Settled screenshots alone are insufficient.

Separate setup, input, and no-input settlement phases. Report transient blanks, movement after input stops, direction reversals, exact semantic targets, and latency. A scroll offset correction can compensate spacer changes without moving visible text: classify visible position separately from raw offsets.

## Acceptance work still required

- No transient blank content, duplicated/stale fragments, unexplained position changes, or oscillation in deterministic captures.
- Stable detached reading during streaming and delayed layout.
- Correct navigation, selection, search, folds, and copy across window boundaries.
- Identical behavior under slow input, bursts, held keys, and rapid reversals.
- Cold and warm targets, large expanded output, resize, and main/side presentations.
- Latency budgets measured on a named machine and terminal; renderer timing alone is not terminal input-to-pixel latency.
- Real-terminal captures and user acceptance, beyond the native test renderer.

## Decision gate

Review reproductions, source comparisons, and the devil's advocate assessment before production changes. Compare repairing the existing bridge, preparing a coherent window before paint, retaining lightweight layout metadata, and a dense reference. A renderer or architecture replacement needs measured evidence, not an assumption that virtualization is either mandatory or inherently flawed.

## Devil's advocate assessment

Windowing is a credible contributor to the reported failure. It must earn its complexity through both continuity and cost measurements.

| Candidate                                  | Benefit                                                                     | Burden of proof                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Repair current window/measurement handoff  | Preserves existing semantics and bounded native work                        | No incorrect intermediate paint; one owner of native scroll correction                                          |
| Fully mounted native transcript            | Removes spacer exposure and mount churn                                     | Acceptable latency, memory, and idle work at representative 100/1k/10k histories                                |
| Windowing with retained lightweight layout | Warm revisits retain exact row positions without retaining all native nodes | Correct invalidation across width, content, fold, and presentation changes; bounded cache; coherent cold misses |

Detailed geometry is window-local (`geometry.ts`, `composeGeometry`). The height index can remember total block height after row/point mappings are discarded; subsequent window geometry may use estimates again. Off-window logical targets can lose their block-local row. Investigate cold versus warm jumps and reversals separately.

Multiple native scroll writers also merit tracing: keyboard scroll, cursor-visibility enforcement, prepositioning, anchor restoration, and native sticky behavior. Their existence alone does not establish a conflict. In particular, keyboard and wheel paths differ in explicit sticky disabling, but native scrolling may already detach correctly.

Reject a repair that merely hides failures behind larger overscan or more settlement frames. Reconsider the architecture if clean paints require ever more correction states, or if a fully mounted control meets the actual workload budget with consistently better interaction. Conversely, a small dense fixture is not sufficient evidence to remove windowing.

## Reproduction baseline

Run:

```sh
bun scripts/transcript-scroll-repro.tsx /tmp/vimex-scroll-repro.json
```

Observed on Darwin arm64, Bun 1.3.6, installed OpenTUI 0.5.11, native test renderer at 80×24. Base commit: `2a9a00c1620f433aa76fc8b18a4713640cbe21e2`, plus the prior uncommitted scroll-anchor and fold-preserving navigation patches. This is not an actual terminal emulator run.

The script mounts the connected application, seeds 100 complete tools with deterministic output, and runs folded/expanded versions under windowed and fully mounted runtime policies. Dense mode is diagnostic-only setup injection; it disables runtime window-policy activation without changing production code. It records painted cells before FRAME listeners, state after listeners, semantic cursor/anchor, native extent/offset, geometry revision, planned block keys, and actual native root positions. JSON records include per-frame timing samples; they are not a statistically validated latency benchmark.

| Action                                              | Current windowed                                   | Fully mounted control                |
| --------------------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| Eight Ctrl-U presses in a burst, folded or expanded | 1 blank paint; 4 distinct viewport paints          | 0 blanks; 1 distinct paint           |
| 56 Ctrl-Y presses in a burst, folded or expanded    | 1 blank paint; 4 distinct viewport paints          | 0 blanks; 1 distinct paint           |
| Expanded previous-block navigation                  | 1 blank paint per tested jump; 3 distinct paints   | 0 blanks; 2 distinct paints          |
| Steady expanded Ctrl-U                              | Repeated visible correction after initial movement | 1 distinct paint per action          |
| Detached update to earlier assistant item           | 0 blanks; unchanged visible viewport               | 0 blanks; unchanged visible viewport |

For folded Ctrl-U, the first four paints show **blank → Command 52 → Command 53 → Command 59**, after the input burst has finished. Native offset progresses 61 → 61 → 63 → 75. The correction is visibly moving content, not merely compensating spacer coordinates. The final Command 59 anchor does not establish that the requested 56-row displacement is correct against the dense oracle; destination accuracy is a separate next-phase assertion.

The dense control isolates windowing as a contributor in this fixture: it removes scroll blanks and repeated adjustment paints. It does not eliminate all navigation delay; brace jumps still show the old screen then the target. The shared scroll/anchor bridge therefore remains relevant even if full mounting were adopted.

### Limits of the baseline

- Actions are sequential: Ctrl-U, Ctrl-D reversal, Ctrl-Y, Ctrl-E reversal, steady paging, a stream update, then brace navigation. Ctrl-Y is not a fresh-from-tail trial.
- Initial construction is settled before measured input; startup is outside this baseline.
- The stream update appends to the first running assistant item, not a live tail tool. It is evidence for that detached update only.
- This does not yet cover wheel input, resize, diffs, activity groups, selection/copy, true held-key timing, wide Unicode, side panes, or real terminal rendering.
- The dense fixture proves a continuity difference at 100 tools, not memory or latency viability at 1k/10k. Raw native offsets cannot be compared directly between policies because estimated document extents differ.
- Distinct paints are observations, not automatically defects. Blank paints and the no-input wrong-content sequence above are concrete defects; dense old-screen-to-target transitions need latency evaluation.
- Current artifacts are `/tmp/vimex-scroll-repro.json` and `/tmp/vimex-scroll-repro.log`; rerun the committed-source harness to regenerate them. No snapshot test blesses the broken output.

## Proposed next experiment for review

First establish an independent exact destination oracle: visually coherent movement to the wrong row must still fail. Then prototype a single preparation/scroll owner that brings destination mounting, exact visible layout, and anchor placement into agreement before paint. Compare it with both baselines using the same recorder. Retain the previous coherent viewport while preparing a cold destination rather than exposing spacers; measure the added latency and reject implementations that hide stutter by delaying input indefinitely.

Independently test retaining lightweight recent block row/point geometry, keyed by content, width, style, fold, and activity presentation. This may improve warm reversals but cannot substitute for coherent cold preparation. Grow the dense comparison to representative 1k/10k workloads before deciding whether to retain or replace windowing.

No production scroll architecture was modified during the initial research phase; the subsequent implementation is recorded below.

## Implementation follow-up: prepare before paint

The implementation retains windowing. A single UI preparation callback now mounts and measures destination content, reconciles native layout, restores the semantic anchor, and only then allows native paint. Keyboard rows are queued in ordered direction runs; boundary clamping happens before reversal. Absolute navigation supersedes earlier queued movement. `gg` reaches the first logical position and `G` reaches/follows the tail without unfolding tools. Scrolling away detaches again.

A bounded recent geometry cache retains up to 64 blocks and 32,768 point/line records, validated against content, width, style, fold, presentation, and indexed height. Detailed native roots remain windowed. Measurements never use the previous terminal image as a fallback for newly mounted content. The OpenTUI 0.5.11 adapter explicitly invalidates its per-frame layout guard so multiple preparation passes within one frame update descendants, including ScrollBox internal wrappers. This private integration point has focused tests and must be revisited on renderer upgrades.

The preparation loop bounds work and leaves further input queued after a settled placement near its pass budget. This is not a guarantee that an arbitrarily large input burst finishes in one frame.

### Observed results

The same 100-tool, 80×24 headless recorder now produces **zero blank paints and one distinct viewport paint per measured action**, for both folded and expanded windowed transcripts. Previously the Ctrl-U/Ctrl-Y bursts produced a blank paint and four distinct paints. Separate exact-destination tests compare every painted viewport against a fully mounted oracle, covering keyboard and wheel bursts, braces, counted/repeated navigation, `gg`/`G`, reversals at boundaries, supersession, tail streaming, and odd viewport heights (35 tests).

A single local timing sample from `/tmp/vimex-scroll-final.json`:

| Windowed fixture | Eight Ctrl-U presses, first paint | 56 Ctrl-Y presses, first paint | Steady Ctrl-U | Previous block |
| ---------------- | --------------------------------: | -----------------------------: | ------------: | -------------: |
| Folded           |                           91.6 ms |                        64.1 ms |       30.5 ms |        22.5 ms |
| Expanded         |                           28.1 ms |                        30.9 ms |       21.0 ms |        17.0 ms |

These are diagnostic samples, not p95 latency claims. In particular, folded cold bursts still take longer than the small dense control (28.9/22.7 ms for the two bursts). Eliminating intermediate incorrect paints is demonstrated; instant interaction across workloads and real-terminal perceptual acceptance are not. Next profiling should target repeated cold folded-neighborhood preparation and measure warm/cold latency distributions at larger histories. Preserve exact-destination and every-paint assertions while optimizing.

### Stabilization checkpoint

The full `bun run check` passed after aligning the initially-empty append fixture with production prepaint layout and replacing the native Markdown test's 250 ms polling race with its highlighting-completion signal: **876 passed, 5 skipped, 0 failed**, including four snapshots and the credential-free terminal suite. Formatting, TypeScript, dependency boundaries, generated documentation, and `git diff --check` passed. The activity-batch timeout did not recur in either the scaling→runtime rerun or the full check; its timeout was not increased. Real-terminal subjective navigation acceptance remains the next user checkpoint, not a conclusion of these tests.

### Committed navigation and hands-on follow-up

Commit `912f601` adds viewport-edge block navigation and cursor-aware keyboard scrolling to the prepaint foundation. `{` / `}` move within the visible transcript before scrolling. Half-page/full-page scrolling moves the transcript cursor with the viewport; line scrolling keeps the exact logical cursor while visible and clamps it when needed. Relative navigation resolves queued scrolling first, so Ctrl-U → `{` in one input batch starts from the new cursor. Composer-focused scrolling preserves the editing cursor and draft.

Final code validation: `bun run check` passed **882 tests, 5 skipped, 0 failed**, with four snapshots. Added regressions cover 20 forward/reverse block moves and five cursor/scroll scenarios, in addition to the 35 continuity cases. The stress-suite activity timeout later recurred; reclaiming discarded scaling fixtures between tests removed the deferred-cleanup penalty without increasing timeouts. The subsequent full checks passed.

The user reported the experience was substantially better in hands-on use, identified the block-placement and stale-cursor issues, then reported further improvement after both fixes. Terminal dimensions, emulator, and a complete scenario matrix were not recorded, so this remains qualitative acceptance evidence. The earlier timing samples are not measurements of the final commit. Continue profiling cold folded-tool bursts and testing realistic streaming histories before claiming flawless or universally instant navigation. Proactive history preparation and full mounting below a size threshold remain unimplemented ideas, pending evidence.

## Recent mounted tail experiment

The production window planner now keeps a contiguous recent area mounted while the visible viewport intersects it. Its default bounds are 100 render blocks and 240 **indexed** rows. The row bound can select fewer than 100 blocks, and a single tall block stays whole. As native measurements refine estimated heights, the selected area may contract. Older history still uses the existing bounded window and coherent prepaint preparation; returning to the tail restores the recent area. The policy lives in the transcript runtime and planner, so main and side transcripts use the same behavior without a separate UI cache.

This favors the common short reversal and nearby block navigation path, at the cost of more roots during initial setup and some tail returns. It is currently warmed synchronously with the connected view. A first-paint deferral was considered but is not part of this experiment; startup cost must be measured before treating the policy as settled. The connected benchmark exposes a zero-block override for comparisons and reports setup roots and materialized blocks. See [transcript-navigation-benchmark.md](transcript-navigation-benchmark.md) for the single-run observations and reproduction command.

Focused planner and runtime tests cover the stable recent area, row and block limits, estimated-height correction, older-history release, and viewport resizing. Integration tests continue to exercise cold off-window navigation by setting the recent block bound to zero in those fixtures. The user reported that the resulting navigation feels substantially better in ordinary use. That feedback establishes a useful direction; it does not resolve startup, far-history return, or real-terminal latency budgets.
