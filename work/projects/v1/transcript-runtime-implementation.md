# Transcript runtime implementation

Status: active execution ledger. Update this document as implementation evidence changes.

- [Transcript runtime design](./transcript-runtime.md) owns the normative model and invariants.
- [Transcript runtime research](./transcript-runtime-research.md) owns the supporting evidence and references.
- This document owns implementation order, status, verification, and commit evidence.

## Objective

Implement the simplest, most robust, and most scalable transcript runtime we can reasonably build.

Stages 1–4 are the current delivery target. Stage 5 contracts must be supported by the topology created now, but full render-block windowing is deferred.

## Status

| Work | State | Evidence |
|---|---|---|
| Architecture and research | Complete | Commit `8f6bba9` |
| Baseline profiling | Complete | Measurements recorded below |
| Stage 1: compact activity | Verified, commit pending | Full gate plus isolated tmux rerun; evidence below |
| Stage 2: ingress and detachment | Not started | — |
| Stage 3: block-local geometry | Not started | — |
| Stage 4: narrow observation | Not started | — |
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

- [ ] Introduce a bounded conversation-ingress settler.
- [ ] Coalesce adjacent deltas only when thread and item identity match.
- [ ] Preserve first-seen order across independent items.
- [ ] Flush before item completion, turn completion, hydration, disconnect, restart, and shutdown.
- [ ] Flush before non-delta events whose meaning depends on prior text.
- [ ] Ensure close and failure paths cannot strand pending text.
- [ ] Prefer event-scheduled flushing over a permanent polling timer.

### Stage 2b — runtime and detachment

- [ ] Introduce `TranscriptRuntime` with cached immutable `TranscriptFrame` output.
- [ ] Introduce Stage 5-compatible block and window contracts.
- [ ] Model blocks as a union of source-backed item blocks and source-less, turn-owned activity decoration blocks.
- [ ] Begin with a pass-through planner that materializes all blocks.
- [ ] Track canonical and presentation revisions explicitly.
- [ ] Keep the displayed content revision stable while detached.
- [ ] Record changed item IDs and unseen activity without publishing hidden content damage.
- [ ] Keep cursor, selection, folds, search, marks, jumps, and logical anchor live.
- [ ] Materialize explicit navigation targets absent from the displayed frame.
- [ ] Reattach by selecting the newest canonical revision atomically.

### Tests

- [ ] Coalesced events reduce to the same canonical state as uncoalesced events.
- [ ] Every lifecycle boundary flushes pending deltas in order.
- [ ] An injected scheduler makes cadence tests deterministic.
- [ ] Detached frame identity remains stable during tail streaming.
- [ ] Detached navigation remains responsive while canonical state advances.
- [ ] Search, mark, jump, and thread navigation reveal absent targets.
- [ ] Reattachment equals a fresh frame built from current canonical state.
- [ ] Full rebuild and incremental update frames are semantically equivalent.

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
```

### Work

- [ ] Extract OpenTUI-native text, Markdown, table, and diff measurement.
- [ ] Key geometry by block identity, content revision, width, style revision, and fold state.
- [ ] Store points and lines in block-local coordinates.
- [ ] Compose global rows and screen coordinates through accessors.
- [ ] Stop mutating points belonging to a previously published layout.
- [ ] Reuse unchanged block indexes without cloning.
- [ ] Treat scroll-only motion as a viewport translation.
- [ ] Commit measurement batches only when base revisions still match.
- [ ] Fall back after width, theme, syntax, or uncertain native changes.
- [ ] Add a cache budget or reset policy for unusually large blocks.

### Tests

- [ ] Measurement covers plain text, Markdown, tables, diffs, wide graphemes, concealment, folds, and asynchronous parser settlement.
- [ ] Updating the last block preserves historical geometry identities.
- [ ] Reflow restores a logical anchor to its preferred screen row.
- [ ] Prior layouts remain immutable after later measurement.
- [ ] Incremental and full layout construction yield equivalent navigation.
- [ ] Existing visual selection and cursor tests pass.

### Exit criteria

- Tail streaming work scales with changed blocks rather than total transcript graphemes.
- Warm scroll remains a translation fast path.
- Navigation uses indexed rows without flattening the transcript.
- OpenTUI-private measurement knowledge is contained in one module.

### Not in this stage

- Unmounting off-window blocks.
- Persistent geometry.
- Background history paging.

## Stage 4 — narrow observation and cadence isolation

### Outcome

Unrelated state and presentation work no longer wakes the transcript, persistence, or Herdr observers on every token.

### Code surfaces

```text
packages/workbench/src/application/
  workbench-controller.ts

apps/tui/src/
  composition-root.ts

packages/ui-opentui-react/src/
  app/App.tsx
  side-chat/SideChatLayout.tsx
  transcript/use-transcript-runtime.ts
  transcript/TranscriptViewport.tsx
```

### Work

- [ ] Publish cached immutable snapshots suitable for narrow selection.
- [ ] Preserve the state-prop UI interface for presentational tests.
- [ ] Subscribe each pane to its own workspace and presentation slice.
- [ ] Keep detached transcript content references stable.
- [ ] Make persistence observe only serializable local-view fields.
- [ ] Make Herdr reporting observe only lifecycle metadata.
- [ ] Retain the existing Herdr reporter's latest-wins queue.
- [ ] Isolate heartbeat animation from transcript layout invalidation.
- [ ] Cap ingest and presentation work per scheduling turn when necessary.

### Tests

- [ ] Snapshot identity changes only when selected values change.
- [ ] Streaming one pane does not reconcile the other pane's transcript.
- [ ] Detached rows do not rerender for hidden tail deltas.
- [ ] Persistence does not capture token-only changes.
- [ ] Herdr does not report when its semantic signature is unchanged.
- [ ] Navigation remains responsive during sustained streaming.

### Exit criteria

- React and external observers consume the smallest stable slices they need.
- One animation tick cannot invalidate the transcript subtree.
- Persistence and Herdr cadence are independent of token cadence.
- Side-by-side panes remain independently responsive.

## Stage 5 — render-block windowing

Status: deferred implementation; contracts established in Stage 2.

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

## Deferred questions

Answer these through measurement rather than speculative topology:

- Exact ingress settlement cadence.
- Stable Markdown sub-block identity across reparses.
- Incremental-versus-full rebuild cost threshold.
- Geometry-cache budget and reset interval.
- OpenTUI public versus private measurement access.
- The transcript size at which indexed search becomes necessary.

Record answers here when evidence exists. Update the normative design only if an invariant or ownership boundary changes.
