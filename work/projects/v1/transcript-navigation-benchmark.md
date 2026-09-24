# Transcript navigation benchmark

Status: connected benchmark and first repair pass recorded on 2026-09-23. This is a measurement record, not a change to the transcript runtime contract.

## Question

How quickly and accurately can a reader traverse a long, heterogeneous transcript with repeated Vim motions, including cold scrollback and fold expansion?

The existing `runtime-scaling.test.ts` cases guard semantics and bounded operation counts. Their reported durations include fixture construction, full-materialization oracles, exhaustive assertions, and explicit garbage collection. They are test-suite durations, not input-to-paint latency. The existing connected-input benchmark times one `w` motion after setup. Neither establishes held-key behavior across mixed content.

## Fixture contract

Use deterministic, versioned synthetic content. The primary fixture interleaves messages, completed and running commands, ordinary and compactable tools, agent activity, Markdown, edits and diffs, visible unknown items, turn activity, and a streaming tail. It also includes canonical reasoning and diagnostic unknown events that production excludes from transcript navigation. Exercise both folded and expanded content, multi-file fragments, conservative unsplit roots, and width-sensitive native layouts. Report canonical-item, navigable transcript-item, and actual render-block counts; fixture construction is outside the navigation timing interval.

Isolated fixture variants retain the same navigation and measurement procedure for each major block type. They explain which content shape causes a mixed-case regression; the mixed fixture remains the product-level gate.

## Implemented measurement

`scripts/benchmark-transcript-navigation.tsx` runs the connected workbench, React UI, and OpenTUI test renderer with the production transcript runtime. Fixture construction and initial native settlement precede timing. Actions enter through simulated normal-mode keys, except setup moves to a fold landmark and the detached tail delta enters through the gateway. Each action records its input dispatch, first native paint, first changed paint, first destination paint, final settlement, every painted viewport, semantic cursor and anchor, mounted roots and descendants, runtime and presentation publications, React commits, and native layout passes/time. Cell capture occurs before `FRAME` listeners can correct layout.

At 160 requested canonical items or fewer, a full-mount control executes the same actions. The runner compares the final semantic cursor, logical anchor, and painted cells; `firstDenseMatchPaintMs` is the first recorded paint matching that control's final destination. All intervening paints are retained, with blank and non-destination counts. The full mount is a **diagnostic** control because native screen-row and nearest-edge placement may legitimately differ when the entire transcript is mounted. Its disagreements are reported but do not fail the run. `firstFinalPaintMs` matches the windowed run's _own_ final state and has no independent correctness guarantee. The runner also asserts measured geometry for visible blocks at setup. A blank frame or a `Ctrl-U`/`Ctrl-D` semantic direction reversal fails the run.

The settled paced workload requests 33 ms between dispatches but fully settles each action before sending the next. Its actual intervals are reported and may be longer. A queued paced workload sends six `Ctrl-U` keys at the requested cadence without waiting for settlement or explicitly rendering between them; it records actual key intervals and the number of keys dispatched at each paint. The eight-key burst dispatches synchronously in one React act. The separate `scripts/benchmark-transcript-navigation-pty.py` probe sends real key bytes to the credential-free offline demo and records raw ANSI output chunks. Neither runner measures physical display latency.

The runner does not yet separate candidate from accepted measurements, height corrections, or per-block-type layout cost. It reports one process run per configuration, so its percentiles describe only the few actions in that run, not a latency distribution across trials.

## Initial workload matrix

| Axis        | Cases                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content     | Dirty mixed transcript; isolated command, tool, agent, edit/diff, and Markdown variants                                                                       |
| Navigation  | Repeated `Ctrl-U`, `{`/`}`, reversal, revisit, fold/unfold, detached stream and return                                                                        |
| Temperature | Cold destination, warm revisit, post-expansion                                                                                                                |
| Width       | 80-column unified diff and at least 120-column split diff                                                                                                     |
| History     | 100, 1k, and 10k requested canonical items with navigable and actual render-block counts reported; an opt-in capacity probe exceeds 100k actual render blocks |

## Reproduction

```sh
VIMEX_NAV_ITEMS=100 VIMEX_NAV_REPEATS=3 bun scripts/benchmark-transcript-navigation.tsx
VIMEX_NAV_ITEMS=100 VIMEX_NAV_WIDTH=132 VIMEX_NAV_REPEATS=3 bun scripts/benchmark-transcript-navigation.tsx
VIMEX_NAV_ITEMS=1000 VIMEX_NAV_REPEATS=3 bun scripts/benchmark-transcript-navigation.tsx
VIMEX_NAV_ITEMS=10000 VIMEX_NAV_REPEATS=3 bun scripts/benchmark-transcript-navigation.tsx
VIMEX_NAV_SHAPE=command VIMEX_NAV_ITEMS=30 VIMEX_NAV_REPEATS=1 bun scripts/benchmark-transcript-navigation.tsx
VIMEX_NAV_SHAPE=edit VIMEX_NAV_ITEMS=100 VIMEX_NAV_WIDTH=132 VIMEX_NAV_REPEATS=1 bun scripts/benchmark-transcript-navigation.tsx
VIMEX_NAV_WORKLOAD=capacity VIMEX_NAV_RENDER_BLOCK_TARGET=100000 bun scripts/benchmark-transcript-navigation.tsx
VIMEX_NAV_ITEMS=10000 VIMEX_NAV_OVERSCAN_ROWS=240 bun scripts/benchmark-transcript-navigation.tsx
VIMEX_NAV_ITEMS=10000 VIMEX_NAV_OVERSCAN_ROWS=1000 bun scripts/benchmark-transcript-navigation.tsx
VIMEX_NAV_ITEMS=10000 VIMEX_NAV_REPEATS=2 VIMEX_NAV_RECENT_TAIL_BLOCKS=0 bun scripts/benchmark-transcript-navigation.tsx
VIMEX_NAV_ITEMS=10000 VIMEX_NAV_REPEATS=2 VIMEX_NAV_RECENT_TAIL_BLOCKS=100 bun scripts/benchmark-transcript-navigation.tsx
python3 scripts/benchmark-transcript-navigation-pty.py
```

The script emits one JSON record with the fixture hash, viewport, machine/runtime versions, actual repeat intervals, grouped timings, and per-action evidence. `VIMEX_NAV_SHAPE` also accepts `tool`, `agent`, and `markdown`. `VIMEX_NAV_OVERSCAN_ROWS` is a benchmark-only policy override, specified in **rows** and capped at 2,000; the capacity workload caps it at one viewport. `VIMEX_NAV_RECENT_TAIL_BLOCKS` overrides the production recent-block bound for a comparison, while retaining the production 240-indexed-row bound. This is not a proposal to mount that many blocks by default. The standard workload caps its fixture at 10k requested canonical items. The capacity workload constructs enough canonical items to exceed the requested actual render-block target, runs a smaller action set, and has no dense control.

## First connected baseline, before fixture correction

The following investigative runs used macOS arm64, 14 logical CPUs, Bun 1.3.6, OpenTUI 0.5.11, and the headless 24-row renderer. The first fixture incorrectly exposed canonical reasoning and diagnostic unknown items as navigable transcript blocks. The figures below document how the bugs were found; they are not directly comparable with current workload results. Each row is one process run. Times are milliseconds from dispatch to first paint matching the run's final state, **not** independently correct paint unless the dense control agrees.

| Shape / width | Semantic items | Render blocks | Status             | Cold first final paint | Eight-key burst first final paint | Blank paints |
| ------------- | -------------: | ------------: | ------------------ | ---------------------: | --------------------------------: | -----------: |
| Mixed / 80    |            100 |           128 | Dense disagreement |                   29.0 |                              85.3 |            0 |
| Mixed / 132   |            100 |           128 | Dense disagreement |                   28.2 |                              58.5 |            0 |
| Mixed / 80    |          1,000 |         1,266 | Diagnostic only    |                   28.2 |                             113.1 |            0 |
| Mixed / 80    |         10,000 |        12,685 | Diagnostic only    |                   60.4 |                             179.8 |            0 |

For the 10k run, the three paced `Ctrl-U` actions had a first-final-paint median of 38.9 ms and maximum of 90.9 ms. Actual dispatch intervals were 67.1 and 68.7 ms despite the 33 ms request. The mixed fixture hashes were `6e3d0ec6` at 100 items, `6ae5b4f0` at 1k, and `22bb5187` at 10k. These figures are baseline observations, not stable performance targets.

The 100-item mixed run at 80 columns first disagreed with the dense control on `paced-up-0`: cells matched, but cursor and anchor differed inside a multi-file diff. At 132 columns the first `cold-up` had the same kind of disagreement. A 30-item command run disagreed on `{`, and a 100-item edit run disagreed after the eight-key burst. Native geometry and v1 screen-row and nearest-edge rules showed that the full-mounted destination was wrong in these specific comparisons. New UI assertions cover the diff, edit, and command placements. Every listed run had zero blank paints; that alone does not establish destination correctness.

## Repairs and expanded probes

A real upward-scroll defect appeared in a 30-item dirty mixed fixture. A cold Markdown fragment occupied 36 native rows while its height index still estimated one. After six paced `Ctrl-U` motions, an eight-key upward burst moved the cursor **forward** from `mixed-17` to `mixed-25`. The UI now corrects an underestimated visible root before resolving its anchor. The regression moves upward to `mixed-07` and checks a nonblank cursor row.

The baseline 10k-item fold of a fragmented completed block rebuilt the full plan and took about 194–222 ms to dispatch. Persistent item-span splicing and a height-index overlay reduced sampled fold/expand/fold dispatch to about 33–41 ms, with first-final paints about 58–65 ms. Focused reference comparisons cover command, Markdown, and multi-file edit fragments. These are one-run local measurements.

The initial queued six-key workload at 100 items dispatched at actual intervals of about 30–36 ms and produced 16 native paints during input, with no blank frames. The offline PTY probe dispatched at about 29–37 ms intervals and observed an output chunk after each key; the first chunk began about 8 ms after the first key. Raw ANSI I/O establishes processing during input, not subjective smoothness or physical display latency.

The corrected fixture and navigation path, with 10,000 canonical items, 8,750 navigable items, and 11,435 render blocks, produced these single-run headless 24-row results:

| Overscan |  Startup | Startup RSS | Cold first final paint | Eight-key burst | Queued six-key final paint | Mounted roots near actions |
| -------: | -------: | ----------: | ---------------------: | --------------: | -------------------------: | -------------------------: |
|  Default |   707 ms |     644 MiB |                  46 ms |           94 ms |                     175 ms |                        2–9 |
| 240 rows |   802 ms |     658 MiB |                 115 ms |          288 ms |                     202 ms |                      21–95 |
|  1k rows | 1,626 ms |   1,043 MiB |                  54 ms |          911 ms |                     391 ms |                    357–437 |

The initial 240-row run exposed a reproducible upward direction reversal. A visible Markdown fragment had native height but its children had not yet acquired semantic point rows; the indexed fallback jumped forward. The UI now remeasures visible roots with empty point maps, listens for Markdown child resize, and retains each queued half-page key's cursor-follow boundary. The corrected 240-row burst matches paced keys and has no blank frame or direction reversal. Larger overscan increased startup time, memory, mounted roots, and burst latency. It does not justify an always-mounted 1,000-block tail.

The corrected opt-in capacity fixture built 100,000 canonical items, 87,500 navigable items, and 114,311 render blocks. Fixture construction took about 6.7 seconds and connected startup 6.0 seconds in one run. RSS reached roughly 3.8 GiB after fixture construction and 4.5 GiB after the connected harness. These numbers include fixture and allocator memory; they do not isolate retained canonical content. The original, pre-correction 100k probe found a 1.35-second complete-plan rebuild on the first `viewport.tail`. A guarded presentation-only reattach removes that rebuild when canonical content has not changed, while hidden output still takes the reconciliation path.

The corrected 100k workload then revealed another main-thread stall: each Workbench cursor/anchor publication serialized the full saved local state, including the fold map. Profiling measured about 50–79 ms per publication. Saved-state comparison is now structural and value-aware; disk persistence remains debounced in the app. A final post-repair, single-run headless sample painted a cold `Ctrl-U` destination in 33 ms, a six-key queued final destination in 213 ms, and a `G` return in 23 ms, with 7–15 mounted roots and no blank frame or direction reversal. Actual queued key intervals were 46, 24, 28, 42, and 30 ms against a requested 33 ms. RSS was about 4.5 GiB after the workload and garbage collection. The sample has no independent 100k destination oracle.

The fold height-index overlay has a defensive limit of 128 non-inverse structural splices. A 129th distinct fold can synchronously rebuild the complete 100k-block plan and cause a visible stall. The code review moved that limit into the shared splice path so tail appends and revisions cannot bypass it. A durable logarithmic solution needs a persistent structural height tree and ordinal/key lookup; the current improvement covers ordinary fold toggles and bounded sequences, not unlimited distinct expansion at 100k.

Follow with repeated trials across dirty mixed and isolated shapes, wide split diffs, larger Markdown fragments, many-distinct-fold transitions, and cold-to-warm revisits. Add connected evidence for zero-movement cold edges and a visible empty Markdown root above a later anchored point. Keep semantic direction, paced-versus-burst cursor equivalence, and native-placement assertions as correctness gates. Directional premeasurement and speculative fold preparation should be evaluated against correct destinations and a bounded preparation budget.

The native test renderer establishes local paint and timing evidence. Real-terminal input-to-pixel and subjective acceptance remain separate evidence.

## Recent mounted tail comparison

The connected harness now seeds its runtime from the same presentation used by the UI, so setup folds and actual connected render blocks agree before timed input. It records mounted roots and materialized blocks after setup. The default runtime retains up to 100 recent render blocks, further limited by 240 indexed rows; zero disables that recent area in the benchmark. These are one-run headless measurements on the same local machine, with two paced repeats. Milliseconds below are rounded. The 10k fixture has 10,000 canonical items, 8,750 navigable items, and 11,435 fixture render blocks; the connected UI can fold an oversized item and report a slightly different render-block count.

| Fixture   | Recent blocks | Connected startup | RSS after harness | Cold first final paint | Paced-up median | Eight-key burst | `G` return |
| --------- | ------------: | ----------------: | ----------------: | ---------------------: | --------------: | --------------: | ---------: |
| 1k mixed  |             0 |            220 ms |           307 MiB |                  34 ms |           28 ms |          122 ms |      33 ms |
| 1k mixed  |           100 |            386 ms |           346 MiB |                  36 ms |           30 ms |           73 ms |     155 ms |
| 10k mixed |             0 |            884 ms |           690 MiB |                  20 ms |           50 ms |          110 ms |      40 ms |
| 10k mixed |           100 |          1,048 ms |           714 MiB |                  16 ms |           30 ms |          111 ms |     260 ms |

The recent area improved the sampled 10k paced-up median and 1k burst, while increasing setup cost and far-history `G` return time. The 10k burst was similar. Each row is one process run, so this table does not establish p95 latency or causality for every difference. `firstFinalPaintMs` matches the run's own final state, without an independent 1k/10k destination oracle. Repeat on a real terminal with recorded key timing and exported performance telemetry before tuning the bounds or adding deferred warming.
