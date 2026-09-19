# Transcript windowing implementation

Status: Stages 5.0–5.3 are complete and verified. Stage 5.4 is in progress; indexed cursor/message target materialization is complete and the remaining semantic operations are next.

- [Transcript runtime design](./transcript-runtime.md) owns the normative model and invariants.
- [Transcript runtime implementation](./transcript-runtime-implementation.md) owns Stages 1–4 and their evidence.
- [Transcript runtime research](./transcript-runtime-research.md) owns supporting evidence and references.
- This document owns Stage 5 implementation order, verification, performance evidence, and commit history.

## Objective

**Goal: Make transcript size cease to matter.**

Make steady-state transcript rendering and native layout cost independent of total in-memory transcript size without changing transcript semantics.

Windowing changes materialization, not meaning. Conversation state remains canonical. `TranscriptState` remains authoritative for cursor, selection, folds, search, marks, jumps, and the logical viewport anchor. `TranscriptRuntime` remains a recoverable presentation cache.

## Status

| Work | State | Evidence |
|---|---|---|
| Stage 5 topology and contracts | Complete | Established by Stages 2–4 |
| Stages 1–4 performance baseline | Complete | Reproducible benchmark commit `ae73913`; inherited measurements below |
| Stage 5 scaling fixtures | Complete | Commit `edc28c0`; deterministic runtime/React curves, real native cells, connected-input ceiling, and evidence below |
| Stage 5a: pure window planner | Complete | Commit `4021939`; indexed height queries, bounded follow/detached/reveal windows, pass-through fallback, and evidence below |
| Stage 5b: windowed mounting | Complete | Commit `3e24002`; bounded production runtime, React/native mounting, observer lifetime, scaling evidence, and review sign-off below |
| Stage 5c: anchor correction | Complete | Commit `97f163f`; atomic height correction, window-local geometry, logical-anchor restoration, scaling evidence, and review sign-off below |
| Stage 5d: off-window semantics | In progress | Commit `a24f5af`; indexed cursor/message target materialization, bounded UI motion, empty-item anchors, and evidence below |
| Stage 5e: follow and detachment | Not started | — |
| Stage 5f: stress, review, and evidence | Not started | — |

“Complete” means the slice's exit criteria pass, evidence is recorded here, and the implementation is committed. Partial working-tree changes do not count as complete.

## Inherited performance baseline

Stages 1–4 established the starting point for Stage 5. Preserve the timing boundary of each measurement when comparing windowed results:

| Path | Inherited evidence | Boundary |
|---|---:|---|
| Warm native frame / cached layout / visible anchor | 0.108 / 0.006 / 0.425 ms medians | One already-mounted, already-measured 1,500-line command at 100×30 |
| Steady streaming settlement | 18.14–20.30 ms | Connected application at 80×24 with a mounted 1,200-paragraph Markdown answer |
| Navigation around the large streaming fixture | 51.92–57.41 ms | Connected application settlement, not runtime-only reconciliation |
| Cold renderer setup / geometry publication | 22.690 / 183.529 ms medians | Fresh renderer and runtime around one 135,389-character expanded command |
| Follow reconciliation | 0.217 ms median, 0.264 ms p95 | Isolated `TranscriptRuntime.update` with 300 settled blocks and one changed tail; projection and rendering excluded |
| Large-history runtime update | 2.417 ms | Runtime reconciliation with 10,000 historical items |

These are diagnostic baselines, not universal thresholds. Stage 5 must measure the same operation and content shape across session sizes so results describe a scaling curve rather than unrelated fast fixtures. Runtime-only reconciliation, React publication, native mounting, geometry measurement, and end-to-end settlement remain separately reported.

## Scope

Stage 5 includes:

- a renderer-neutral height index over stable render blocks;
- a pure window planner with configurable overscan;
- leading and trailing spacer rows;
- mounting only the planned block range;
- correction of estimated heights without moving the logical reading anchor;
- materialization of off-window cursor, search, mark, jump, selection, and thread-navigation targets;
- canonical copy and search semantics independent of mounted native nodes;
- independent windows for follow and detached presentations;
- deterministic large-history correctness and performance tests.

Stage 5 does not include:

- server-backed history paging;
- partial canonical conversations;
- remote or persistent page caches;
- transport continuation cursors;
- remote transcript search;
- persistent native geometry;
- replacing logical positions with terminal coordinates.

Server-backed paging is a separate future project because it changes canonical data availability and introduces resource-access, consistency, retry, and reconciliation policy. No speculative history port should be added until a real secondary history resource exists.

## Governing invariants

1. Windowing never changes canonical conversation or semantic transcript state.
2. Mounted native nodes are disposable presentation resources, never semantic authority.
3. Logical positions remain `{ itemId, graphemeOffset }`; physical rows and cells remain width-dependent cache data.
4. Removing a block from the mounted window cannot remove its cursor, selection, fold, mark, jump, search, copy, or fork meaning.
5. Item blocks retain half-open canonical source spans. Empty source retains a zero-width span and one logical anchor.
6. Turn-activity blocks remain source-less and cannot become cursor, selection, search, copy, or fork targets.
7. Follow and detached presentations may show the same canonical thread with independent displayed revisions, anchors, geometry, and windows.
8. Estimated-to-measured height correction preserves the logical anchor and preferred screen row.
9. An explicit target outside the window is materialized atomically before native navigation.
10. Incremental index and window updates always have a correct full-rebuild fallback.
11. Input and navigation take priority over speculative overscan and hidden presentation work.
12. The number of mounted blocks is bounded by viewport demand and overscan, not transcript length.

## Topology

Stage 5 requires no new architectural layer or package. It fills the window-planning seam already owned by `@vimex/transcript`.

```text
canonical ConversationState
          │
          ▼
semantic TranscriptState
          │
          ▼
complete lightweight block plan
          │
          ├──────────────┐
          ▼              │
block-local geometry     │ estimated rows
          │              │
          └──────┬───────┘
                 ▼
        height prefix index
                 │
                 ▼
          pure window planner
                 │
       ┌─────────┼─────────┐
       ▼         ▼         ▼
 top spacer   blocks   bottom spacer
                 │
                 ▼
       OpenTUI mounted window
                 │
                 ▼
 renderer-neutral measurements
                 │
                 └──── guarded feedback to TranscriptRuntime
```

Authority remains one-way:

```text
canonical + semantic state ──► presentation frame ──► mounted native nodes
                                      ▲
                                      │
                         disposable measurements only
```

Measurement feedback may refine height estimates and window placement. It cannot mutate canonical content, semantic positions, attachment state, or displayed revision identity.

## Responsibility map

| Responsibility | Owner |
|---|---|
| Canonical turns and items | `@vimex/conversation` |
| Cursor, selection, folds, search, marks, jumps, logical anchor | semantic transcript domain |
| Block plan, height index, window policy, anchor correction | `@vimex/transcript` runtime |
| Presentation lifetime and canonical revision input | Workbench |
| Native mounting, spacer renderables, measurement extraction | OpenTUI adapter |
| Input interpretation and semantic commands | interaction/workbench boundaries |

Do not introduce a second transcript store, a React-owned runtime, or a generic virtualization service. The window planner is transcript-specific because it coordinates logical targets, source spans, source-less activity, follow/detached behavior, and block geometry.

## Target source topology

Add files only with their first tested behavior. Exact names may be adjusted if the responsibility already fits an existing module.

```text
packages/transcript/src/
  runtime.ts                 # owns selected window and guarded measurement feedback
  window.ts                  # block/window contracts and pure range planning
  geometry.ts                # immutable block geometry and global row composition
  height-index.ts            # optional only when a real indexed implementation begins

packages/ui-opentui-react/src/transcript/
  TranscriptViewport.tsx     # mounts planned blocks and spacer roots
  rendered-layout.ts         # schedules visible measurements and native placement
  use-transcript-layout.ts   # restores logical anchor after window/reflow changes
  measure-rendered-block.ts  # sole OpenTUI-private measurement boundary

packages/testkit/src/
  transcript-builders.ts     # deterministic large-history fixtures when first needed
```

Prefer keeping the first height index in `window.ts` or `geometry.ts`. Extract `height-index.ts` only when the indexed structure has enough tested behavior to justify its own module.

## Existing contracts

Stage 5 extends the existing contracts rather than replacing them:

```ts
type TranscriptBlock =
  | {
      key: { kind: "item"; itemId: ItemId; blockId: string }
      sourceSpan: SourceSpan
      contentRevision: number
      estimatedRows: number
    }
  | {
      key: { kind: "turn-activity"; turnId: TurnId }
      sourceSpan?: undefined
      contentRevision: number
      estimatedRows: number
    }

interface TranscriptWindow {
  blocks: readonly TranscriptBlock[]
  topSpacerRows: number
  bottomSpacerRows: number
  overscanRows: number
}
```

`TranscriptFrame.blocks` is the complete lightweight chronological plan and remains available for semantic routing, height indexing, and full-rebuild equivalence. `TranscriptFrame.window.blocks` is the materialized subset that the OpenTUI adapter mounts and measures. Renderer-neutral geometry may combine retained measurements and estimates across the complete plan, but native renderable inspection is restricted to the materialized window.

The current pass-through planner is the full-rebuild reference implementation, so the complete plan and materialized subset are equal today. Windowed output must preserve the same chronological block order and semantic behavior for every materialized range.

## Window planner model

The planner consumes presentation facts, not native objects:

```text
ordered blocks
+ measured or estimated block rows
+ viewport height
+ logical anchor or tail attachment
+ overscan policy
+ explicit reveal target, if any
────────────────────────────────────
= TranscriptWindow
```

The planner owns:

- translating a logical anchor or tail attachment into a target row range;
- finding the smallest chronological block range covering that range;
- expanding the range by overscan;
- calculating top and bottom spacer rows;
- including a required explicit target even when it lies outside the current range;
- keeping output deterministic for equivalent inputs.

The planner does not own:

- canonical item loading;
- semantic cursor or selection mutation;
- native renderable creation;
- terminal focus;
- scrolling side effects;
- persistence.

## Height index

The height index maps stable block identity to measured or estimated row height and supports:

```text
prefixRows(block index)         O(log n) target, O(1) acceptable only initially
blockAtRow(global row)          O(log n)
rowRange(block range)           O(log n)
replaceHeight(block, rows)      O(log n)
insert/remove changed blocks    O(log n + k)
totalRows                       O(1)
```

The implementation may begin with a simple immutable prefix vector if benchmarks show it is sufficient. Move to a Fenwick tree, segment tree, or chunked prefix structure only when measured mutation or lookup cost requires it. The contract must not expose the data structure.

Measured rows win over estimates only when their block key, content revision, width, style revision, fold state, canonical generation, displayed canonical revision, presentation revision, and geometry generation remain current.

## Overscan policy

Overscan is expressed in rows and is configurable by the runtime. Initial policy should be deliberately simple:

- at least one viewport above and below during ordinary detached reading;
- trailing bias while following live output;
- temporary expansion around an explicit reveal target;
- bounded speculative measurement per scheduling turn.

Do not tune the default from intuition alone. Record mount churn, measurement count, navigation latency, and memory at several values before choosing it.

## Anchor correction

Height estimates will differ from native measurements. Corrections must preserve meaning:

```text
before measurement:
  logical anchor P appears at preferred screen row R

after measurement:
  rows above P changed by Δ

correction:
  adjust native scroll by Δ so P remains at R
```

Rules:

- capture the logical anchor before accepting measurements that can move global rows;
- commit one revision-guarded measurement batch atomically;
- recompute the window and spacer rows;
- restore the same logical anchor to its preferred screen row;
- never persist the physical correction as semantic identity;
- fall back to a full presentation rebuild when lineage is uncertain.

## Off-window semantics

Semantic operations always use the complete canonical projections, not mounted nodes.

| Operation | Required window behavior |
|---|---|
| Cursor motion within mounted content | No forced window change until target approaches the boundary |
| Cursor/search/mark/jump target outside window | Materialize target, then restore it to the requested screen row |
| Message/thread navigation | Select canonical target first, then plan its window |
| Selection spanning unmounted blocks | Retain complete logical endpoints; render only the visible segment |
| Copy/yank | Read canonical projections across the complete logical selection |
| Fold change | Reindex affected blocks and preserve the logical anchor |
| Follow | Select the latest canonical revision and trailing window atomically |
| Detached hidden output | Keep the displayed revision, window, and mounted content stable |

Window movement must never be required to discover the semantic target. Discovery happens against canonical transcript state; materialization follows.

## Renderer mounting

The OpenTUI adapter receives one `TranscriptWindow` and mounts only its blocks plus stable spacer roots:

```text
TranscriptViewport
├── top spacer
├── mounted block roots
│   ├── item block
│   ├── item sub-block
│   └── turn activity block
└── bottom spacer
```

Requirements:

- block keys remain stable across window movement;
- spacer nodes do not enter cursor, selection, search, copy, or measurement semantics;
- unmounting a block releases native references and measurement observers;
- remounting may reuse renderer-neutral geometry when its complete key still matches;
- visible measurement is prioritized over overscan measurement;
- hidden panes own no native measurement or animation work;
- native node count remains bounded under long histories.

## Implementation slices

### Stage 5.0 — baseline and deterministic fixtures

- [x] Record pre-windowing mount counts, native layout work, memory, and navigation latency alongside the inherited timing baselines.
- [x] Add deterministic 100, 1k, 10k, and 100k render-block fixtures.
- [x] Run identical warm navigation, follow delta, detachment, reattachment, and explicit-reveal workloads at every recorded size.
- [x] Add oversized Markdown, command-output, and split-diff fixtures.
- [x] Cover follow and detached presentations at several terminal dimensions.
- [x] Preserve a pass-through reference path for semantic equivalence tests.

Exit criteria:

- Fixtures are deterministic and do not dominate test runtime accidentally.
- Baselines separate planner, React reconciliation, native layout, and end-to-end input latency.
- Every scaling result identifies transcript size, mounted block count, measured block count, changed block count, and publication count.

### Stage 5.1 — pure window planner

- [x] Build a renderer-neutral height index over stable block keys.
- [x] Plan visible and overscan block ranges from viewport rows.
- [x] Calculate leading and trailing spacer rows.
- [x] Plan a trailing window for follow attachment.
- [x] Plan an anchor-centered window for detached reading.
- [x] Include explicit off-window targets deterministically.
- [x] Retain a full pass-through fallback for unknown relationships.

Exit criteria:

- Planner tests require no React or OpenTUI.
- Equivalent inputs return semantically equivalent windows.
- Lookup and update costs meet the recorded large-history budget.

### Stage 5.2 — windowed mounting

- [x] Render planned blocks rather than the complete block array.
- [x] Add stable leading and trailing spacer roots.
- [x] Mount and unmount measurement observers with their owning block roots.
- [x] Prioritize visible block measurement over overscan.
- [x] Bound mounted block and native-node counts.
- [x] Preserve the pass-through renderer behind a test-only comparison seam until equivalence is established.

Exit criteria:

- Mounted block count remains viewport/overscan-bounded at 1k, 10k, and 100k blocks.
- Chronology and visible presentation match the pass-through reference.
- Moving the window does not leak native observers or stale references.

### Stage 5.3 — estimate correction and anchor stability

- [x] Commit guarded visible measurement batches atomically.
- [x] Replace estimates with measured rows in the height index.
- [x] Replan the window after accepted height changes.
- [x] Preserve the logical anchor at its preferred screen row.
- [x] Handle asynchronous Markdown, table, diff, and syntax settlement.
- [x] Prevent estimate-correction oscillation and repeated no-op publications.

Exit criteria:

- Reflow above, within, and below the viewport does not visibly move the logical anchor.
- Stale measurements cannot change spacers, window membership, or scroll position.
- Prior frames and geometry snapshots remain immutable.

### Stage 5.4 — off-window semantics

- [x] Materialize cursor and message-motion targets outside the current window.
- [ ] Materialize search, mark, jump, history, and thread-navigation targets.
- [ ] Render selections whose logical endpoints span unmounted blocks.
- [ ] Copy source and rendered text across unmounted blocks from canonical projections.
- [ ] Preserve folds and URL navigation across window changes.
- [x] Verify empty-source items and source-less activity at window boundaries.

Exit criteria:

- Semantic results equal the pass-through reference for all operations.
- No operation depends on finding a native node to determine its target.
- Explicit target materialization and native navigation settle as one user-visible transition.

### Stage 5.5 — follow, detachment, and multiple presentations

- [ ] Keep follow pinned to the trailing window during settled streaming.
- [ ] Keep detached displayed content, anchor window, and geometry stable during hidden streaming.
- [ ] Reattach by selecting the latest revision and trailing window atomically.
- [ ] Preserve independent main and side presentation windows.
- [ ] Keep hidden or maximized-away panes free of mounting and measurement work.
- [ ] Bound ingress, planner, measurement, and render work so input cannot be starved.

Exit criteria:

- Hidden tail output causes no detached content-window publication.
- Reattachment publishes one coherent latest frame and window.
- Streaming one pane does not reconcile or measure another pane.

### Stage 5.6 — stress, review, and evidence

- [ ] Run full semantic, renderer, integration, and PTY regression suites.
- [ ] Benchmark identical operations at 100, 1k, 10k, and 100k render blocks.
- [ ] Benchmark one oversized Markdown item, command output, and split diff.
- [ ] Record warm navigation, window movement, follow settlement, anchor correction, mount churn, and memory separately.
- [ ] Run parallel architecture, correctness, and performance review rounds.
- [ ] Repair findings and rerun focused and full gates.
- [ ] Record commit and benchmark evidence in this document.

Exit criteria:

- Across the recorded 100/1k/10k/100k range, steady-state mounted block count, native measurement work, follow-tail damage, and detached-window publications are independent of total transcript size.
- Transcript size is not perceptible through steady-state navigation or rendering within the recorded target envelope.
- Mounted work remains bounded by viewport and overscan.
- Full and windowed presentations remain semantically equivalent.

## Test matrix

### Pure planner

- empty transcript;
- one empty-source item;
- activity-only terminal turn;
- viewport smaller than, equal to, and larger than total history;
- exact and partial block boundaries;
- asymmetric follow overscan;
- detached anchor at first, middle, and final block;
- explicit target far before and after the current window;
- measured and estimated heights mixed;
- block insertion, removal, fold, and content revision change;
- unknown revision relationship and full fallback.

### Semantic equivalence

- cursor motions and preferred screen row;
- message, word, URL, and semantic-block motions;
- forward and backward search;
- marks and jump history;
- Visual character and line selection;
- rendered-text and source-Markdown copy;
- fold toggles and fold-all;
- fork-boundary resolution;
- empty items and source-less activity blocks.

### Renderer and geometry

- stable keyed mounting;
- spacer placement and total row equivalence;
- asynchronous equal-height and changed-height reflow;
- wide graphemes, combining marks, tables, diffs, and concealed syntax;
- unmount cleanup and remount geometry reuse;
- resize, theme, syntax, and renderer reset;
- hidden panes and side-by-side panes;
- prior frame and geometry immutability.

### Streaming and lifecycle

- one long-running item receiving many settled delta batches;
- new tail items and source-less activity while following;
- hidden tail updates while detached;
- explicit navigation into hidden new content;
- atomic follow reattachment;
- hydration, restart, disconnect, shutdown, and thread retirement;
- independent windows over one canonical thread.

## Performance evidence

Use operation counts as stable correctness gates and timings as calibrated local diagnostics.

Hard gates:

- mounted block count is bounded by visible rows plus configured overscan;
- hidden detached output produces zero content-window publications;
- scroll-only movement does not remeasure unchanged blocks;
- one changed tail block does not clone historical geometry;
- accepted height changes update only affected index paths and window output;
- reattachment produces one coherent content/window publication;
- semantic operations equal the pass-through reference;
- stale measurement batches produce zero window or spacer changes.

Record the same workload for each 100, 1k, 10k, and 100k fixture and report both absolute values and the scaling curve:

| Path | Measurements |
|---|---|
| Warm cursor/navigation | p50, p95, maximum, publications, measurements |
| Window movement | planner time, mount churn, native frame time |
| Follow streaming | ingress settlements, planner work, changed measurements |
| Detached streaming | frame/window publications, hidden damage, input latency |
| Anchor correction | accepted measurements, correction time, visible displacement |
| Explicit reveal | semantic lookup, planning, mount, measurement, final settlement |
| Memory | canonical state, runtime blocks, geometry, mounted native nodes |

For follow reconciliation at every size, one changed tail block must replace only that block, preserve every unrelated block and geometry identity, and produce viewport-bounded mounted work. Timings remain diagnostic; changed-block, publication, measurement, mount, and identity counts are deterministic gates.

Do not turn machine-specific millisecond targets into universal CI gates until calibrated. CI should enforce bounded operation counts, stable identity, semantic equivalence, and deterministic fake-scheduler behavior.

## Commit checkpoints

Prefer independently reviewable vertical slices:

```text
1. test: add transcript windowing baselines and fixtures
2. feat: add indexed transcript window planner
3. feat: mount transcript render windows
4. feat: preserve anchors across window reflow
5. feat: reveal off-window transcript targets
6. feat: stabilize follow and detached windows
7. perf: validate large transcript windowing
8. docs: record transcript windowing evidence
```

Each implementation commit must leave the application working and pass its focused gate. Push after coherent, reviewed milestones rather than accumulating the whole stage in one working-tree change.

## Review questions

### Architecture

- Did any semantic authority move into the window, geometry index, React, or native nodes?
- Is the planner renderer-neutral and deterministic?
- Does Workbench still own presentation lifetime while transcript owns window policy?
- Did a speculative paging or generic virtualization abstraction enter the design?

### Correctness

- Can any logical target become unreachable because its block is unmounted?
- Can estimate correction visibly move the reading anchor?
- Can stale geometry change window membership or spacer rows?
- Can detached hidden output mutate the displayed window?
- Do empty items and source-less activity preserve chronology at boundaries?

### Performance

- Does any steady-state path scan all blocks or grapheme points?
- Is mounted native work bounded independently of transcript length?
- Does window movement cause avoidable remount or remeasurement churn?
- Are input and visible work prioritized over overscan?
- Are geometry and height caches bounded by materialized or explicitly budgeted data?

## Deferred: server-backed history paging

Server-backed paging would make canonical history partially available and therefore requires a separate design and implementation ledger. Likely concerns include:

- transport continuation or boundary cursors;
- page identity, ordering, overlap, and deduplication;
- live-tail reconciliation with newly loaded older pages;
- retry and partial-failure presentation;
- marks, jumps, selections, and forks that reference unloaded content;
- global search across unloaded history;
- unknown total height and scrollbar semantics;
- memory and eviction policy for loaded canonical pages.

If that need becomes real, introduce a history resource-access port at the canonical/application boundary. `TranscriptRuntime` should continue to consume the currently authoritative canonical block sequence and remain unaware of transport mechanics.

## Evidence ledger

Record implementation commits, focused gates, full repository gates, benchmarks, review findings, and repairs here as Stage 5 advances.

### Stage 5.0 — baseline and deterministic fixtures

Implementation commit: `edc28c0` (`test: add transcript windowing baselines and fixtures`). No production runtime, Workbench, React bridge, geometry, or OpenTUI behavior changed in this slice.

#### Deterministic fixtures and correctness gates

- `buildTranscriptScalingFixture` constructs exact 100, 1k, 10k, and 100k complete render-block plans in O(n). Every size contains meaningful user, assistant, command, edit, reasoning, and running-tail boundaries while producing no activity block.
- The fixture carries a cross-item selection, search and URL target, mark and jump locations, a real reasoning fold, and a completed-turn fork boundary. Its content hash covers item identity, kind, projected source, status, tail delta, and count.
- The test-only full-materialization oracle calls `buildTranscriptBlocks` and `passThroughWindow` directly and hard-gates array identity, complete count, and zero spacers. Incremental frames compare complete transcript state plus evaluated copy, reference, search, URL, fold, mark/jump, and fork evidence against that oracle.
- At every recorded size, one follow-tail delta changes exactly one block, preserves `N - 1` block identities and `N - 1` geometry identities, publishes once, and invalidates only the tail measurement. Detached hidden output publishes zero frames; reveal and reattachment each publish once with the canonical logical cursor and viewport at the target.
- Oversized fixtures are deterministic before production sub-block planning: Markdown is 143,375 characters / 1,024 fixture segments; command output is 227,527 characters / 2,501 segments; split diff is 29,749 characters / 128 file segments. Segment spans are unique, contiguous, nonempty, and cover canonical source exactly.

Focused gate:

```text
bun test packages/testkit/src/transcript-builders.test.ts packages/transcript/src/runtime-scaling.test.ts
5 pass, 0 fail, 14,953 assertions, 6.29 s
```

#### Separated pre-windowing scaling boundaries

All timing values below are single local observations and diagnostic only. Operation counts and identity results are the hard gates.

| Blocks | Cold runtime | Synthetic geometry publication | Follow reconciliation | Warm view navigation | Explicit reveal | Reattach | Materialized / seeded | Changed / retained identities |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 1.040 ms | 0.448 ms | 0.337 ms | 0.080 ms | 0.203 ms | 0.158 ms | 100 / 100 | 1 / 99 |
| 1k | 2.593 ms | 1.544 ms | 0.872 ms | 0.021 ms | 0.908 ms | 0.812 ms | 1k / 1k | 1 / 999 |
| 10k | 26.163 ms | 12.694 ms | 9.820 ms | 0.023 ms | 13.303 ms | 9.401 ms | 10k / 10k | 1 / 9,999 |
| 100k | 296.076 ms | 153.803 ms | 116.868 ms | 0.064 ms | 120.368 ms | 116.357 ms | 100k / 100k | 1 / 99,999 |

The planner is still the pass-through reference, so materialized and synthetic seeded measurement counts equal total transcript size. React-only publication produced exactly one runtime publication and one React commit at every size; its subscribed view contains one constant text node, deliberately excluding transcript mounting.

The real native 100-block / 80×24 cell mounts `TranscriptViewport` and uses the production `measureRenderedTranscript` scheduler. Cold work mounted 100 roots, attempted and accepted 100 measurements, and published geometry once. Viewport culling produced 13 point-bearing and 87 explicitly recorded zero-point measurements. The follow delta retained all 100 root identities, mounted/unmounted zero roots, published once, and the next measurement pass touched exactly one block. Detached hidden output published zero runtime frames, committed zero React renders, and mounted/unmounted zero roots.

Follow and detached presentation cells also passed at 48×18, 80×24, and 140×40. Each mounted 100 roots; follow retained all 100 with zero churn, while detached hidden output retained all roots with zero publications and commits. Observed follow presentation settlements were 32.139, 12.416, and 15.993 ms respectively.

#### Connected input and memory boundary

Connected-input cells run one size per isolated worker. Fixture construction and hydration are excluded: a benchmark-only setup step installs an already-valid canonical `ConversationState` and semantic `TranscriptState` into an initialized, not-yet-observed Workbench workspace. `TranscriptRuntime` creation happens afterward. The measured interval begins at OpenTUI key dispatch and includes public Workbench command handling, runtime and presentation publication, Connected React reconciliation, native frame callbacks, and final settlement.

| Blocks | Result at 80×24 | Dispatch | Final settlement | Mounted / retained | Accepted measurement damage | Runtime / Workbench publications | Settled RSS |
|---:|---|---:|---:|---:|---:|---:|---:|
| 100 | Passed | 7.130 ms | 77.454 ms | 100 / 100 | 4 (bound ≤ 4) | 3 / 1 | 307 MB |
| 1k | Passed | 9.939 ms | 88.310 ms | 1k / 1k | 4 (bound ≤ 4) | 3 / 1 | 495 MB |
| 10k | Passed | 33.772 ms | 1,262.823 ms | 10k / 10k | 4 (bound ≤ 4) | 3 / 1 | 2.07 GB |
| 100k | Failed before settlement | — | — | unavailable | unavailable | unavailable | 1.75 GB at failure |

The isolated 100k worker failed during the inherited pass-through native allocation with `Failed to create TextBuffer`. Its fixture snapshot used about 255 MB RSS and the attempted mount reached about 1.75 GB RSS before failure; mounted, measured, changed, and publication counts are recorded as unavailable rather than inferred. This is the pre-windowing ceiling Stage 5.1/5.2 must remove, not a passing sample. Memory is process-level diagnostic evidence: process→fixture, fixture→settled mount, and mount→input deltas include allocator and native effects and are not component-exclusive.

React commit and native frame counts in this connected boundary are scheduler diagnostics. The deterministic hard gates are exact mounted/retained/changed/publication counts and the accepted measurement-damage bound. The package `:native` and `:input` scripts are safe smoke cells, not full-matrix aliases; size and viewport environment selectors run isolated cells explicitly.

#### Repository, PTY, benchmark, and review gates

- `bun run benchmark:transcript-windowing`: passed the identical runtime and React workloads at 100/1k/10k/100k.
- `bun run benchmark:transcript-windowing:native`: passed the real 100-block / 80×24 native smoke. Explicit 48×18 and 140×40 native cells also passed.
- `VIMEX_PROFILE_TUI=1 bun test packages/ui-opentui-react/src/transcript/wheel-interaction.test.tsx`: 11 passed, including connected scrolling, folding, draft-preservation, and streaming profiles.
- `bun run check`: typecheck, dependency boundaries, generated-doc check, and all non-sandbox-sensitive tests passed; aggregate was 659 passed, 5 intentional skips, and the isolated tmux test failed only because the sandbox removed its socket.
- The exact isolated rerun outside the sandbox passed: `bun test tests/terminal/terminal.test.ts --test-name-pattern "isolated tmux"` — 1 passed in 717 ms.
- Parallel architecture, correctness, and performance reviews ran before and after repairs. Repairs added real rendered native measurement, connected Workbench input, isolated memory/failure reporting, exact/common operation counts, meaningful semantic fixtures, a non-windowed oracle, correct reveal state, bounded measurement damage, and honest boundary labels. Final review found no production-architecture blocker; the 100k native failure is retained as baseline evidence.

Stage 5 size-independence acceptance remains open. This baseline demonstrates the opposite inherited curve: pass-through materialization, native mounting, and cold measurement scale with total transcript size, and the connected 100k native presentation cannot settle. Stage 5.1 begins the pure window planner that will change materialization without changing meaning.

### Stage 5.1 — pure window planner

Implementation commit: `4021939` (`feat: add indexed transcript window planner`). This slice adds renderer-neutral planning only. `TranscriptRuntime`, Workbench, React, OpenTUI mounting, and native measurement still use the pass-through window until Stage 5.2.

#### Contracts and correctness

- `TranscriptHeightIndex` is an immutable persistent exact-range tree. Initial construction is O(n); prefix, row, range, and height-replacement paths are O(log n); total rows, stable-key lookup, exact-plan compatibility, and item-to-sub-block lookup are O(1).
- A valid height replacement path-copies only the affected tree path. Stale revisions, invalid rows, missing keys, and equal heights preserve the exact index identity. Earlier index snapshots remain unchanged.
- `planTranscriptWindow` consumes only complete blocks, the renderer-neutral height index, viewport rows, overscan rows, logical attachment, and an optional logical reveal target. It returns original block objects plus exact leading/trailing row spacers.
- Tail attachment uses trailing overscan. Point attachment preserves a bounded preferred screen row, including negative semantic anchor rows clamped only at the physical planning boundary. A distant explicit reveal recenters a bounded range instead of mounting the intervening history.
- Same-item render sub-blocks are indexed once and targeted by binary search. Their source spans must be ordered, disjoint, valid for one shared immutable projection, and unambiguous. Invalid spans, duplicate block keys, incompatible plans, and unknown targets take the exact `passThroughWindow` reference path.
- Empty-source item endpoints remain addressable; source-less turn activity never becomes a logical target. Block identity, chronology, half-open source ownership, and total-row conservation are hard-gated against independent linear oracles.

Focused gates:

```text
bun test packages/transcript/src/height-index.test.ts packages/transcript/src/window.test.ts packages/transcript/src/window-planner.test.ts
25 pass, 0 fail, 4,631 assertions

bun test packages/transcript
93 pass, 0 fail, 5,226 assertions

bun run typecheck
bun run boundaries
git diff --check
all passed
```

#### Deterministic planner scaling

`bun run benchmark:transcript-window-planner` runs identical 24-row viewport / 24-row overscan workloads. Timings are one local diagnostic observation; mounted counts, retained identities, row conservation, target comparisons, and tree visits/copies are asserted gates.

| Blocks | Index build | Follow plan / mounted | Detached plan / mounted | Far reveal / mounted | Replacement copies | Same-item target comparisons / mounted |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 0.510 ms | 0.212 ms / 48 | 0.117 ms / 72 | 0.044 ms / 48 | 7 | 9 / 57 |
| 1k | 2.531 ms | 0.035 ms / 48 | 0.031 ms / 72 | 0.024 ms / 48 | 10 | 12 / 72 |
| 10k | 12.246 ms | 0.083 ms / 48 | 0.048 ms / 72 | 0.026 ms / 48 | 14 | 16 / 72 |
| 100k | 141.964 ms | 0.055 ms / 48 | 0.060 ms / 72 | 0.027 ms / 48 | 17 | 19 / 72 |

Every planned block retains the exact source-plan object identity. Follow, detached, and reveal work obey logarithmic deterministic visit bounds at every size. One middle-block height change adds three rows, copies 7/10/14/17 nodes, leaves the prior index immutable, and replans 69 blocks. An equal-height update copies zero nodes and retains the index identity. The unsupported-relationship probe returns the exact input block array with zero spacers and zero overscan.

The same benchmark builds 100/1k/10k/100k stable sub-blocks for one oversized item. Logical targeting takes 9/12/16/19 indexed comparisons, below the asserted 11/14/18/21 logarithmic bounds, and mounts at most 72 blocks. Production root-block splitting is intentionally deferred; Stage 5.1 proves that the planner and lookup contract can window stable sub-blocks once a producer supplies them.

#### Repository and review gates

- `bun run check`: typecheck, dependency boundaries, generated-doc check, and every non-sandbox-sensitive test passed. The isolated tmux case failed only because the sandbox removed its Unix socket.
- The exact isolated rerun outside the sandbox passed: `bun test tests/terminal/terminal.test.ts --test-name-pattern "isolated tmux"` — 1 passed in 790 ms.
- Parallel architecture, correctness, and performance reviews ran after the slice. Repairs bounded negative preferred rows and replaced an O(n) same-item sub-block scan with the indexed logarithmic resolver. A final audit also made distinct per-sub-block projection snapshots an explicit unsupported relationship. Focused gates and scaling benchmarks were rerun after repair; final review found no Stage 5.1 blocker.

Stage 5 size-independence acceptance remains open. The pure planner now makes selected range size and indexed lookup/update work independent of total history except for logarithmic tree depth, but production native mounting remains pass-through until Stage 5.2 consumes the planned window.

### Stage 5.2 — windowed mounting

Implementation commit: `3e24002` (`feat: mount bounded transcript windows`). Production Workbench presentations now opt into a viewport/overscan policy while direct `TranscriptRuntime` construction remains the pass-through semantic reference.

#### Production ownership and correctness

- Each presentation runtime owns its height index, window, frame, geometry, and measurement acceptance boundary. Main and side presentations were exercised independently; resizing or retiring one does not publish or dispose the other.
- `TranscriptViewport` renders only `frame.window.blocks` between stable leading and trailing spacer roots. Render-block chronology and identity come from the complete plan; activity adjacency is explicit complete-plan metadata rather than inferred from mounted siblings.
- The native scheduler synchronizes exact mounted keys on every window change, prioritizes visible candidates before overscan, and prunes departed pending entries, roots, children, placements, screen rows, and cached layouts. Retained native callbacks after unmount cannot reintroduce dirty work. Hidden panes run cleanup without measurement.
- Semantic authorities remain complete. Default-fold policy and fold-all traverse `TranscriptState`, selection uses a complete-order index, and off-window `gg`/`G` plus boundary-crossing motions use the complete layout reference before publishing a logical target. These reference scans are intentionally retained for correctness and are scheduled for indexing in Stages 5.4–5.5.
- Measurements are accepted only for the current materialized window and generation. A drop-only window shrink cannot retain stale geometry, and a no-op window plan preserves frame/window identity.

#### Deterministic native scaling

The 80×24 production cell ran identical workloads at every fixture size. Counts are hard gates; timings remain machine-specific diagnostics.

| Complete blocks | Cold mounted / measured | Visible / overscan candidates | Native descendants + spacer roots | Follow retained / changed / attempted | Detached mounted / attempted / publications | Hidden delta publications / churn |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 48 / 48 | 12 / 36 | 246 + 2 | 48 / 1 / 4 | 72 / 50 / 2 | 0 / 0 |
| 1k | 48 / 48 | 12 / 36 | 242 + 2 | 48 / 1 / 4 | 72 / 72 / 2 | 0 / 0 |
| 10k | 48 / 48 | 12 / 36 | 242 + 2 | 48 / 1 / 4 | 72 / 72 / 2 | 0 / 0 |
| 100k | 48 / 48 | 12 / 36 | 242 + 2 | 48 / 1 / 4 | 72 / 72 / 2 | 0 / 0 |

The 100-block detached movement overlaps its prior window and therefore attempts only 50 of 72 mounted roots; the larger fixtures intentionally move to a disjoint window and prune exactly 48 departed roots. Every detached movement publishes twice: once for the logical window move and once for accepted geometry. After acknowledgement, pending measurement count is zero. Hidden canonical tail changes publish and commit zero frames for the detached presentation.

The viewport matrix also passed at 48×18, 80×24, and 140×40. Follow windows mounted 36, 48, and 80 blocks respectively; follow damage attempted 3, 4, and 6 candidates. The widest 100-block cell naturally mounted 98 detached blocks because the bounded requested window approached the complete fixture, not because its policy changed.

#### Connected input boundary

The connected cell includes public Workbench command handling, production runtime publication, Connected React reconciliation, OpenTUI roots, native frame callbacks, measurement, and settlement. Fixture construction and hydration remain outside the measured interval.

| Complete blocks | Materialized / mounted / measured | Runtime / presentation publications | Native descendants after + spacer roots | Dispatch / final settlement | Result |
|---:|---:|---:|---:|---:|---|
| 100 | 42 / 42 / 42 | 4 / 1 | 230 + 2 | 58.800 / 136.688 ms | Passed |
| 1k | 42 / 42 / 42 | 2 / 1 | 224 + 2 | 64.153 / 103.003 ms | Passed |
| 10k | 42 / 42 / 42 | 2 / 1 | 224 + 2 | 93.033 / 132.495 ms | Passed |
| 100k | 42 / 42 / 42 | 2 / 1 | 224 + 2 | 491.793 / 561.720 ms | Passed |

The inherited 100k cell failed while attempting pass-through native allocation. The windowed cell now settles with 42 mounted and measured roots. Its remaining total-size timing and memory curve is diagnostic evidence of complete semantic construction, height-index construction, and geometry composition still in the path; it is not attributed to bounded native mounting.

#### Repository, PTY, benchmark, and review gates

- Focused packages, Workbench integration, App, and renderer gates passed: 360 passed, 5 intentional skips, 0 failed, 37,026 assertions.
- `bun run check` passed typecheck, dependency boundaries, generated-doc validation, and every non-sandbox-sensitive test: 685 passed and 5 intentional skips. Its only failure was the sandbox-denied tmux socket.
- The exact isolated rerun outside the sandbox passed: `bun test tests/terminal/terminal.test.ts --test-name-pattern "isolated tmux"` — 1 passed in 689 ms.
- The complete 100/1k/10k/100k production native and connected-input matrices passed, as did the 48×18, 80×24, and 140×40 viewport matrix. `git diff --check` passed.
- Parallel architecture, correctness, and performance reviews ran before and after repair. Repairs covered complete-plan activity adjacency, stale layout/cache pruning, hidden-pane cleanup, visible-first evidence, selection indexing, semantic default folds, off-window navigation, independent Workbench ownership, real publication and native-node counts, and retained-callback observer release. Final reviewers found no Stage 5.2 blocker.

Stage 5.2 satisfies its bounded mounting and native-measurement exit criteria across the recorded scaling range. Overall Stage 5 acceptance remains open: estimate correction and anchor stability, fully indexed off-window semantics, bounded follow/reconciliation work, and stable render sub-block production for oversized individual Markdown, command, and diff items remain later ledger slices.

### Stage 5.3 — estimate correction and anchor stability

Implementation commit: `97f163f` (`feat: correct transcript window estimates atomically`). The runtime now accepts native measurement as an immutable transaction across the height index, planned window, and window-local geometry. The direct no-policy runtime remains the complete pass-through reference.

#### Atomic correction and logical anchoring

- The runtime validates the complete batch, freezes every accepted block geometry, path-copies measured height replacements, replans from the resulting index, composes only the resulting materialized window, and installs the frame/index pair before notifying listeners. A stale or mixed-invalid batch cannot leak a partial height replacement.
- Detailed point geometry is retained only for the current window. Global `firstRow`, `totalRows`, and spacer conservation still describe the complete plan, while row lookup scans only the materialized detailed range.
- Detached planning carries the measured block-local row of the logical point into the height-index query. Reflow above, inside, or below a nonzero-offset anchor restores that point to its semantic `preferredScreenRow`; logical positions never become block keys or terminal coordinates.
- Manual scrolling captures and publishes the new top logical point before dirty native reflow may report height correction. Runtime-backed restoration waits when the target has not yet remounted instead of jumping to a native root fallback.
- Width/style resets rebuild estimates in a new geometry generation, and fold changes discard incompatible measured heights. Equal-height native revisions still publish changed point geometry once; their scheduler acknowledgement is a strict no-op.
- The application no longer emits a competing cursor-derived `viewport.scroll` transaction after physical scrolling. The layout bridge is the sole owner of translating a mounted top-visible point into the semantic viewport anchor.

#### Deterministic correction scaling

The runtime correction cell changes one one-row tail block to four rows. Operation counts are identical at every requested size; timings are machine-specific diagnostic samples from the reviewed run.

| Complete blocks | Mounted before / after | Geometry blocks composed / retained detail | Accepted / changed heights | Publications / stale replay | Total-row delta | Correction time |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 48 / 45 | 45 / 1 | 1 / 1 | 1 / 0 | +3 | 0.181 ms |
| 1k | 48 / 45 | 45 / 1 | 1 / 1 | 1 / 0 | +3 | 0.110 ms |
| 10k | 48 / 45 | 45 / 1 | 1 / 1 | 1 / 0 | +3 | 0.107 ms |
| 100k | 48 / 45 | 45 / 1 | 1 / 1 | 1 / 0 | +3 | 0.172 ms |

At 80×24, cold native measurement starts with 48 mounted roots, accepts 48 height corrections, then replans to 24 materialized blocks and retains 24 detailed geometry records. Follow-tail damage remains bounded to the current window, and detached hidden tail changes publish, commit, mount, and unmount zero work. The 100-block viewport matrix passed at 48×18, 80×24, and 140×40. The wide detached case required two bounded acknowledgement passes after correction; it settled with zero pending measurements, 66 attempts across 89 mounted roots, and zero hidden publications.

#### Connected input boundary

The connected input cell includes Workbench dispatch, runtime and presentation publication, React, native roots, measurement, and final frame settlement. Counts remain identical across the complete scaling range.

| Complete blocks | Materialized / mounted / measured | Runtime / presentation publications | Native descendants before / after + spacers | Dispatch / final settlement | Result |
|---:|---:|---:|---:|---:|---|
| 100 | 25 / 25 / 25 | 2 / 1 | 72 / 139 + 2 | 69.884 / 108.604 ms | Passed |
| 1k | 25 / 25 / 25 | 2 / 1 | 72 / 139 + 2 | 71.178 / 112.186 ms | Passed |
| 10k | 25 / 25 / 25 | 2 / 1 | 72 / 139 + 2 | 101.209 / 140.014 ms | Passed |
| 100k | 25 / 25 / 25 | 2 / 1 | 72 / 139 + 2 | 414.586 / 481.704 ms | Passed |

The increasing dispatch curve and 100k memory remain diagnostic evidence of complete semantic construction and total-plan reconciliation, not mounted or measured growth. Those total-size paths remain explicit later-slice debt.

#### Repository, PTY, benchmark, and review gates

- Focused typecheck, dependency-boundary, generated-doc, transcript, controller, App, and renderer gates passed: 310 passed, 5 intentional profiling skips, 0 failed. Additional repair tests cover equal-height convergence, nonzero block-local anchoring, and manual-scroll publication before dirty native correction.
- `bun run check` passed typecheck, boundaries, generated-doc validation, and all non-sandbox-sensitive tests: 692 passed and 5 intentional skips. Its only failure was the sandbox-denied tmux socket.
- The exact isolated rerun outside the sandbox passed: `bun test tests/terminal/terminal.test.ts --test-name-pattern "isolated tmux"` — 1 passed in 711 ms.
- The complete 100/1k/10k/100k runtime, production-native, and connected-input matrices passed, as did the 48×18, 80×24, and 140×40 viewport matrix. `git diff --check` passed.
- Parallel architecture, correctness/geometry, and performance reviews ran after the slice. Repairs clarified pre-/post-correction benchmark counts, allowed bounded multi-pass acknowledgement after window movement, proved equal-height no-op convergence, exercised a nonzero logical anchor, and proved manual-scroll anchoring precedes dirty reflow. Final reviewers found no Stage 5.3 blocker.

Stage 5.3 satisfies its atomic correction, immutability, stale-guard, no-oscillation, and anchor-stability exit criteria. Overall Stage 5 acceptance remains open: canonical reconciliation, reset, and fold rebuild paths still traverse the complete plan; off-window semantic operations retain complete-reference scans until Stage 5.4; and one oversized Markdown, command-output, or diff root remains content-sized until stable production sub-blocks are introduced.

### Stage 5.4a — indexed cursor and message-target materialization

Implementation commit: `a24f5af` (`feat: materialize off-window transcript targets`). This is the first Stage 5.4 vertical slice; Stage 5.4 remains in progress.

#### Target discovery, reveal classification, and physical settlement

- Production cursor boundary motion no longer constructs a complete estimated transcript layout. The UI adapter wraps only the current, adjacent, or requested boundary item, while `buildTranscriptLayout` remains the exhaustive pass-through oracle in tests.
- Message, semantic-block, word, search-adjacency, selection-order, and Workbench message routing reuse the disposable logical-order index. Counted semantic-block motion caches each visited item's segmentation within the operation.
- A detached reveal now distinguishes a point present in the pinned displayed revision from a first appended grapheme, a new document end, a new item, or rewritten content. Retained points replan the window over the pinned complete plan; missing/new points conservatively adopt the latest revision.
- Windowed membership uses the retained height index's item/sub-block ordinals. The measured reveal performs no complete-plan scan or rebuild and no derived-order build. The pass-through runtime retains its linear reference path.
- Stationary `h`/`j`/`k`/`l` motions at an absolute boundary are strict no-ops, so they cannot detach follow or publish an unchanged cursor command.
- Empty semantic items publish a synthetic native anchor only for logical offset zero. This is disposable block-local geometry; source-less activity remains unable to own a logical point.

#### Deterministic target-materialization scaling

The benchmark starts detached at the middle item, appends hidden canonical tail damage, resolves `gg` item-locally, and feeds that exact logical result into runtime reveal. Setup and hidden-damage adoption are excluded from the measured reveal. Counts are identical across the recorded range.

| Complete blocks | Mounted before / after | Wrapped items / transitions | Complete-plan builds / visits | Order-index builds / visits | Publications | Target motion / window publication |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 72 / 48 | 1 / 0 | 0 / 0 | 0 / 0 | 1 | 0.246 / 0.119 ms |
| 1k | 72 / 48 | 1 / 0 | 0 / 0 | 0 / 0 | 1 | 0.033 / 0.077 ms |
| 10k | 72 / 48 | 1 / 0 | 0 / 0 | 0 / 0 | 1 | 0.031 / 0.133 ms |
| 100k | 72 / 48 | 1 / 0 | 0 / 0 | 0 / 0 | 1 | 0.034 / 0.147 ms |

Every cell retains the complete block-plan identity and materializes the motion's exact target. Machine-specific timing is diagnostic; the hard gates are the zero full-plan/order-build counts, one publication, one wrapped item, and bounded mounted work. The existing Stage 5.1 planner proof separately bounds same-item sub-block lookup logarithmically.

#### Repository, PTY, and review gates

- Focused navigation, runtime, scaling, planner, App, layout, and native-measurement verification passed: 108 tests, 6,243 assertions, 0 failures. Typecheck and `git diff --check` passed.
- `bun run check` passed typecheck, boundaries, generated-doc validation, and all non-sandbox-sensitive tests: 698 passed and 5 intentional skips. Its only failure was the sandbox-denied tmux socket.
- The exact isolated rerun outside the sandbox passed: `bun test tests/terminal/terminal.test.ts --test-name-pattern "isolated tmux"` — 1 passed in 718 ms.
- Parallel architecture, correctness, and performance review ran before and after repair. Repairs fixed hidden append-boundary classification, removed the complete-plan reveal scan, added direct rebuild/order-index diagnostics, coupled the motion and reveal targets, suppressed stationary boundary dispatch, and restored empty-item native settlement. Final reviewers signed off with no blocker for this slice.

The claim is intentionally scoped. Search/mark/jump/history/thread routing, spanning selection/copy, fold and URL behavior, and atomic multi-command navigation remain open Stage 5.4 work. Fold/unseen metadata cloning remains size-dependent presentation work, and target wrapping plus changed-item prefix validation remain item-content-proportional until stable production sub-blocks land. Stage 5.4 and overall Stage 5 acceptance therefore remain open.
