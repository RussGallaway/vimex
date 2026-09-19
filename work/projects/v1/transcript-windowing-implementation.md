# Transcript windowing implementation

Status: Stages 5.0–5.4 are complete and verified. Stage 5.5 is in progress; bounded same-item follow, reattachment, canonical ingress, monotonic cross-presentation settlement, hidden-presentation resource suspension, exact structural tail admission, and detached unseen accumulation are complete.

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
| Stage 5d: off-window semantics | Complete | Commits `a24f5af`, `df243a1`, `9266837`, `0e1ad6d`; indexed target materialization and URL motion, bounded selection clipping, canonical cross-window copy, atomic navigation/fold/picker settlement, and evidence below |
| Stage 5e: follow and detachment | In progress | Stage 5.5a commit `9e8974e`, Stage 5.5b commit `e5dfc61`, Stage 5.5c commit `b3d26f9`, Stage 5.5d commit `4189d25`, Stage 5.5e commit `70733dc`, and Stage 5.5f commit `43d9a9b`; bounded same-item canonical ingress, follow/reattach reconciliation, monotonic independent-presentation settlement, hidden-presentation resource suspension, exact structural tail admission, detached unseen accumulation, and evidence below |
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
- [x] Materialize search, mark, jump, history, and thread-navigation targets.
- [x] Render selections whose logical endpoints span unmounted blocks.
- [x] Copy source and rendered text across unmounted blocks from canonical projections.
- [x] Preserve folds and URL navigation across window changes.
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
- [x] Keep hidden or maximized-away panes free of mounting and measurement work.
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

The 5.4a claim is intentionally scoped. At this checkpoint, search/mark/jump/history/thread routing, spanning selection/copy, fold and URL behavior, and atomic multi-command navigation remained open Stage 5.4 work. Fold/unseen metadata cloning remained size-dependent presentation work, and target wrapping plus changed-item prefix validation remained item-content-proportional until stable production sub-blocks land.

### Stage 5.4b — spanning selection, bounded native clipping, and canonical copy

Implementation commit: `df243a1` (`feat: clip off-window transcript selections`). This is the second Stage 5.4 vertical slice; Stage 5.4 remains in progress.

#### Semantic authority and bounded presentation work

- `TranscriptState.selection` remains the complete semantic range. Native OpenTUI selection is a disposable clipping of that range to the current materialized geometry; it never determines selection meaning or copy payloads.
- `selection.swap` changes the semantic endpoints, cursor, preferred row, and viewport anchor atomically. Workbench classifies the command as one reveal, so an off-window head produces one coherent runtime publication and bounded window replacement.
- Source and plain copy continue to read canonical projections. Integration coverage spans 91 logical items with Markdown-differentiated payloads while intermediate native blocks remain unmounted.
- Native clipping traverses only materialized blocks and visible row offsets, preserves reverse selection direction, and maps folded interiors plus empty final sentinels without expanding hidden text.
- The status selection count uses a disposable persistent text-length tree keyed by projection and order identity. Incremental projection changes path-copy one leaf; full construction remains the correct cold/rebuild reference.
- Runtime frame, measured layout, and native selection are applied coherently. Stable frames reuse the native selection, while root or selectable-child remounts invalidate it. Transient out-of-root geometry is rejected and retried at most eight times before a stable no-work state; a later native dirty event can retry normally.
- Newly materialized target windows are prepositioned with half-open nonfinal sub-block ownership and final-sentinel ownership before exact geometry restoration, preventing an intermediate wrong-window selection frame.

#### Deterministic selection scaling

The warm selection-index probe updates one selected endpoint and counts a fixed semantic range at every fixture size. Native clipping uses a 48-block materialized window; the 100k reverse-selection proof visits only the three mounted blocks and three mapped points needed by its viewport. Timings are diagnostic; operation counts are the hard gate.

| Complete blocks | Mounted blocks | Index builds / item visits / updates | Query cache hits / node visits | Semantic count | Diagnostic query |
|---:|---:|---:|---:|---:|---:|
| 100 | 48 | 0 / 0 / 1 | 1 / 7 | 62 | 0.0066 ms |
| 1k | 48 | 0 / 0 / 1 | 1 / 9 | 62 | 0.0052 ms |
| 10k | 48 | 0 / 0 / 1 | 1 / 12 | 62 | 0.0086 ms |
| 100k | 48 | 0 / 0 / 1 | 1 / 14 | 62 | 0.0197 ms |

The recorded production benchmark also keeps target materialization at 48 mounted blocks and height correction at 45 composed blocks from 100 through 100k, with one publication and zero complete-plan/order-index scans for the detached reveal workload. Five stable native frames add zero `startSelection` or `updateSelection` calls.

#### Repository, PTY, benchmark, and review gates

- The broad focused gate passed 189 tests and 32,242 assertions with no failures across transcript semantics, runtime scaling, Workbench integration, App, layout, native geometry, and real OpenTUI visual interaction. Typecheck and `git diff --check` passed.
- `bun run check` passed typecheck, dependency boundaries, generated-doc validation, and every non-sandbox-sensitive test: 706 passed and 5 intentional profiling skips. Its only failure was the sandbox-denied tmux socket; all four real PTY cases passed in that run.
- The exact isolated tmux rerun outside the sandbox passed: `bun test tests/terminal/terminal.test.ts --test-name-pattern "isolated tmux"` — 1 passed in 689 ms.
- The 100/1k/10k/100k production benchmark passed with bounded mounted, correction, and publication counts. The 100k unit probes prove bounded native clipping and logarithmic warm selection-count work.
- Parallel architecture, correctness, and performance reviews ran before and after repair. Repairs added order-identity validation, differentiated source/plain integration coverage, bounded transient-measurement retries, same-key native-remount detection, deepest selectable-target liveness checks, folded-boundary clipping, and stable-frame no-op verification. Final reviewers signed off with no blocker for this slice.

The claim remains scoped. Copy must remain proportional to the requested output size. Non-folded clipping within one oversized render root remains proportional to that root until stable production sub-blocks land. Search/mark/jump/history/thread routing, fold and URL behavior, fold/unseen metadata cloning, complete rebuild/append paths, and oversized Markdown/command/diff production splitting remain open. Stage 5.4 and overall Stage 5 acceptance therefore remain open.

### Stage 5.4c — atomic search, mark, jump, history, and thread target settlement

Implementation commit: `9266837` (`feat: atomically reveal transcript navigation targets`). This is the third Stage 5.4 vertical slice; Stage 5.4 remains in progress.

#### Semantic composition and presentation routing

- Search state plus target jump/unfold, explicit jump plus selection clearing, and interaction mode/focus now reduce as single semantic Workbench transitions. The sequential reducers remain the equivalence reference, and compound transcript tests prove the same final meaning.
- Logical jump locations are validated against the complete semantic order and normalized before comparison, history recording, mark storage, or cursor movement. Oversized offsets clamp before identity comparison; fractional offsets, non-finite rows, missing items, and items absent from the complete order are no-ops.
- `/` and `?` remain in Command mode until the transcript transaction settles. A Visual search atomically clears command input and restores Visual mode while retaining its semantic anchor; Normal/composer search settles to transcript Normal. Real OpenTUI tests cover `/`, `?`, `n`, and `N`.
- Reveal hints carry an exact presentation ID and are accepted only by that presentation runtime. Main and side frames retain independent identity and publication counts; a missing presentation still commits semantic state without misrouting a reveal.
- Cross-thread history restores the saved logical viewport before considering the cursor. Tail restores emit no synthetic cursor reveal, and direct/history thread transitions stage source overlay closure, side visibility, thread selection, target overlay closure, and restored navigation state before one publication.
- Runtime and native geometry remain disposable presentation resources. Target discovery uses complete canonical projections and semantic state; native nodes are never consulted to decide search, mark, jump, history, or thread meaning.

#### Deterministic target-materialization scaling

The generic indexed reveal workload from Stage 5.4a remains the physical settlement proof for search, mark, jump, history, and thread targets after semantic discovery. The latest run retained the complete plan identity, wrapped one target item, and published one bounded window at every scale.

| Complete blocks | Mounted before / after | Wrapped items / transitions | Complete-plan builds / visits | Order-index builds / visits | Publications | Target motion / window publication |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 72 / 48 | 1 / 0 | 0 / 0 | 0 / 0 | 1 | 0.260 / 0.128 ms |
| 1k | 72 / 48 | 1 / 0 | 0 / 0 | 0 / 0 | 1 | 0.030 / 0.075 ms |
| 10k | 72 / 48 | 1 / 0 | 0 / 0 | 0 / 0 | 1 | 0.031 / 0.141 ms |
| 100k | 72 / 48 | 1 / 0 | 0 / 0 | 0 / 0 | 1 | 0.030 / 0.134 ms |

The Workbench composition fixture is deliberately separate from that scaling proof. With 100 semantic items, an off-window search and a loaded cross-thread history restore each produce exactly one authoritative-state, one affected runtime, and one affected-pane publication; mark and explicit jump each produce one state and one runtime publication. Side-target reveals publish only the side runtime, preserve the main frame identity, and the inverse holds for main-target reveals.

Search discovery itself still scans complete canonical text and grows with the number of graphemes and matches. This slice does not claim otherwise: the normative Stage 4 ledger explicitly defers indexed search until search cost becomes size-dependent. Folded-target settlement also still rebuilds complete fold geometry/index state. Both costs are excluded from the non-folded post-discovery materialization claim and remain visible work for later slices rather than being hidden by timing results.

#### Repository, PTY, benchmark, and review gates

- The final focused matrix passed 221 tests and 1,591 assertions with no failures across transcript semantics/navigation/scaling, Workbench, controller integration, App, command-line input, and real OpenTUI Visual interaction. Typecheck and `git diff --check` passed.
- `bun run check` passed typecheck, dependency boundaries, generated-doc validation, and every non-sandbox-sensitive test: 713 passed and 5 intentional profiling skips. Its only failure was the sandbox-denied tmux socket.
- The full terminal rerun outside the sandbox passed all five PTY/tmux cases, including isolated tmux.
- The 100/1k/10k/100k production benchmark retained fixed mounted, measurement, and publication counts. Machine timings remain diagnostic; the hard gates are 72-to-48 mounted blocks, one publication, one wrapped item, retained complete-plan identity, and zero complete-plan/order-index builds or visits.
- Parallel architecture, correctness, and performance reviews ran before and after repair. Repairs normalized invalid and clamped locations, eliminated redundant fold/focus publications, routed reveals to exact presentations, staged history/thread state atomically, preferred restored viewports over stale cursors, preserved follow-tail restoration, added authoritative publication counts, and fixed real Visual search command-state cleanup. Final reviewers signed off with no blocker.

The claim remains scoped to non-folded target settlement after semantic discovery. Fold and URL preservation, complete fold rebuild work, fold/unseen metadata cloning, complete reconciliation across lineage changes, and production sub-blocks for oversized Markdown, command output, and diffs remain open. Stage 5.4 and overall Stage 5 acceptance therefore remain open.

### Stage 5.4d — persistent folds, indexed URLs, and owned picker settlement

Implementation commit: `0e1ad6d` (`feat: preserve off-window folds and URLs`). This is the final Stage 5.4 vertical slice; all Stage 5.4 exit criteria pass.

#### Semantic authority and disposable indexes

- `TranscriptState.folded` remains the semantic fold authority and retains its record-shaped public contract. Its implementation is now an immutable persistent AVL-backed record: one explicit fold update path-copies logarithmically, preserves untouched identity, enumerates and serializes as ordinary record data, and accepts opaque item IDs under one locale-independent total ordering. Persisted and forked folds are filtered to known foldable semantic items; explicit `false` remains meaningful.
- Default reasoning/tool fold policy is semantic state. A new reasoning/tool item consumes the configured policy in the same projection transaction that admits it, so admission no longer waits for a React effect or produces a second fold publication. Forks inherit the policy and explicit choices. Bulk default/fold-all operations intentionally remain complete semantic-output operations.
- URL rank/select is a disposable persistent count index keyed by semantic order/projection identity. Warm motion performs logarithmic prefix/select work without visiting unrelated transcript items. Incremental projection updates inherit the index; exhaustive `urlCandidatesReference` and `moveByUrlReference` implementations remain the correctness oracles.
- Candidate enumeration is proportional to the requested picker output, not unrelated history. Picker choice uses a controller-owned disposable identity/URL index plus exact semantic-scope validation, avoiding re-enumeration. Current-item and selection candidates remain logical projection ranges; native nodes are never consulted.

#### Atomic routing, folds, and native work

- URL motion, search/jump unfolds, and non-history cursor reveals reduce fold and logical target changes together. Fold-plus-view damage retains its exact fold IDs, one measured height replacement path-copies the height index, and unsupported or future multi-sub-block relationships fall back to the complete rebuild reference.
- A fold update composes only the current and resulting bounded windows. Complete-plan identity is retained, complete geometry is not recomposed, and OpenTUI schedules fold measurement only for affected materialized item keys.
- URL picker state owns its exact thread, presentation, displayed canonical revision, and semantic scope. Open, choose, cancel, thread switch, history navigation, restart, and fork transitions clear or replace picker state and overlay atomically. A stale candidate cannot open after same-revision cursor/selection movement or presentation changes.
- Main and side runtimes remain independent. Fold/URL target settlement produces one authoritative-state publication and one addressed runtime publication with zero redundant main/side pane publications; picker open and choose each produce one owning-pane publication and no runtime publication.

#### Deterministic fold and URL scaling

The production-window workload primes URL and height indexes outside the timed operation, seeds a real eight-row unfolded native measurement, moves the fold target outside the mounted window, then combines a one-row fold with an explicit URL reveal. Tests hard-gate that the target is absent before and materialized afterward. Timings are diagnostic; operation counts and identity are the acceptance gates.

| Complete blocks | Mounted before / after | URL builds / item visits / node visits | Height builds / block visits / visits=copies | Complete / window geometry visits | Publications | URL motion / fold publication |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 67 / 55 | 0 / 0 / 24 | 0 / 0 / 8=8 | 0 / 122 | 1 | 0.122 / 0.198 ms |
| 1k | 72 / 72 | 0 / 0 / 43 | 0 / 0 / 11=11 | 0 / 144 | 1 | 0.014 / 0.141 ms |
| 10k | 72 / 72 | 0 / 0 / 54 | 0 / 0 / 15=15 | 0 / 144 | 1 | 0.017 / 0.277 ms |
| 100k | 72 / 72 | 0 / 0 / 67 | 0 / 0 / 18=18 | 0 / 144 | 1 | 0.042 / 0.284 ms |

Every scale retained complete-plan identity, performed one height-index update, built no complete plan or height index, visited no complete-plan blocks, composed no complete geometry, and published once. Mounted work stayed at or below 72 blocks; geometry work stayed at or below two bounded 72-block compositions. URL and height-tree work grew logarithmically rather than with total transcript size.

#### Repository, PTY, and review gates

- The final focused matrix passed 203 tests and 31,407 assertions with no failures across transcript semantics/navigation/scaling, Workbench/publications, controller/local-state integration, App, fold layout, and the rendered-layout scheduler. Typecheck and `git diff --check` passed.
- `bun run check` passed typecheck, dependency boundaries, generated-doc validation, and every non-sandbox-sensitive test: 718 passed and 5 intentional profiling skips. Its only failure was the sandbox-denied isolated tmux socket; the other four real PTY cases passed in that run.
- The complete terminal rerun outside the sandbox passed all five PTY/tmux cases. The isolated tmux case completed in 695 ms.
- The executable 100/1k/10k/100k benchmark passed all identity, publication, logarithmic-index, absent-before/present-after, and bounded-window assertions shown above.
- Parallel architecture, correctness, and performance reviews ran before implementation and again after the slice. Repairs unified opaque fold-key ordering; filtered invalid restored/forked folds; inherited fork defaults; preserved fold damage through reveals; made non-history cursor unfolds atomic; scheduled native fold measurements explicitly; fixed inclusive/reverse URL-selection boundaries; guarded stale current-item cursors; eliminated picker Enter/cancel/navigation double publications; added exact picker owner/scope validation and bounded membership lookup; and replaced the degenerate fold benchmark with a real measured height change. Final reviewers signed off with no blocker.

Stage 5.4 is complete: semantic results retain exhaustive pass-through references, no target discovery depends on a native node, and explicit off-window materialization settles as one user-visible transition. Overall Stage 5 remains open. Search discovery, complete append/lineage reconciliation, persistence/global-fold enumeration, and individual-item URL/text work remain proportional to their semantic input or output; stable production sub-blocks for oversized Markdown, command output, and diffs remain required before the final Stage 5 acceptance claim.

### Stage 5.5a — bounded same-item follow and reattachment

Implementation commit: `9e8974e` (`perf: bound transcript tail reconciliation`). This slice closes the historical-size cost in production reconciliation when an existing tail item changes. Structural tail insertion, canonical conversation ingress, hidden-pane native suspension, and combined multi-presentation settlement remain later Stage 5.5 work.

#### Persistent presentation structures and guarded fallback

- Windowed runtimes now represent the complete lightweight block plan as an immutable persistent indexed facade. A stable-key root-block replacement validates the prior slot and path-copies one balanced-tree path. The published old plan remains unchanged and ordinary array indexing, iteration, slicing, mapping, concatenation, reflection, and JSON behavior remain compatible.
- Replacement lineage is private runtime data. The height index rebinds only when the new plan proves it is the exact immediate one-slot successor of the indexed plan, the item block remains a stable `root`, and the item owns exactly one indexed ordinal. Unrelated, reordered, duplicate, missing, or future multi-sub-block relationships reject the fast path and retain the complete rebuild fallback.
- Projection records use an immutable persistent AVL-backed `Record` representation. Existing-item projection replacement path-copies logarithmically while preserving ordinary record enumeration, serialization, numeric-property ordering, special opaque keys, and untouched projection identity.
- A changed block invalidates only its old measured height and detailed geometry. The height index binds to the new plan with one logarithmic point update; planning materializes one bounded trailing slice; geometry composes only that window.
- The pass-through reference remains deliberately distinct: `createTranscriptFrame` and a no-policy runtime retain the simple frozen dense block array and complete geometry path. Windowed full rebuilds normalize into the persistent plan only after choosing the production policy.

#### Deterministic follow and reattachment scaling

The executable production-runtime cell starts from an already constructed canonical fixture and windowed runtime. It measures one existing tail-item delta, then detaches, accepts one hidden tail delta with zero publication, and reattaches to the latest tail. Canonical snapshot construction, cold persistent-plan normalization, and the deliberate full-rebuild fallback are outside this timing boundary and are named in the benchmark output.

| Complete blocks | Mounted after follow / reattach | Projection visits=copies | Block validation+update visits / copies | Height visits / copies | Window slice / geometry visits | Follow / hidden / reattach publications | Follow / reattach |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 48 / 48 | 6=6 | 16 / 8 | 8 / 0 | 48 / 48 | 1 / 0 / 1 | 0.264 / 0.145 ms |
| 1k | 48 / 48 | 9=9 | 22 / 11 | 11 / 0 | 48 / 48 | 1 / 0 / 1 | 0.116 / 0.090 ms |
| 10k | 48 / 48 | 13=13 | 30 / 15 | 15 / 0 | 48 / 48 | 1 / 0 / 1 | 0.147 / 0.106 ms |
| 100k | 48 / 48 | 16=16 | 36 / 18 | 18 / 0 | 48 / 48 | 1 / 0 / 1 | 0.243 / 0.170 ms |

Every cell builds exactly one changed item, performs one projection update, one block-plan update, and one height-index update for follow and again for reattachment. Complete-plan builds and visits, height-index builds and complete block visits, and complete-geometry visits are all zero. The latest displayed canonical revision and trailing window publish together once; a measurement batch captured before reattachment is a strict no-op afterward. Timings are diagnostic; logarithmic update paths, fixed 48-block slices, identity preservation, zero hidden publication, and one coherent reattachment publication are the hard gates.

#### Repository, PTY, benchmark, and review gates

- Focused transcript, planner, height-index, runtime, scaling, controller, and side-chat verification passed. The final repaired core matrix passed 79 tests and 5,685 assertions; an independent correctness rerun passed 90 tests and 5,724 assertions. Typecheck and `git diff --check` passed.
- `bun run check` passed typecheck, dependency boundaries, generated-doc validation, and every non-sandbox-sensitive test: 724 passed and 5 intentional profiling skips. Its only failure was the sandbox-denied isolated tmux socket; the other four real PTY cases passed in that run.
- The complete terminal rerun outside the sandbox passed all five PTY/tmux cases; isolated tmux completed in 695 ms.
- The executable 100/1k/10k/100k benchmark passed all publication, identity, complete-work-zero, logarithmic-update, and bounded-window assertions shown above.
- Parallel architecture, correctness, and performance reviews ran before implementation and after the initial slice. The repair round restored the distinct dense reference, hardened proxy reflection and integrity operations, added exact replacement-lineage proof, rejected future sub-block ambiguity, counted complete geometry at its real boundary, separated point-update work from bounded window slicing, observed hidden publications instead of printing a literal, and made AVL allocation/bounds evidence truthful. All three final reviewers signed off with no blocker.

Stage 5.5a is complete for the explicitly scoped production runtime boundary. It does not claim bounded canonical ingress: `ConversationState.items` still uses a complete record copy for a delta, and changed individual Markdown/tool content is still projected as one content-sized item. New tail items and turn-activity structure still select the full rebuild, and hidden/maximized panes still retain React/native resources. Those remain required before Stage 5.5 or overall Stage 5 can be marked complete.

### Stage 5.5b — bounded canonical same-item ingress

Implementation commit: `e5dfc61` (`perf: bound canonical transcript ingress`). This slice closes the historical-size copy in the canonical `item.delta` path and measures one real steady-state tail delta from canonical reduction through semantic projection/index inheritance and production runtime publication. Structural tail insertion, detached unseen-item accumulation, hidden-pane native suspension, and oversized-item production sub-blocks remain later slices.

#### Canonical authority, compatibility, and fallback

- `ConversationState.items` remains the sole canonical item authority. Its record-shaped representation is now an immutable persistent AVL: one item replacement path-copies one logarithmic path while the previous state and every unrelated item identity remain unchanged. This is a representation of canonical state, not a second transcript store or presentation cache.
- Plain/restored records normalize lazily on the first real mutation. Wrong-thread, missing-item, and terminal-item deltas retain exact state identity and perform no normalization. Forked conversations normalize before publication so their first later delta does not pay an unexpected complete copy.
- The public `Readonly<Record<string, ConversationItem>>` behavior preserves ordinary numeric-key ordering followed by named-key insertion order, `Object.keys`/entries/values, spread, JSON, own descriptors, and opaque IDs including `__proto__`, `constructor`, and `toString`. Mutation, prototype, and integrity operations are rejected without poisoning later reads.
- `reduceConversation` retains its exact two-argument shape and remains safe as an `Array.reduce` callback. The separately named diagnostic reducer cannot accidentally receive an array index as counters. A dense full-copy writer behind the shared semantic reducer remains the equivalence oracle.
- Both scheduled ingress and direct conversation dispatch share one damage predicate. Existing-item completion uses bounded block damage only when the pre-event item, item turn, turn record, and turn membership prove chronology is unchanged. Missing, unlinked, or cross-turn relationships select the exact full-rebuild fallback.
- Semantic text-length, URL-count, and logical-order indexes are primed on the exact input snapshot outside measured steady state and inherit through the projection update. Diagnostics are attached at their actual build and update boundaries, so a lost cache would fail deterministic zero-build/item-visit assertions instead of hiding in a timing curve.

#### Deterministic canonical-ingress scaling

The production cell applies one identical running-tail `item.delta` at 100, 1k, 10k, and 100k render blocks. It times canonical reduction, the Workbench-style changed-item lookup, semantic projection, and runtime reconciliation separately. Bulk fixture construction, cold persistent normalization, disposable-index priming, the dense oracle, JSON equivalence, and exhaustive `N - 1` identity checks are explicitly outside timing.

| Complete blocks | Mounted / publications | Canonical lookup visits (2 lookups) | Canonical update visits=copies | Semantic projection visits=copies | Text / URL builds, item visits, updates, path visits | Runtime complete-plan / height-build / complete-geometry visits | Window slice / geometry visits | Complete ingress settlement |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 48 / 1 | 12 | 6=6 | 6=6 | 0,0,1,8 / 0,0,1,8 | 0 / 0 / 0 | 48 / 48 | 1.336 ms |
| 1k | 48 / 1 | 18 | 9=9 | 9=9 | 0,0,1,11 / 0,0,1,11 | 0 / 0 / 0 | 48 / 48 | 0.234 ms |
| 10k | 48 / 1 | 26 | 13=13 | 13=13 | 0,0,1,15 / 0,0,1,15 | 0 / 0 / 0 | 48 / 48 | 0.381 ms |
| 100k | 48 / 1 | 32 | 16=16 | 16=16 | 0,0,1,18 / 0,0,1,18 | 0 / 0 / 0 | 48 / 48 | 0.520 ms |

Every cell preserves `N - 1` canonical item identities and `N - 1` semantic projection identities. Canonical and semantic record work follows logarithmic paths; text-length and URL indexes perform one logarithmic update each with zero builds and zero complete item visits. The runtime then performs the already verified one projection, block-plan, and height-index update, composes exactly 48 window blocks, and publishes once. Timings are diagnostic curves; identity, semantic equivalence, zero complete work, logarithmic paths, and fixed mounted/window work are the gates.

#### Repository, PTY, benchmark, and review gates

- The broad focused matrix passed 273 tests and 21,330 assertions across conversation, testkit, transcript, Workbench, controller, and side-chat integration. Additional deterministic coverage exercises a 10k monotonic insertion lineage, first/middle/last replacements, dense-reducer equivalence, ordinary reflection and special keys, old-snapshot identity, failed integrity operations, lazy normalization, fork isolation, and exact damage fallback.
- `bun run check` passed typecheck, dependency boundaries, generated-doc validation, and every non-sandbox-sensitive test: 731 passed and 5 intentional profiling skips. Its only failure was the sandbox-denied isolated tmux socket; the other four real PTY cases passed.
- The exact isolated rerun outside the sandbox passed: `bun test tests/terminal/terminal.test.ts --test-name-pattern "isolated tmux"` — 1 passed in 785 ms.
- The executable 100/1k/10k/100k benchmark passed every canonical-update, semantic-index, identity, publication, complete-work-zero, and bounded-window assertion shown above. `git diff --check` passed.
- Parallel architecture, correctness, and performance reviews ran before implementation and after the slice. Repairs preserved named-key insertion order, separated the diagnostic reducer from `Array.reduce`, made lookup and cold-normalization counters truthful, moved exhaustive evidence after measured settlement, added sequential-AVL evidence, and forced ambiguous completion chronology to the full fallback. All three final reviewers signed off with no blocker.

Stage 5.5b is complete for steady same-item follow-tail ingress. It removes total-history record copies from canonical reduction and makes the complete reducer → semantic projection → runtime publication boundary executable at every required scale. It does not claim constant changed-item parsing: Markdown/tool projection remains proportional to that item's own content. Detached `unseenItemIds` membership/copy, new item and turn structure, hidden/maximized pane resources, cross-presentation reentrancy, and stable production sub-blocks for oversized Markdown, command output, and diffs remain open before Stage 5.5 and overall Stage 5 can be marked complete.

### Stage 5.5c — monotonic cross-presentation settlement

Implementation commit: `b3d26f9` (`fix: serialize transcript presentation sync`). This prerequisite slice closes a correctness defect at the Workbench/runtime publication boundary before structural tail reconciliation changes that boundary further.

#### Restartable presentation synchronization

- A Workbench state commit synchronizes presentation runtimes synchronously. Runtime listeners are also synchronous and may legitimately dispatch a newer Workbench command while an older main/side synchronization pass is still iterating.
- The controller now owns a monotonic synchronization epoch. Every newer authoritative synchronization restarts from the first owned presentation. An older pass checks its captured epoch before and after each runtime update and stops immediately when a nested pass supersedes it.
- Canonical conversation and semantic `TranscriptState` remain the only authorities. The epoch neither queues another semantic state nor moves presentation ownership into React; it only prevents captured older inputs from reaching later runtimes after a newer state is already authoritative.
- The epoch guard itself adds only constant work per visited presentation. Calls carrying bounded damage hints or no canonical change remain one pass over the owned presentations; structural events may still pay the pre-existing history-sized canonical-damage derivation before each runtime update. Reentrant guard work is bounded by the number of presentations and actual synchronous nesting depth.
- Runtime creation, deletion, disposal, and independent window/geometry ownership are unchanged. A runtime created without a state change starts from current authority; every state-changing ownership transition starts a newer epoch and invalidates an older pass.

#### Exact regression and gates

The public-controller regression constructs main then side runtimes, starts a main canonical update, and dispatches a side cursor reveal from the main runtime's publication listener. Before this repair the stale outer pass subsequently reattached side to its captured follow-tail input, producing two side publications and leaving the authoritative side viewport detached while the presented frame was follow-tail. The repaired path has these deterministic gates:

- the triggering main delta remains present;
- the authoritative side viewport and runtime frame are the same logical point;
- the side frame remains detached and materializes the target;
- side publishes exactly once;
- no transcript-history scan, plan rebuild, or native work is added by synchronization.

Independent adversarial review also exercised direct and batched outer changes, two-level main→side→main listener reentrancy, a batch that changed both canonical threads, and a nested structural side admission. Every final frame matched authority; the addressed side published once and retained its latest canonical revision.

#### Repository, PTY, and review gates

- The focused controller integration suite passed 77 tests and 439 assertions. The independent correctness matrix passed 109 controller/runtime/scaling tests, including the adversarial nested cases. Typecheck and `git diff --check` passed.
- `bun run check` passed typecheck, dependency boundaries, generated-doc validation, and every non-sandbox-sensitive test: 732 passed and 5 intentional profiling skips. Its only failure was the sandbox-denied isolated tmux socket; the other four real PTY cases passed.
- The exact isolated rerun outside the sandbox passed: `bun test tests/terminal/terminal.test.ts --test-name-pattern "isolated tmux" --timeout 30000` — 1 passed in 727 ms.
- Parallel architecture, correctness, and performance reviews signed off. They verified restart behavior across Map mutation and disposal, exact final authority/frame agreement under nested direct and batched updates, and constant guard overhead per visited presentation without adding a new history-sized path.

Stage 5.5c is complete for monotonic multi-presentation runtime settlement. Structural tail insertion, detached unseen-item accumulation, hidden/maximized pane resource suspension, and stable production sub-blocks for oversized Markdown, command output, and diffs remain open before Stage 5.5 and overall Stage 5 can be marked complete.

### Stage 5.5d — hidden-presentation resource suspension

Implementation commit: `4189d25` (`perf: suspend hidden transcript presentations`). This slice makes maximized-away and closed-but-retained presentations own no React transcript publication, native transcript tree, renderer frame listener, or geometry-measurement work while preserving their semantic authority and recoverable Workbench runtime.

#### Visibility boundary and recoverable resources

- Workbench still owns every presentation snapshot and `TranscriptRuntime`. Hiding a pane does not dispose, replace, or fork either authority; it only suspends the React subscriptions that publish them into that pane.
- The presentation and runtime hooks retain their last visible snapshots while hidden, including across unrelated parent renders. The first reveal render synchronously reads the newest Workbench snapshots, so no stale intermediate frame is published and no hidden update must be replayed through React.
- The transcript viewport is unmounted while hidden, but the pane application and composer remain mounted. Drafts, Vim mode, Ex history, focus-local state, and native composer selection therefore retain their existing ownership and identity.
- Visibility gates every transcript-owned frame effect: measurement scheduling, cursor placement, native selection, point-scroll restoration, and expanded-composer frame measurement. Departing transcript roots release their measurement schedule and all renderer-side layout and geometry caches.
- Native transcript selection is explicitly cleared before its native nodes disappear. The canonical semantic selection remains in `TranscriptState`; reveal reconstructs the native clipped selection from that authority.
- Reveal restores the presentation's own follow-tail position or detached logical point and preferred screen row. Main and side panes continue to own independent visibility, frames, windows, anchors, and geometry.

#### Deterministic hidden-resource scaling

The production probe mounts the real presentation snapshot hook, runtime hook, layout hook, and `TranscriptViewport`. Its visible setup proves the bridge is live with one presentation subscription, one UI runtime subscription, one renderer `FRAME` listener, and accepted measurement reports. It then hides the pane, publishes both a retained-runtime tail update and a presentation update, forces renderer settlement, and reveals the pane at the latest revision.

| Complete blocks | Mounted before / hidden / after | Hidden transcript / spacer roots | Hidden `FRAME` listeners / measurement reports | Hidden presentation / UI runtime subscriptions | Hidden presentation notifications / React commits / renders | Retained runtime publications | Latest revision on reveal | Publication + forced-flush settlement |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 24 / 0 / 24 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 / 0 | 1 | 1 | 33.019 ms |
| 1k | 24 / 0 / 24 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 / 0 | 1 | 1 | 33.839 ms |
| 10k | 24 / 0 / 24 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 / 0 | 1 | 1 | 37.008 ms |
| 100k | 24 / 0 / 24 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 / 0 | 1 | 1 | 29.602 ms |

The one retained-runtime publication is intentional cache reconciliation and is observed by a diagnostic listener, not by the hidden UI. Every UI resource and publication count is identically zero across the recorded range, and reveal remounts exactly 24 blocks at the newest canonical revision. The timings include runtime and presentation publication plus forced renderer flushing and are one-sample machine diagnostics; mounted/native/measurement/publication operation counts are the hard gates. The connected controller regression separately proves the Workbench-owned runtime object retains identity across maximize, close, and reveal.

#### Repository, PTY, benchmark, and review gates

- The final focused UI/runtime/layout/selection matrix passed 83 tests and 565 assertions. It proves subscription counts move `1 → 0 → 1`, hidden parent renders retain snapshots, reveal reads the newest snapshots, runtime identity survives maximize/close, native transcript roots and selections are released, semantic selection survives, detached preferred-row restoration is exact, and composer identity/selection remain intact. Typecheck and `git diff --check` passed.
- `bun run check` passed typecheck, dependency boundaries, generated-doc validation, and every non-sandbox-sensitive test: 737 passed and 5 intentional profiling skips. Its only failure was the sandbox-denied isolated tmux socket; the other four real PTY cases passed.
- The exact isolated rerun outside the sandbox passed: `bun test tests/terminal/terminal.test.ts --test-name-pattern "isolated tmux"` — 1 passed in 690 ms.
- The executable 100/1k/10k/100k benchmark passed every mounted-root, subscription, frame-listener, measurement, publication, React-render, identity, and latest-reveal assertion shown above.
- Parallel architecture, correctness, and performance reviews ran after the slice and again after repair. Repairs replaced declarative benchmark literals with a production bridge probe, added real visible measurement and hidden-delta observation, cleared renderer-global native selection before unmount, retained semantic selection for reveal, and explicitly released departed-root caches. All three final reviewers signed off with no blocker.

Stage 5.5d closes hidden/maximized presentation mounting and measurement work across the required scaling range. It deliberately retains the disposable Workbench runtime cache so canonical streaming can reconcile there without keeping presentation/native resources alive. Structural tail insertion, detached unseen-item accumulation, structural canonical-damage derivation, and stable production sub-blocks for oversized Markdown, command output, and diffs remain open before Stage 5.5 and overall Stage 5 can be marked complete.

### Stage 5.5e — bounded structural tail admission

Implementation commit: `70733dc` (`perf: bound structural transcript admission`). This slice bounds the exact production sequence of a new empty `turn.started` followed immediately by the first semantic `item.started` in that final running turn. Turn completion, activity-only structure, detached unseen-item accumulation, and stable production sub-blocks remain later work.

#### Exact persistent append lineage

- Canonical conversation state now carries persistent ordered turn IDs, turn records, and per-turn item IDs. Exact final-turn and final-item appends path-copy only the affected persistent paths while preserving every historical item, turn, and sequence identity. Serialization, lookup, fork, and the complete reference reducer remain semantically equivalent.
- Semantic transcript order, order index, projections, and fold membership expose exact append lineages. The runtime accepts the bounded path only when canonical turn/item lineage, semantic order/projection/fold lineage, mode, presentation, reveal state, exclusions, and damage all prove the supported relationship. Duplicate prior order, tampered projections or folds, ambiguous same-batch chronology, and every unsupported relationship select the correct full rebuild.
- The empty turn advances only displayed canonical revision and publishes once while retaining transcript, complete blocks, window, and geometry by identity. The following semantic item path-copies the complete block plan and height index, appends to the filtered presentation order, preserves all historical block identities, and replans only the bounded follow window.
- Presentation exclusions remain disposable policy, not semantic authority. A disposable exclusion set and normalized persistent filtered order permit an included tail append without rescanning total history; excluded or uncertain changes use the full reference path.
- Disposable text-length and URL indexes append from their already-warm lineage. The first post-admission semantic query performs one index update and no complete index build or item visit.
- Workbench damage derivation emits an exact empty block set for a new turn and the new item ID for an item admitted into the final running turn. Batched damage preserves the empty set, inspects every ID, and proves that a same-batch turn began empty before offering the structural fast path.

#### Deterministic canonical-to-runtime scaling

The structural fixture uses the same one-semantic-item-per-turn workload at 100/1k/10k/100k complete render blocks. Setup bulk construction, cold persistent normalization, disposable-index priming, complete references, and exhaustive identity checks are excluded from timing but remain asserted. The measured boundary contains both canonical reductions, semantic projection, runtime reconciliation, window planning, and two synchronous runtime publications.

| Complete blocks before | Mounted after | Publications | Historical item / turn / projection / block identities preserved | Complete plan / order / height / geometry builds or visits | Plan + height appends | Maximum persistent path work | Text / URL complete builds or visits | Complete two-event settlement |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 48 | 2 | 100 / 100 / 100 / 100 | 0 | 1 / 1 | 8 | 0 / 0 | 1.007 ms |
| 1k | 48 | 2 | 1k / 1k / 1k / 1k | 0 | 1 / 1 | 11 | 0 / 0 | 0.379 ms |
| 10k | 48 | 2 | 10k / 10k / 10k / 10k | 0 | 1 / 1 | 15 | 0 / 0 | 0.572 ms |
| 100k | 48 | 2 | 100k / 100k / 100k / 100k | 0 | 1 / 1 | 18 | 0 / 0 | 1.236 ms |

Every cell also performs one text-length and one URL index append, visits at most 48 window blocks, and equals the complete canonical reducer and pass-through transcript frame. The logarithmic path depth is the only total-size term; mounted work, publications, complete-history work, and historical identity replacement are invariant. Timings are one-sample machine diagnostics, not acceptance thresholds.

#### Production React, native mounting, and measurement boundary

The production probe starts only after the initial runtime, React/OpenTUI tree, and native geometry have fully settled. It then admits the same empty-turn/item sequence through `TranscriptRuntime`, the real runtime hook, `TranscriptViewport`, native roots, and rendered-block measurement. This deliberately measures the presentation boundary rather than claiming controller-driven end-to-end timing.

| Complete blocks before | Mounted roots before → after | Retained / mounted / unmounted roots | Runtime publications | Empty / item React commits | Candidate / attempted / measured blocks | Measurement publications | Item runtime update | Item React Profiler duration | Post-runtime React/native settlement |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 24 → 25 | 24 / 1 / 0 | 2 | 1 / 1 | 1 / 1 / 1 | 1 | 0.186 ms | 0.455 ms | 36.5 ms |
| 1k | 24 → 25 | 24 / 1 / 0 | 2 | 1 / 1 | 1 / 1 / 1 | 1 | 0.268 ms | 0.410 ms | 38.8 ms |
| 10k | 24 → 25 | 24 / 1 / 0 | 2 | 1 / 1 | 1 / 1 / 1 | 1 | 0.225 ms | 0.470 ms | 43.4 ms |
| 100k | 24 → 25 | 24 / 1 / 0 | 2 | 1 / 1 | 1 / 1 / 1 | 1 | 0.719 ms | 0.461 ms | 334.7 ms |

Mounted, retained, publication, commit, candidate, attempted-measurement, accepted-measurement, and measurement-publication counts are identical across the recorded range. Runtime update and React Profiler curves remain bounded. The combined 100k post-runtime settlement rises inside OpenTUI's test-renderer `setup.flush()` despite unchanged native work counts; that machine-specific curve is retained as a diagnostic rather than presented as a flat timing result.

#### Equivalence, fallback, repository, and review gates

- Focused conversation, transcript, Workbench, controller, scaling, React bridge, native mounting, and geometry tests passed: 196 tests, 21,672 assertions. They cover direct and same-batch structural admission; defaults and exclusions; historical projection/fold tampering; duplicate order; mode, detached, reveal, and presentation ambiguity; warm disposable indexes; historical identity; and complete pass-through semantic equivalence.
- The controller integration proves the ordinary ingress sequence reaches the exact damage contracts. Ordinary non-delta ingress flushes each semantic boundary, so the combined turn/item fast path is additionally exercised directly at the runtime contract.
- `bun run check` passed typecheck, dependency boundaries, generated-doc validation, and every non-sandbox-sensitive test: 758 passed and 5 intentional profiling skips. Its only failure was the sandbox-denied isolated tmux socket; the other four real PTY cases passed. The exact host-level rerun passed: `bun test tests/terminal/terminal.test.ts --test-name-pattern "isolated tmux"` — 1 passed in 695 ms. `git diff --check` passed.
- The executable core and native 100/1k/10k/100k benchmarks passed every semantic-equivalence, identity-preservation, full-work-zero, bounded-window, native-root, React-commit, and measurement-count assertion shown above.
- Parallel architecture, correctness, and performance reviews ran throughout the slice and after repairs. Repairs closed mode crossing, exclusions, exact projection/fold lineage, duplicate-order rejection, reveal/presentation ambiguity, same-batch empty-turn proof, cold derived-presentation normalization, warm derived indexes, and native seed-settlement gaps. All three final reviewers signed off with no blocker.

Stage 5.5e is complete for exact empty-turn plus first-item structural tail admission. Completion/activity changes, detached unseen accumulation, and stable production sub-blocks for oversized Markdown, command output, and diffs remain open before Stage 5.5 and overall Stage 5 can be marked complete.

### Stage 5.5f — bounded detached unseen accumulation

Implementation commit: `43d9a9b` (`perf: bound detached unseen accumulation`). This slice removes total-history work from steady detached unseen tracking, private hidden-damage accumulation, and side-child inherited-turn membership. It also proves the status-only Workbench publication boundary through React, native-root retention, and OpenTUI measurement. Multi-item structural catch-up remains a correct full-build fallback; completion/activity structure and stable production sub-blocks remain later work.

#### Semantic authority and disposable cache ownership

- `TranscriptState.unseenItemIds` remains the semantic authority and preserves ordinary readonly-array iteration, reflection, JSON, duplicates, opaque IDs, and persisted plain-array compatibility. Its persistent sequence and membership index path-copy only the append path; repeat deltas retain the exact unseen-sequence identity.
- `TranscriptRuntime` owns a private per-presentation `HiddenDamageAccumulator`. It visits only incoming changed IDs, preserves the public damage precedence and ordered uniqueness of the full reference, materializes an ID array only at a missing-target reveal or reattachment, and resets on every rebuild. No semantic meaning moved into the runtime cache.
- Follow and detached runtimes therefore retain independent hidden-damage state. A retained-point reveal keeps the pinned complete plan and semantic unseen sequence; invalid reveals remain frozen; missing targets and reattachment adopt the latest canonical input through the existing rebuild/reference boundary.
- Side-chat inherited turn IDs remain Workbench semantic state. Local restore, fork completion, and hydration normalize them to the persistent array-compatible sequence; live child projection uses indexed membership instead of scanning inherited parent history.
- The React/OpenTUI measurement observer is an optional diagnostic sink. It observes completed scheduler passes but owns no UI state, geometry, runtime input, or publication decision.

#### Deterministic detached accumulation scaling

The measured workload starts with the same complete semantic backlog and a separately seeded private hidden-damage backlog at 100/1k/10k/100k. Text-length and URL indexes are explicitly primed before the boundary. The seed is proved rather than inferred: every scale records one merge, exactly `N` input visits, exactly `N` unique additions, and zero snapshot work. The measured sequence is one empty turn, one first unseen item, one repeat delta for that item, and one presentation-only publication.

| Complete blocks / unseen backlog | Mounted | Hidden content / presentation publications | Unseen membership visits | Sequence append / membership-index update visits / copied nodes | Measured hidden merges / input visits / additions / snapshots | Complete plan, height, or geometry work | Hidden settlement |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 48 | 0 / 1 | 14 | 3 / 8 / 10 | 3 / 2 / 1 / 0 | 0 | 0.346 ms |
| 1k | 48 | 0 / 1 | 20 | 6 / 11 / 13 | 3 / 2 / 1 / 0 | 0 | 0.220 ms |
| 10k | 48 | 0 / 1 | 28 | 5 / 15 / 17 | 3 / 2 / 1 / 0 | 0 | 0.425 ms |
| 100k | 48 | 0 / 1 | 34 | 6 / 18 / 20 | 3 / 2 / 1 / 0 | 0 | 0.973 ms |

Every scale performs two indexed membership checks, one append, zero unseen normalization visits, zero cold text/URL builds or visits, two text/URL index updates, and zero hidden-damage snapshot visits inside the measured interval. The only total-size terms are logarithmic persistent paths. The separately measured side-child inherited-turn miss performs one lookup, zero normalization visits, and 6/9/13/16 membership-node visits across 100/1k/10k/100k.

#### Connected Workbench, React, native, and measurement boundary

The production probe starts with a fully settled detached frame and complete semantic unseen backlog. It routes a distinct `item.started` through the real Workbench projection and publication selector, `useVisiblePresentationSnapshot`, the owned runtime subscription, `TranscriptViewport`, native roots, and `useTranscriptLayout`. It drains two quiescent zero-attempt setup passes before beginning the measured interval and cumulatively observes every later scheduler pass.

| Complete blocks | Mounted roots | Distinct item: Workbench / runtime / React publications | Measurement passes / attempts / reports | Retained / mounted / unmounted roots | Repeat delta: publications / passes / attempts / reports | Distinct / repeat settlement |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 24 | 1 / 0 / 1 | 2 / 0 / 0 | 24 / 0 / 0 | 0 / 0 / 0 / 0 | 18.989 / 0.226 ms |
| 1k | 24 | 1 / 0 / 1 | 2 / 0 / 0 | 24 / 0 / 0 | 0 / 0 / 0 / 0 | 16.448 / 0.097 ms |
| 10k | 24 | 1 / 0 / 1 | 2 / 0 / 0 | 24 / 0 / 0 | 0 / 0 / 0 / 0 | 17.823 / 0.124 ms |
| 100k | 24 | 1 / 0 / 1 | 2 / 0 / 0 | 24 / 0 / 0 | 0 / 0 / 0 / 0 | 1.496 / 0.345 ms |

The direct runtime/native hidden-delta cell independently retains 34 mounted roots with zero runtime publications, React commits, mounts, or unmounts at every scale. The native cleanup regression remains exact: the scheduler records every pruned logical key and the benchmark compares the sorted key set against the same captured pre-publication frame. Native-only runs passed at 48×18, 80×24, and 140×40; the widest overlapping movement pruned exactly the 14 departed measured keys rather than comparing against a later geometry-shifted window.

#### Equivalence, fallback, repository, and review gates

- Persisted plain unseen arrays with duplicate and prototype-named IDs normalize once through `syncTranscriptItem`; existing membership does not increment the count, and one new ID appends exactly once. Array semantics and prior snapshot immutability remain intact.
- Hidden damage precedence is covered for blocks, folds, view, layout, and full damage. A 4,096-ID backlog adds each unique ID once, does no snapshot work while detached, and materializes exactly once on reattachment. Multi-item detached tail admission publishes one reattached frame equal to a fresh full-build runtime; this intentionally proves the fallback rather than claiming bounded structural catch-up.
- The controller integration proves a distinct detached item publishes status once without publishing its content frame, repeat deltas do not republish status, and a new detach epoch counts the item again.
- Focused final review suites passed 155–190 tests with zero failures. `bun run typecheck`, dependency boundaries, documentation generation, and `git diff --check` passed.
- The complete repository gate passed 767 tests with 5 intentional profiling skips. Its sole sandbox failure was the isolated tmux socket denial; the exact host-level rerun passed: `bun test tests/terminal/terminal.test.ts --test-name-pattern "isolated tmux"` — 1 passed in 744 ms.
- The executable core and native 100/1k/10k/100k matrix passed every seed, logarithmic-path, zero-complete-work, publication, cumulative-measurement, identity-retention, and native-churn assertion above.
- Parallel architecture, correctness, and performance reviews ran before and after repair. Repairs added membership-index append counters, an all-scale private backlog, explicit text/URL priming, indexed side-child membership, the connected status-only boundary, cumulative scheduler observation, exact departed-key cleanup, persisted-array adversaries, and a multi-item full-reference fallback. All three final reviewers signed off with no blocker.

Stage 5.5f is complete for steady detached unseen accumulation and status-only presentation publication. Multi-new-item detached reattachment remains semantically exact through the full rebuild and is not claimed as total-size-independent. Turn completion/activity structure and stable production sub-blocks for oversized Markdown, command output, and diffs remain open before Stage 5.5 and overall Stage 5 can be marked complete.
