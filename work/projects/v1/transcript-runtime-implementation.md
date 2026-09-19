# Transcript runtime implementation

Status: active execution ledger. Update this document as implementation evidence changes.

- [Transcript runtime design](./transcript-runtime.md) owns the normative model and invariants.
- [Transcript runtime research](./transcript-runtime-research.md) owns the supporting evidence and references.
- [Transcript windowing implementation](./transcript-windowing-implementation.md) owns the deferred Stage 5 execution plan.
- This document owns implementation order, status, verification, and commit evidence.

## Objective

Implement the simplest, most robust, and most scalable transcript runtime we can reasonably build.

Stages 1–4 are the current delivery target. Stage 5 contracts must be supported by the topology created now, but full render-block windowing is deferred.

## Status

| Work | State | Evidence |
|---|---|---|
| Architecture and research | Complete | Commit `8f6bba9` |
| Baseline profiling | Complete | Measurements recorded below |
| Stage 1: compact activity | Complete | Commit `7a4209d`; full gate plus isolated tmux rerun |
| Stage 2: ingress and detachment | Complete | Stage 2a `07678c4`; Stage 2b `28cc24d` |
| Stage 3: block-local geometry | Complete | Commit `f71cba9`; full gate plus isolated tmux rerun |
| Stage 4: narrow observation | Complete | Commits `efad886`, `21ea810`, and `31c4e41`; full gate plus isolated tmux rerun |
| Stage 5: block windowing | Contract only | Deferred |

“Complete” means the stage's exit criteria pass, evidence is recorded here, and the implementation is committed. Partial working-tree changes do not count as complete.

## Baseline

Measurements gathered during the 2026-09-18 transcript investigation:

| Path | Observed baseline |
|---|---:|
| Warm cached geometry | approximately 0.03 ms |
| React commits | approximately 0.3–0.6 ms |
| Ordinary navigation settlement | approximately 20–25 ms |
| Large streaming-delta settlement | approximately 116–163 ms |
| First-frame native geometry | approximately 67–81 ms |
| Standalone Markdown projection, approximately 90k characters | approximately 17.5 ms |

These measurements identify streaming projection and native geometry as the primary current cost. They are diagnostic baselines, not universal guarantees.

Before claiming a performance improvement:

1. Run the same scenario before and after the change.
2. Report warm navigation separately from streaming settlement.
3. Report cold first-frame work separately from steady-state frames.
4. Include transcript size, terminal dimensions, content shape, and follow/detached state.
5. Keep correctness tests enabled during benchmark validation.

## Implementation order

```text
Stage 1: canonical activity vocabulary
  -> Stage 2a: bounded conversation ingress
  -> Stage 2b: TranscriptRuntime and coherent detachment
  -> Stage 3: block-local geometry
  -> Stage 4: narrow subscriptions and cadence isolation
  -> Stage 5: render-block windowing
```

Stages may share preparatory types, but each stage must remain independently testable and leave the application working.

## Foundation rules

- Add a file only when its first tested behavior is implemented.
- Keep one canonical conversation and semantic transcript state.
- Treat `TranscriptFrame` as a cached presentation, never as another authority.
- Prefer stable IDs and explicit revisions over title or object-shape heuristics.
- Give every incremental path a full-rebuild equivalence test.
- Keep logical positions free of terminal row and cell coordinates.
- Preserve unrelated working-tree changes.
- Commit completed stages or coherent vertical slices separately.

## Stage 1 — compact, turn-aware activity

### Outcome

The user sees one stable turn heartbeat while work is active and concise completed activity afterward. Raw runtime event churn no longer reads as repeated independent Agent, Subagent, wait, and reasoning rows.

### Code surfaces

```text
packages/conversation/src/domain/
  item.ts
  turn.ts
  events.ts
  reduce-conversation.ts

packages/codex-app-server/src/mapping/
  map-item.ts
  map-notification.ts

packages/workbench/src/application/
  live-activity.ts
  rpc-event-replay.ts

packages/ui-opentui-react/src/
  activity/ActivityIndicator.tsx
  app/App.tsx
  app/FullscreenShell.tsx
  side-chat/SideChatLayout.tsx
  transcript/TurnActivity.tsx
  transcript/AgentActivity.tsx
  transcript/ReasoningBlock.tsx
  transcript/ToolCall.tsx
  transcript/TranscriptNode.tsx
  transcript/TranscriptViewport.tsx
  transcript/rendered-layout.ts
```

### Work

- [x] Preserve server-observed `startedAt`, `completedAt`, and `durationMs` on turns.
- [x] Preserve collaborator actions, target thread IDs, agent path, and status as structured domain data.
- [x] Map generated Codex types at the adapter boundary without title parsing downstream.
- [x] Project one pane-level `Working · elapsed` heartbeat from the active turn.
- [x] Render `Worked for …` from observed runtime duration when available.
- [x] Remove per-item animation timers from reasoning and tool rows.
- [x] Render agent coordination as compact foldable activity.
- [x] Keep activity decoration outside canonical copy, search, and fork content.

### Tests

- [x] Conversation reducer preserves and reconciles turn timing.
- [x] Codex mapper covers collaboration tool actions and subagent activity variants.
- [x] Live activity handles working, waiting, stopping, compacting, failed, and interrupted turns.
- [x] UI render tests cover running and completed activity.
- [x] Navigation and copy tests prove decorations are non-canonical.
- [x] A visible pane owns at most one elapsed-time interval.

### Exit criteria

- Activity remains stable while underlying runtime events advance.
- Completed duration is runtime-observed rather than inferred from animation time.
- No provider-specific display title determines domain behavior.
- Existing transcript and adapter suites pass.

### Not in this stage

- Delta settlement.
- Detached presentation isolation.
- Geometry refactoring.
- Windowing.

### Verification evidence

- `bun run typecheck`: pass.
- `bun run boundaries`: pass.
- `bun run docs:check`: pass.
- Repository suite: 563 pass, 5 intentional skips. The managed sandbox removed the detached tmux server socket; the exact isolated tmux test passed separately outside the sandbox.
- Focused Stage 1 regression set: 98 pass.
- Parallel adapter/domain, UI/performance, and contract review: no remaining Stage 1 blockers after repair.
- Transcript benchmark after Stage 1: 135,389 characters; measure 0.038 ms, anchor 0.243 ms, frame 0.160 ms. This is effectively unchanged from the warm baseline, as expected for a presentation-semantics stage.

## Stage 2 — bounded ingress and coherent detachment

### Outcome

Canonical state ingests continuous Codex output without settling every token independently, while a detached reader retains a coherent presentation and responsive navigation.

### Code surfaces

```text
packages/workbench/src/application/
  conversation-ingress.ts
  workbench-controller.ts
  conversation-projector.ts

packages/transcript/src/
  runtime.ts
  window.ts
  index.ts

packages/ui-opentui-react/src/
  app/App.tsx
  transcript/use-transcript-runtime.ts
  transcript/TranscriptViewport.tsx
```

### Stage 2a — ingress settlement

- [x] Introduce a bounded conversation-ingress settler.
- [x] Coalesce item-local deltas within one cadence while preserving first-seen item order and semantic boundaries.
- [x] Preserve first-seen order across independent items.
- [x] Flush before item completion, turn completion, hydration, disconnect, restart, and shutdown.
- [x] Flush before non-delta events whose meaning depends on prior text.
- [x] Ensure close and failure paths cannot strand pending text.
- [x] Prefer event-scheduled flushing over a permanent polling timer.

### Stage 2b — runtime and detachment

- [x] Introduce `TranscriptRuntime` with cached immutable `TranscriptFrame` output.
- [x] Introduce Stage 5-compatible block and window contracts.
- [x] Model blocks as a union of source-backed item blocks and source-less, turn-owned activity decoration blocks.
- [x] Begin with a pass-through planner that materializes all blocks.
- [x] Track canonical and presentation revisions explicitly.
- [x] Keep the displayed content revision stable while detached.
- [x] Record changed item IDs and unseen activity without publishing hidden content damage.
- [x] Keep cursor, selection, folds, search, marks, jumps, and logical anchor live.
- [x] Materialize explicit navigation targets absent from the displayed frame.
- [x] Reattach by selecting the newest canonical revision atomically.

### Tests

- [x] Coalesced events reduce to the same canonical state as uncoalesced events.
- [x] Every lifecycle boundary flushes pending deltas in order.
- [x] An injected scheduler makes cadence tests deterministic.
- [x] Detached frame identity remains stable during tail streaming.
- [x] Detached navigation remains responsive while canonical state advances.
- [x] Search, mark, jump, and thread navigation reveal absent targets.
- [x] Reattachment equals a fresh frame built from current canonical state.
- [x] Full rebuild and incremental update frames are semantically equivalent.

### Exit criteria

- Settlement count is bounded by cadence rather than protocol delta count.
- No text is lost, reordered, or applied after completion.
- Hidden tail output does not invalidate detached content.
- Follow and detached readers can present the same canonical conversation independently.

### Not in this stage

- Native block measurement extraction.
- Height-prefix indexing.
- Unmounted transcript blocks.
- Server-backed history paging.

### Stage 2a verification evidence

- Commit `07678c4` introduces one controller-owned ingress path for live events and authoritative hydration replay.
- Item-local deltas coalesce across interleaved streams within one cadence; first-seen item order and semantic boundaries remain stable.
- Atomic batches retain text and semantic boundaries across pre-commit failures without a permanent retry timer.
- Shutdown closes intake before its final drain, publishes the drained state for persistence, and rejects re-entrant input.
- Navigation-history reprojection is staged without changing the stable identity used by in-flight asynchronous jumps.
- Focused ingress/controller set: 64 pass. Renderer interaction set: 33 pass, 5 intentional skips.
- Full repository gate: 574 pass, 5 intentional skips; the managed sandbox removed the detached tmux socket, and the exact isolated tmux test passed separately outside the sandbox.
- Typecheck, dependency boundaries, documentation check, and diff check pass.
- Three parallel review tracks reported no remaining Stage 2a blockers after repair.

### Stage 2b verification evidence

- Commit `28cc24d` introduces one Workbench-owned `TranscriptRuntime` per stable presentation identity, cached immutable frames, guarded canonical generations and revisions, coherent detached frames, explicit target reveals, and atomic reattachment.
- Source-backed item blocks and source-less turn-activity blocks now flow through a pass-through `TranscriptWindow`; arbitrary item sub-block IDs, source spans, spacer rows, and overscan establish the Stage 5 renderer contract without implementing windowing.
- Canonical block damage updates only affected item blocks. A 300-item regression preserves the historical block plan and projection identities; structural or unknown relationships take the full-rebuild fallback.
- React owns no runtime lifetime. Its bridge subscribes to the Workbench runtime and uses only a stateless full frame before a presentation owner exists.
- Detached streaming retained exact frame identity across 100 consecutive deltas and emitted no presentation notifications. Reattachment matched a fresh full frame and published once.
- Isolated runtime-update measurements, with Markdown projection prepared before timing, were 0.026 ms at 1K characters, 0.015 ms at 10K, 0.019 ms at 50K, and 0.033 ms at 100K. Remaining shallow immutable-container work measured 0.058 ms at 300 historical items, 0.588 ms at 3K, and 2.417 ms at 10K.
- The existing 135,389-character renderer benchmark remained effectively flat: measure 0.030 ms, anchor 0.254 ms, frame 0.129 ms.
- Final focused verification passed 131 tests. The repository gate passed typecheck, dependency boundaries, documentation generation, 606 tests, and 5 intentional performance skips; the managed sandbox removed the tmux socket, and the exact isolated tmux scenario passed outside it.
- Two parallel review-and-repair rounds covering runtime correctness, ownership/topology, tests, and performance reported no remaining blockers.

## Stage 3 — block-local geometry

### Outcome

Changing one live block does not clone or remeasure historical grapheme geometry.

### Code surfaces

```text
packages/ui-opentui-react/src/transcript/
  measure-rendered-block.ts
  rendered-layout.ts
  layout.ts
  use-transcript-layout.ts

packages/transcript/src/
  geometry.ts
  runtime.ts
  window.ts
```

### Work

- [x] Extract OpenTUI-native text, Markdown, table, and diff measurement.
- [x] Key geometry by block identity, content revision, width, style revision, and fold state.
- [x] Store points and lines in block-local coordinates.
- [x] Compose global rows and screen coordinates through accessors.
- [x] Stop mutating points belonging to a previously published layout.
- [x] Reuse unchanged block indexes without cloning.
- [x] Treat scroll-only motion as a viewport translation.
- [x] Commit measurement batches only when base revisions still match.
- [x] Fall back after width, theme, syntax, or uncertain native changes.
- [x] Retain at most one complete geometry variant per materialized block and replace it atomically; Stage 5 bounds the materialized block set.

### Tests

- [x] Measurement covers plain text, Markdown, tables, diffs, wide graphemes, concealment, folds, and asynchronous parser settlement.
- [x] Updating the last block preserves historical geometry identities.
- [x] Reflow restores a logical anchor to its preferred screen row.
- [x] Prior layouts remain immutable after later measurement.
- [x] Incremental and full layout construction yield equivalent navigation.
- [x] Existing visual selection and cursor tests pass.

### Exit criteria

- Tail streaming work scales with changed blocks rather than total transcript graphemes.
- Warm scroll remains a translation fast path.
- Navigation uses indexed rows without flattening the transcript.
- OpenTUI-private measurement knowledge is contained in one module.

### Not in this stage

- Unmounting off-window blocks.
- Persistent geometry.
- Background history paging.

### Verification evidence

- Commit `f71cba9` introduces renderer-neutral immutable `BlockGeometry`, guarded runtime measurement batches, block-local row indexes, native placement composition, and a pure scroll-translation fast path.
- OpenTUI-private text, Markdown, table, and diff inspection is contained in `measure-rendered-block.ts`; `rendered-layout.ts` schedules dirty blocks and composes runtime geometry without owning a second cache.
- Changed-tail measurement retains exact historical block geometry identities. Navigation indexes rows without flattening historical point maps; folded blocks retain only visible points and boundary sentinels.
- Geometry retention is one complete current variant per materialized block. A 10,000-point revision replaced by a 12,000-point revision reports 12,000 retained points rather than accumulating 22,000; width, style, syntax, and uncertain renderer changes reset the whole layout generation.
- Stage 5 contracts now include stable render-block IDs, render payloads, half-open source spans with final document-end ownership, source-less activity footprints, block-to-item routing, and spacer/overscan fields. No block windowing is implemented yet.
- Retained-history tail work remained approximately flat while historical geometry grew from 1,000 to 495,000 points: approximately 0.064–0.080 ms for a ten-point changed tail. Navigation at the bottom of one 500,000-point block measured approximately 0.12–0.26 ms for edge lookup and 0.010–0.016 ms for a downward motion.
- The 135,389-character renderer benchmark measured 0.022–0.030 ms for cached measurement, 0.554–0.809 ms for anchor work, and 0.142–0.177 ms for a native frame across repeated runs.
- Full repository gate: typecheck, dependency boundaries, and documentation generation pass; 622 tests pass with 5 intentional performance skips. The managed sandbox removed the tmux socket, and the exact isolated tmux scenario passed outside it.
- Final transcript/UI review set: 343 pass with 5 intentional performance skips. Three parallel architecture, correctness, and test/performance review tracks reported no remaining Stage 3 blockers after repair.

## Stage 4 — narrow observation and cadence isolation

### Outcome

Unrelated state and presentation work no longer wakes the transcript, persistence, or Herdr observers on every token.

### Code surfaces

```text
packages/workbench/src/application/
  conversation-ingress.ts
  local-state.ts
  workbench-observation.ts
  workbench-controller.ts
  workbench-publications.ts

apps/tui/src/
  composition-root.ts

packages/ui-opentui-react/src/
  app/App.tsx
  side-chat/SideChatLayout.tsx
  transcript/use-transcript-runtime.ts
  transcript/TranscriptViewport.tsx
```

### Work

- [x] Publish cached immutable snapshots suitable for narrow selection.
- [x] Preserve the state-prop UI interface for presentational tests.
- [x] Subscribe each pane to its own workspace and presentation slice.
- [x] Keep detached transcript content references stable.
- [x] Make persistence observe only serializable local-view fields.
- [x] Make Herdr reporting observe only lifecycle metadata.
- [x] Retain the existing Herdr reporter's latest-wins queue.
- [x] Isolate heartbeat animation from transcript layout invalidation.
- [x] Cap normal scheduled ingress work per scheduling turn so presentation input cannot starve navigation.

### Tests

- [x] Snapshot identity changes only when selected values change.
- [x] Streaming one pane does not reconcile the other pane's transcript.
- [x] Detached rows do not rerender for hidden tail deltas.
- [x] Persistence does not capture token-only changes.
- [x] Herdr does not report when its semantic signature is unchanged.
- [x] Navigation remains responsive during sustained streaming.

### Exit criteria

- React and external observers consume the smallest stable slices they need.
- One animation tick cannot invalidate the transcript subtree.
- Persistence and Herdr cadence are independent of token cadence.
- Side-by-side panes remain independently responsive.

### Verification evidence

- Commit `efad886` gives local persistence and Herdr lifecycle reporting cached semantic signatures. Token-only changes no longer wake either observer, while the Herdr reporter retains its latest-wins delivery queue.
- Commit `21ea810` adds cached layout and pane publications, a production external-store bridge, pane-local subscriptions, a memoized viewport surface, coherent canonical/publication/runtime assignment order, and cleanup for hidden side-pane heartbeats. The state-prop root remains available for presentational tests.
- Commit `31c4e41` bounds a normal scheduled ingress turn to 64 distinct streams, continues backlog on a zero-delay task, and coalesces all item-local deltas within a cadence without crossing semantic boundaries. Explicit lifecycle drains and failed semantic batches remain atomic.
- Side-chat lookup uses an immutable-state `WeakMap` index with role-specific child lookup. Parent/child identifier collisions retain correct projection, runtime input, hydration, navigation, and pane invalidation behavior.
- The focused final hardening set passed 105 tests. Parallel architecture, correctness, and test/performance review-and-repair rounds reported no remaining blockers.
- The full repository gate passed typecheck, dependency boundaries, documentation generation, 649 tests, and 5 intentional performance skips. The managed sandbox removed the tmux socket, and the exact isolated tmux scenario passed outside it.
- The connected-App profile passed 11 scenarios in an 80×24 terminal. Its navigation fixture contained 100 historical Markdown items with eight repeated paragraphs each; warm navigation settled in approximately 19–21 ms with 0.09–0.21 ms input dispatch and 0.45–0.51 ms React commits. Its detached fixture appended 1,200 Markdown paragraphs to a live answer; steady deltas settled in approximately 18–20 ms and navigation in approximately 52–57 ms with 0.22–0.30 ms React commits. The first large-frame materialization was approximately 228 ms.
- These measurements do not justify a second presentation scheduler: bounded ingress and narrow publications remove token-cadence starvation, while remaining cost is primarily native frame and Markdown work. Stage 5 block windowing is the next topology-preserving scaling step.

## Stage 5 — render-block windowing

Status: deferred implementation; contracts established in Stages 2–3.

### Future outcome

Mounted render work and native layout cost become independent of total transcript size.

### Required behavior

- Window stable render blocks, not only conversation items.
- Maintain a measured/estimated height prefix index.
- Use leading and trailing spacers with configurable overscan.
- Correct estimates without visually moving the logical anchor.
- Materialize search, mark, jump, cursor, and selection targets before navigation.
- Perform copy against canonical projections, including unmounted blocks.
- Preserve source-less turn-activity blocks in chronological windows without making them cursor, selection, search, copy, or fork targets.
- Keep follow pinned to the trailing window and detached reading pinned to the anchor window.
- Add indexed search separately when search cost becomes size-dependent.
- Add paged history access only if canonical history moves to a secondary resource.

### Scaling matrix

Benchmark at minimum:

- 1k, 10k, and 100k render blocks;
- one oversized Markdown item;
- one oversized command output;
- a large split diff;
- follow and detached modes;
- search and selection spanning unmounted blocks.

Transcript size should not be perceptible through steady-state navigation or rendering.

## Cross-stage regression suite

Every stage must preserve:

- semantic cursor and Visual selection;
- rendered-text and source-Markdown copy;
- folds and fold-all;
- search, URL targets, marks, and jump history;
- explicit follow attachment and detached anchoring;
- resize and Markdown reflow restoration;
- side-chat focus and independent pane state;
- thread resume, switch, fork, and restart;
- approvals, questions, interruption, and compaction;
- terminal shutdown and restoration.

## Evidence log

Add one row after each coherent implementation commit.

| Date | Stage | Commit | Verification | Measurements | Notes |
|---|---|---|---|---|---|
| 2026-09-18 | Architecture | `8f6bba9` | Documentation review; `git diff --check` | Baseline recorded above | Runtime design and research committed |
| 2026-09-18 | Stage 1 | `7a4209d` | Typecheck, boundaries, docs, 563-test repository run plus isolated tmux rerun, 98 focused tests, three parallel review scopes | 135,389 chars: measure 0.038 ms, anchor 0.243 ms, frame 0.160 ms | Compact turn-aware activity, structured agent vocabulary, observed timing, non-canonical decorations, one heartbeat per visible pane |
| 2026-09-18 | Stage 2a | `07678c4` | Typecheck, boundaries, docs, 574-test repository run plus isolated tmux rerun, deterministic ingress tests, three parallel review scopes | Settlement bounded by injected cadence; no permanent polling timer | Atomic bounded ingress, lifecycle drains, hydration replay, staged navigation-history projection |
| 2026-09-18 | Stage 2b | `28cc24d` | Typecheck, boundaries, docs, 606-test repository run plus isolated tmux rerun, 131 focused tests, two parallel review-and-repair rounds | Runtime update 0.015–0.033 ms at 10K–100K active chars; 2.417 ms at 10K historical items; detached deltas publish 0 frames | Workbench-owned runtime, coherent detachment, incremental block damage, thin React bridge, Stage 5 block/window contract |
| 2026-09-18 | Stage 3 | `f71cba9` | Typecheck, boundaries, docs, 622-test repository run plus isolated tmux rerun, 343 transcript/UI tests, three parallel review scopes | Ten-point tail update 0.064–0.080 ms with up to 495K retained points; bottom navigation 0.010–0.26 ms | Immutable block-local geometry, guarded native measurement, indexed navigation, scroll translation fast path |
| 2026-09-18 | Stage 4 | `efad886`, `21ea810`, `31c4e41` | Typecheck, boundaries, docs, 649-test repository run plus isolated tmux rerun, 105 final hardening tests, parallel review-and-repair rounds | Warm navigation 19–21 ms; detached steady deltas 18–20 ms; React commits 0.22–0.51 ms | Semantic external observers, cached pane publications, bounded ingress turns, indexed side associations; no additional presentation scheduler |

## Deferred questions

Answer these through measurement rather than speculative topology:

- Stable Markdown sub-block identity across reparses.
- Incremental-versus-full rebuild cost threshold.
- Geometry-cache budget and reset interval.
- OpenTUI public versus private measurement access.
- The transcript size at which indexed search becomes necessary.

Record answers here when evidence exists. Update the normative design only if an invariant or ownership boundary changes.

Resolved: ingress settles on the existing short cadence, processes at most 64 distinct streams in a normal scheduled turn, and schedules a zero-delay continuation for remaining work. Semantic and lifecycle boundaries still drain atomically.
