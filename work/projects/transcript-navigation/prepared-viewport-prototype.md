# Prepared viewport with delayed rich detail

Date: 2026-11-05 (local). Baseline: `588582e`; branch: `feat/transcript-prepared-navigation`.

## Result and scope

An opt-in native viewport now paints prepared plain/code row fragments while real syntax highlighting arrives independently. The credential-free PTY fixture accepts held Ctrl-U/D, reverses, preserves ordered semantic movement across cold blocks, and stops at the expected source location without shifting when rich detail arrives. Production Vimex is unchanged.

This is a narrow architectural experiment, not acceptance of instant navigation in arbitrary transcripts. Cold geometry can still delay exact movement. The controller keeps the last complete viewport while preparing missing blocks; it never presents estimated geometry as exact. It has no Markdown, diff, streaming, resize, or production geometry-publication integration.

## Implementation

- [Prepared row fragments](../../../packages/ui-opentui-react/src/transcript/prepared-text-viewport.ts) index source graphemes once and derive only requested visible rows. Native Text renders these already-wrapped fragments without wrapping again. Tabs, nonzero first-line offsets, and partially clipped wide glyphs explicitly refuse this path.
- [Cache integration](../../../packages/ui-opentui-react/src/transcript/prepared-text-cache.ts) adds `navigation:true` and `viewport:true`. A viewport job prepares compact geometry, compatibility boundaries, and source indexing together. Accounting includes all numeric payloads, retained source UTF-16 units, and keys; it remains logical accounting, not measured heap. Lookup performs no preparation. Unsupported preparation rejects the whole entry.
- [Experiment controller](../../../packages/ui-opentui-react/src/transcript/prepared-viewport-experiment.ts) retains ordered row intents and commits cursor, anchor, and selection through existing transcript-domain operations. It uses no second canonical cursor. Each explicit preparation turn drains one job; input acceptance, motion resolution, and frame reading do not call native preparation. A candidate complete viewport must be available before movement is committed. Rows without a compatible legacy cursor address, including blank-only content, produce an explicit fallback state; the standalone fixture does not implement the production fallback renderer.
- [Native runner](../../../scripts/prepared-viewport-experiment.ts) paints cheap Text immediately, then constructs a real unconcealed Python CodeRenderable after a delay using pinned local grammar assets. Generation checks prevent stale detail from becoming visible. It verifies the same fixed viewport geometry through the transition. The harness's selection uses domain state/copy; it does not display a selection overlay.

The controller bounds accepted queued commands to 128, each at most 4,096 rows; overflow is explicitly refused, not silently dropped. It resolves at most 128 row steps per turn. Its cache retains at most 128 entries/8 MiB of accounted payload; per-block preparation limits remain 4,096 source units/graphemes/rows. There is no whole-history preparation or automatic unbounded idle drain. Canonical projections are still built eagerly at startup. All native jobs remain synchronous; time budgets apply between jobs.

## Validation

Native painter tests compare actual full/cropped Text and Code cells through forward/reverse traversal, wrapping, Unicode, width changes, and stale-tail clearing. One native cross-row selection test verifies identical painted glyphs/background; it does not certify arbitrary semantic selection overlays.

Controller tests cover cold-frame retention, ordered reversal at a document boundary, held travel, release, queue refusal, unsupported content, and canonical copy. An independent mounted Text/Code oracle uses production measurement and `movePoint` for ASCII/Unicode wrapping at widths 7/13/21, comparing semantic cursor, top row, cursor column, and copy.

Validation passed: 74 focused tests across cache integration (15), native painter (39), controller (8), and native movement oracle (12); all three opt-in PTY cases; and the complete `bun run check` gate. Full-check local log: `/tmp/vimex-prepared-viewport-check.log`. Independent review found no blockers. No production release or physical-terminal acceptance is claimed.

Reproduce the PTY experiment with `python3 scripts/benchmark-prepared-viewport-pty.py` (requires `pyte`). The runner can also be opened manually with `bun scripts/prepared-viewport-experiment.ts` in an 80×20 terminal. Ctrl-U/D move, `v` begins selection, `y` writes copy evidence to an optional trace file, and `q` exits. No live thread, network, or host clipboard is used.

The [retained evidence](evidence/2026-11-05-prepared-viewport.json) records the macOS arm64 run, source hashes, dispatch/acceptance timings, sampled status, final decoded cells, colors, and trace digests. Environment: Bun 1.3.6, OpenTUI 0.5.11, Unix PTY, `TERM=xterm-256color`, 80×20 cells, no multiplexer/SSH, Python pyte reconstruction. This is not an OS screenshot or physical-emulator/human UX acceptance.

The fixture has 256 completed blocks × 12 nonblank ASCII rows. It starts at row 1,440 with only the initial viewport prepared, sends 60 Ctrl-U then 40 Ctrl-D inputs at 33 ms intervals (9 rows/input), and expects final row 1,260. All 100 inputs were accepted/resolved, every recorded renderer completion stayed within its independently expected ordered source-row interval, the final 18 decoded rows/cursor matched, no sampled viewport was blank, and detail completion left final text/cursor unchanged. Domain copy returned the independently expected 7,381 characters without using the clipboard. Three final foreground colors confirmed visible syntax decoration.

| Diagnostic case  | Detail delay | Deliberate synchronous block | Settled after last dispatched key | Largest acceptance gap | Largest sampled pending queue |
| ---------------- | -----------: | ---------------------------: | --------------------------------: | ---------------------: | ----------------------------: |
| Delayed detail   |       400 ms |                            0 |                           17.8 ms |                33.7 ms |                             1 |
| Immediate detail |            0 |                            0 |                           18.1 ms |                34.1 ms |                             1 |
| Blocking control |            0 |                        80 ms |                          366.6 ms |                88.7 ms |                            45 |

These are single diagnostic runs, not latency distributions or a before/after comparison with production Vimex. Stop timing is Python dispatch-to-observed-settlement; acceptance gaps use the JavaScript clock. Those clocks have separate origins and cannot be subtracted for input-to-paint latency. Renderer metadata checks cover intermediate source order; decoded-cell checks cover startup/final/released frames, not every intermediate transport chunk. Preparation maxima were roughly 3–4 ms for these small blocks, not a hard frame-budget guarantee.

## What this means for UX and what comes next

Rich highlighting can finish later while this prepared viewport keeps navigating. The blocking control shows the remaining limitation directly: synchronous work on the shared event loop still delays acceptance and accumulates motion. Delaying promises alone cannot provide isolation.

Next investigate a production bridge that publishes prepared geometry coherently through the existing runtime, with correct fallback and stale-result cancellation through width/content/thread changes. Preserve current cursor/selection/anchor ownership and test actual selection overlay plus copy through that bridge. Separately measure cold single-block preparation and rich reconciliation under held travel to decide whether smaller jobs, direct compact production, or a separate execution path is needed. Avoid claiming that this fixed-width fixture solves cold arbitrary Markdown or huge blocks.
