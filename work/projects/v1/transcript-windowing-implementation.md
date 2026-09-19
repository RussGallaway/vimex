# Transcript windowing implementation

Status: ready for implementation. Stages 1–4 are complete and verified; the Stage 5 topology, contracts, and inherited baselines are established.

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
| Stage 5 scaling fixtures | Not started | Identical 100/1k/10k/100k workloads required |
| Stage 5a: pure window planner | Not started | — |
| Stage 5b: windowed mounting | Not started | — |
| Stage 5c: anchor correction | Not started | — |
| Stage 5d: off-window semantics | Not started | — |
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

- [ ] Record pre-windowing mount counts, native layout work, memory, and navigation latency alongside the inherited timing baselines.
- [ ] Add deterministic 100, 1k, 10k, and 100k render-block fixtures.
- [ ] Run identical warm navigation, follow delta, detachment, reattachment, and explicit-reveal workloads at every recorded size.
- [ ] Add oversized Markdown, command-output, and split-diff fixtures.
- [ ] Cover follow and detached presentations at several terminal dimensions.
- [ ] Preserve a pass-through reference path for semantic equivalence tests.

Exit criteria:

- Fixtures are deterministic and do not dominate test runtime accidentally.
- Baselines separate planner, React reconciliation, native layout, and end-to-end input latency.
- Every scaling result identifies transcript size, mounted block count, measured block count, changed block count, and publication count.

### Stage 5.1 — pure window planner

- [ ] Build a renderer-neutral height index over stable block keys.
- [ ] Plan visible and overscan block ranges from viewport rows.
- [ ] Calculate leading and trailing spacer rows.
- [ ] Plan a trailing window for follow attachment.
- [ ] Plan an anchor-centered window for detached reading.
- [ ] Include explicit off-window targets deterministically.
- [ ] Retain a full pass-through fallback for unknown relationships.

Exit criteria:

- Planner tests require no React or OpenTUI.
- Equivalent inputs return semantically equivalent windows.
- Lookup and update costs meet the recorded large-history budget.

### Stage 5.2 — windowed mounting

- [ ] Render planned blocks rather than the complete block array.
- [ ] Add stable leading and trailing spacer roots.
- [ ] Mount and unmount measurement observers with their owning block roots.
- [ ] Prioritize visible block measurement over overscan.
- [ ] Bound mounted block and native-node counts.
- [ ] Preserve the pass-through renderer behind a test-only comparison seam until equivalence is established.

Exit criteria:

- Mounted block count remains viewport/overscan-bounded at 1k, 10k, and 100k blocks.
- Chronology and visible presentation match the pass-through reference.
- Moving the window does not leak native observers or stale references.

### Stage 5.3 — estimate correction and anchor stability

- [ ] Commit guarded visible measurement batches atomically.
- [ ] Replace estimates with measured rows in the height index.
- [ ] Replan the window after accepted height changes.
- [ ] Preserve the logical anchor at its preferred screen row.
- [ ] Handle asynchronous Markdown, table, diff, and syntax settlement.
- [ ] Prevent estimate-correction oscillation and repeated no-op publications.

Exit criteria:

- Reflow above, within, and below the viewport does not visibly move the logical anchor.
- Stale measurements cannot change spacers, window membership, or scroll position.
- Prior frames and geometry snapshots remain immutable.

### Stage 5.4 — off-window semantics

- [ ] Materialize cursor and message-motion targets outside the current window.
- [ ] Materialize search, mark, jump, history, and thread-navigation targets.
- [ ] Render selections whose logical endpoints span unmounted blocks.
- [ ] Copy source and rendered text across unmounted blocks from canonical projections.
- [ ] Preserve folds and URL navigation across window changes.
- [ ] Verify empty-source items and source-less activity at window boundaries.

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
