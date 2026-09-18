# Transcript runtime

Status: normative implementation design. Stages 1–4 are the current target. Stage 5 is a compatibility contract, not part of the current implementation.

The supporting evidence and source references live in [transcript-runtime-research.md](./transcript-runtime-research.md).

## Goal

Create the simplest, most robust, and most scalable transcript implementation we can reasonably build.

The transcript is Vimex's primary surface. Runtime activity should read as a few stable, useful rows rather than a protocol log, and navigation over existing history must remain responsive while Codex streams.

The end state is size-independent interaction: transcript size should not be perceptible through cursor movement, scrolling, search, selection, detachment, or follow latency.

## Call chain

Every inbound update follows one visible path:

```text
Codex notification
  -> versioned Codex mapper
  -> ConversationEvent
  -> conversation ingress settlement
  -> canonical ConversationState
  -> semantic TranscriptState projection
  -> TranscriptRuntime
  -> immutable TranscriptFrame
  -> React bridge
  -> OpenTUI measurement and rendering
```

The boundaries exist because they change for different reasons:

- the mapper changes with the Codex protocol;
- ingress changes with delivery cadence and ordering requirements;
- conversation state changes with canonical product meaning;
- transcript semantics change with Vim navigation and copy behavior;
- the runtime changes with presentation, damage, and windowing policy;
- the React/OpenTUI bridge changes with rendering technology.

## Runtime model

One canonical conversation may have multiple presentations: main and side panes, a detached reader and a following reader, or future renderers other than OpenTUI.

`TranscriptRuntime` is a renderer-neutral presentation domain model instantiated per presentation. It consumes canonical conversation and semantic transcript state and publishes cached immutable frames. It owns:

- the displayed presentation revision;
- stable projected render blocks;
- pending damage, including hidden tail damage while detached;
- block measurements and estimates reported by a renderer;
- the currently materialized window;
- revision guards and full-rebuild fallback decisions.

It does not own canonical conversation items, cursor, selection, search, jumps, marks, folds, or the logical viewport anchor.

```ts
interface TranscriptFrame {
  canonicalRevision: number
  presentationRevision: number
  mode: "follow" | "detached"
  blocks: readonly TranscriptBlock[]
  window: TranscriptWindow
  damage: TranscriptDamage
}

interface TranscriptRuntime {
  update(input: TranscriptRuntimeInput): TranscriptFrame
  getSnapshot(): TranscriptFrame
  subscribe(listener: () => void): () => void
  reportMeasurements(batch: readonly BlockMeasurement[]): void
  resetLayout(reason: LayoutResetReason): void
}
```

Exact APIs may evolve during implementation. The ownership boundary may not.

## Ownership and lifetime

`VimexController` owns canonical conversation and semantic transcript state. Workbench retains one `TranscriptRuntime` for each stable presentation identity, such as the main pane or a side pane. The runtime is implemented in `@vimex/transcript`; ownership does not move its implementation into workbench.

A presentation runtime:

- may outlive a React mount or renderer replacement;
- is bound to the thread currently displayed by that presentation;
- performs a guarded full presentation rebuild when that thread identity changes;
- retains a detached frame while its canonical thread continues to advance;
- is disposed when the presentation is explicitly retired or the application shuts down.

Two presentations may show the same canonical thread while holding different displayed revisions, follow modes, windows, and geometry caches. They share canonical conversation and semantic per-thread state; they never share mutable presentation frames.

The runtime and its geometry are recoverable caches. Persisted semantic state can restore cursor, selection, folds, and logical anchor, but a process restart does not promise to restore an obsolete detached presentation revision.

## Boundary contracts

Data and commands cross the boundaries in one direction:

```text
workbench -> TranscriptRuntime.update(input)
TranscriptRuntime -> cached TranscriptFrame snapshot -> React bridge
React/OpenTUI -> BlockMeasurement batch -> TranscriptRuntime
React input -> semantic command -> workbench
```

- Workbench supplies canonical revisions, semantic transcript state, presentation mode, viewport intent, and known damage.
- `TranscriptRuntime` publishes referentially stable immutable snapshots. `getSnapshot()` returns the same object until selected frame data changes; `subscribe()` supports a thin external-store bridge.
- The React bridge owns subscription cleanup, not runtime lifetime. It does not reproduce follow, detachment, damage, or windowing state in component state.
- OpenTUI translates native layout observations into renderer-neutral `BlockMeasurement` values. The transcript package defines that value contract and never imports React, OpenTUI, or native renderables.
- Measurement feedback can refine geometry and window planning, but cannot mutate canonical content, semantic positions, or displayed revision identity.
- Schedulers and clocks used for ingress settlement or activity cadence are injected at their owning boundary so ordering and timing tests remain deterministic.

This feedback path is not an authority cycle: canonical and semantic state flow toward presentation, while measurements update only disposable presentation knowledge.

## Invariants

1. Conversation state is the only canonical record of turns and items.
2. Semantic `TranscriptState` is authoritative for cursor, selection, folds, search, marks, jumps, and logical viewport anchor.
3. A detached frame is a retained presentation revision, not a second transcript store.
4. Reattaching follow mode selects the newest canonical presentation atomically; it never merges histories.
5. Streaming ingress may be coalesced, but item, turn, hydration, disconnect, restart, and shutdown boundaries preserve event order.
6. Activity summaries never replace canonical item IDs. Search, yank, marks, jumps, and fork boundaries address canonical content.
7. Native geometry is disposable and block-local. Terminal rows never become semantic identity.
8. Incremental work is revision-guarded and always has a correct full-rebuild fallback.
9. Input and navigation take priority over hidden streaming presentation work.
10. Persist semantic state only; never persist mounted windows or native geometry.

## Damage vocabulary

Start with the smallest useful invalidation vocabulary and expand only from measured need:

```ts
type TranscriptDamage =
  | { kind: "none" }
  | { kind: "blocks"; itemIds: readonly ItemId[] }
  | { kind: "view" }
  | { kind: "layout" }
  | { kind: "full" }
```

A streaming delta normally damages one item. Scrolling changes the view. Width, theme, syntax, or fold changes may invalidate layout. Unknown revision relationships produce full damage rather than clever reconciliation.

## Source topology

Use responsibility names rather than ceremonial layer trees. Retain existing folders; add only real files:

```text
packages/conversation/src/domain/
  events.ts
  item.ts
  turn.ts
  reduce-conversation.ts

packages/codex-app-server/src/mapping/
  map-item.ts
  map-notification.ts

packages/workbench/src/application/
  conversation-ingress.ts       # new: bounded delta settlement
  conversation-projector.ts
  live-activity.ts
  workbench-controller.ts

packages/transcript/src/
  domain/                       # existing semantic document/navigation
  application/                  # existing projection/search/operations
  runtime.ts                    # new: renderer-neutral runtime manager
  window.ts                     # new: block/window contract and pass-through planner

packages/ui-opentui-react/src/transcript/
  TranscriptViewport.tsx
  TurnActivity.tsx              # new: compact Working / Worked presentation
  AgentActivity.tsx             # new: structured collaborator presentation
  use-transcript-runtime.ts     # new: thin React bridge
  rendered-layout.ts
  measure-rendered-block.ts     # new: OpenTUI volatility boundary
  layout.ts
```

Do not create a new package, a second store, or `clients/managers/engines/resources` directories. Those terms describe responsibilities, not required filesystem names.

## Migration rule

The current implementation keeps native measurement coordination in `use-transcript-layout.ts`. Stage 2 introduces `TranscriptRuntime` with a pass-through planner while continuing to materialize all blocks. Stage 3 moves native measurement extraction behind `measure-rendered-block.ts` and makes the runtime's block-local geometry the presentation cache.

Move responsibility in tested vertical slices. The legacy hook and the runtime must never both own the same presentation revision, follow state, or geometry cache. Until a responsibility moves, the existing path remains authoritative; after it moves, remove or reduce the old path in the same coherent change.

## Staged implementation

### Stage 1 — compact, turn-aware activity

- Preserve server-observed turn timing.
- Preserve agent activity as structured conversation data rather than title conventions.
- Use one pane heartbeat (`Working · 12s`) instead of timers inside running transcript rows.
- Render reasoning, agent coordination, and tools as compact foldable rows.
- Render completed observed duration as `Worked for …` without creating synthetic canonical content.

### Stage 2 — bounded ingress and coherent detachment

- Coalesce adjacent deltas for one item on a short bounded cadence.
- Flush before every semantic or lifecycle boundary.
- Keep a detached presentation revision coherent while canonical state advances.
- Accumulate hidden tail damage and live unseen counts without invalidating the detached frame.
- Materialize canonical content when an explicit navigation target is absent from the displayed frame.
- Reattach by selecting the latest canonical revision once.

### Stage 3 — block-local geometry

- Extract OpenTUI-native Markdown, table, diff, and text measurement from layout composition.
- Cache by stable block identity, content revision, width, style revision, and fold state.
- Measure changed blocks independently.
- Treat pure scrolling as coordinate translation.
- Stop cloning historical grapheme points or mutating previously published layouts.
- Validate incremental measurement batches before committing them.

### Stage 4 — narrow observation and presentation cadence

- Publish cached immutable snapshots whose identity changes only when their selected data changes.
- Subscribe panes and observers to the smallest semantic slices they consume.
- Stop persistence and Herdr reporting from running for every token delta.
- Keep animation cadence independent of transcript content and geometry cadence.
- Cap ingress and presentation work so navigation cannot be starved.

### Stage 5 — render-block windowing

Stage 5 makes steady-state rendering independent of total history size. Windowing operates on render blocks, not conversation items, because one Markdown message, command output, or diff may itself be enormous.

```ts
interface TranscriptBlock {
  key: { itemId: ItemId; blockId: string }
  sourceSpan: SourceSpan
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

Stages 1–4 use a pass-through window planner that returns all blocks. Stage 5 changes the policy and materialization strategy, not transcript semantics or the renderer contract.

The future planner owns:

- a height prefix index;
- block range and overscan selection;
- leading and trailing row estimates;
- stable-anchor correction after measurement;
- materialization of off-window navigation targets.

The logical anchor remains `{ itemId, graphemeOffset, preferredScreenRow }`. Physical rows are width-dependent and never become marks, selections, or copy boundaries.

Server-backed paging, eviction, and indexed global search are separate future volatilities. Add a history resource-access port only when a real secondary resource exists.

## Acceptance and measurement

- Settlement occurs at a bounded cadence rather than once per protocol delta.
- A detached presentation receives no content invalidation from hidden tail streaming.
- Historical block geometry is reused when only a live block changes.
- One visible pane has at most one elapsed-time heartbeat.
- Navigation input is processed ahead of hidden presentation work.
- Incremental and full-rebuild paths produce equivalent frames.
- Existing navigation, selection, folding, search, marks, jumps, copy, and anchor restoration tests remain green.
- Benchmarks report warm navigation, streaming settlement, geometry rebuild, and follow reconciliation separately.
- Stage 5 adds history-size scaling at 1k, 10k, and 100k render blocks, including a single oversized item.
