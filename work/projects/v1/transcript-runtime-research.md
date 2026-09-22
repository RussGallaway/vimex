# Transcript runtime research

Status: explanatory research record. [transcript-runtime.md](./transcript-runtime.md) is the normative implementation design.

## Research objective

Find the smallest architecture that can provide robust streaming, first-class transcript navigation, coherent detached reading, and eventual size-independent rendering without creating multiple authorities or a topology too complex to hold in our heads.

The governing implementation goal is:

> Create the simplest, most robust, and most scalable transcript implementation we can reasonably build.

The sources were evaluated for transferable design principles, not copied as templates. Ghostty, tmux, and Herdr render terminal cell grids; Vimex owns a structured semantic document with stronger identities and source mappings.

## Converged model

```text
Codex notification
  -> versioned Codex mapper
  -> ConversationEvent
  -> bounded conversation ingress
  -> canonical ConversationState
  -> semantic TranscriptState projection
  -> renderer-neutral TranscriptRuntime
  -> immutable TranscriptFrame
  -> React bridge
  -> OpenTUI measurement and rendering
```

The shared conclusion across the codebases is:

- keep one canonical content authority;
- represent detachment as viewport/presentation state;
- retain a stateful, renderer-neutral presentation model;
- track narrow damage and explicit revisions;
- coalesce high-frequency runtime updates before presentation;
- validate incremental work and fall back safely;
- keep semantic identity independent of native geometry;
- introduce resource access only when a real external resource exists.

## Ghostty

Inspected: `ghostty-org/ghostty` main at `b32f20f3e8d25bb925ec545c54498e93518e7ced`.

### Findings

Ghostty keeps one paged screen history and represents the viewport as active, top, or a tracked pin. Appending output does not move a detached pin. Stable pins survive movement and detect invalidation when history is pruned.

- [`PageList` viewport and tracked pins](https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/terminal/PageList.zig#L421-L520)
- [Detached viewport behavior test](https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/terminal/Screen.zig#L5194-L5228)

Ghostty replaced cloning the viewport for every render with a persistent renderer-neutral `RenderState`. The previous clone cost repeatedly blocked I/O. The state retains allocations, consumes dirty rows, and exposes `false`, `partial`, and `full` damage.

- [`RenderState` design and ownership](https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/terminal/render.zig#L20-L115)
- [Incremental render-state change](https://github.com/ghostty-org/ghostty/pull/9662)
- [Dirty-state vocabulary](https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/terminal/render.zig#L280-L293)

Snapshot production is split: `beginUpdate` holds terminal access only long enough to collect required state; `endUpdate` performs expensive denormalization using render-state-owned memory. Render caches are explicitly reset periodically so one unusually large frame does not retain capacity forever.

- [Two-phase update](https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/terminal/render.zig#L333-L369)
- [Renderer cache reset policy](https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/renderer/generic.zig#L1323-L1334)

### Transfer to Vimex

- `TranscriptRuntime` should be stateful, retained, and independent of OpenTUI.
- Detached reading is a pinned presentation over one canonical history.
- Damage should be block-level and revision-guarded.
- Cache lifetime needs a memory policy.
- Expensive projection/measurement should not block canonical ingest.

### Do not copy

Ghostty has fixed-height terminal rows. Vimex needs variable-height semantic blocks, width-sensitive estimates, and logical anchors based on item identity and source position.

## tmux

Inspected: `tmux/tmux` master at `e880cf63e0a9fe095d7c5d313761520fb1a8653c`.

### Findings

Tmux separates canonical grid storage, screen interaction state, copy-mode view state, and terminal drawing. Its grid stores history and the active screen together; view helpers translate between storage and visible coordinates.

- [Grid storage model](https://github.com/tmux/tmux/blob/e880cf63e0a9fe095d7c5d313761520fb1a8653c/grid.c#L29-L38)
- [Visible-coordinate adapter](https://github.com/tmux/tmux/blob/e880cf63e0a9fe095d7c5d313761520fb1a8653c/grid-view.c#L25-L37)
- [Virtual pane screen ownership](https://github.com/tmux/tmux/blob/e880cf63e0a9fe095d7c5d313761520fb1a8653c/window.c#L37-L53)

Current copy mode retains a backing presentation plus a visible screen and navigation state. The live grid exposes monotonic `scroll_added`, `scroll_collected`, and `scroll_generation` counters. Copy mode incrementally drops expired history, keeps unchanged content, copies new history, and refreshes the live viewport. Geometry or generation mismatch falls back to a full clone.

- [Copy-mode state](https://github.com/tmux/tmux/blob/e880cf63e0a9fe095d7c5d313761520fb1a8653c/window-copy.c#L270-L364)
- [Incremental backing reconciliation](https://github.com/tmux/tmux/blob/e880cf63e0a9fe095d7c5d313761520fb1a8653c/window-copy.c#L451-L557)
- [Refresh behavior and fallback](https://github.com/tmux/tmux/blob/e880cf63e0a9fe095d7c5d313761520fb1a8653c/window-copy.c#L3045-L3143)

Tmux batches available PTY bytes, coalesces printable characters before drawing, and uses tiered redraw flags rather than treating every character as a full application invalidation.

- [Batched input parsing](https://github.com/tmux/tmux/blob/e880cf63e0a9fe095d7c5d313761520fb1a8653c/input.c#L1044-L1074)
- [Printable-character collection](https://github.com/tmux/tmux/blob/e880cf63e0a9fe095d7c5d313761520fb1a8653c/screen-write.c#L2618-L2670)

### Transfer to Vimex

- Maintain explicit presentation generations and changed-item information.
- Coalesce token deltas before projection and rendering.
- A detached frame is a disposable presentation snapshot, not another authority.
- Incremental reconciliation must have arithmetic/revision invariants and a full fallback.

### Do not copy

Tmux needs physical screen clones because terminal escape sequences destructively update its only reconstructed model. Vimex can always reproject structured canonical conversation state and should not clone complete history.

## Herdr

Inspected: `herdrdev/herdr` master at `3f2a6e743f67bc947cfa06be25df106d00b9ee11` and Vimex's existing Herdr adapter.

### Findings

Herdr separates terminal semantics, pane-local view state, and live PTY/parser resources. Runtime resources are not embedded into pure persisted state.

- [`TerminalState`](https://github.com/herdrdev/herdr/blob/3f2a6e743f67bc947cfa06be25df106d00b9ee11/src/terminal/state.rs)
- [`PaneState`](https://github.com/herdrdev/herdr/blob/3f2a6e743f67bc947cfa06be25df106d00b9ee11/src/pane/state.rs)
- [`TerminalRuntimeRegistry`](https://github.com/herdrdev/herdr/blob/3f2a6e743f67bc947cfa06be25df106d00b9ee11/src/terminal/runtime_registry.rs)

Its render signal records damage origin. Visible sources may wake rendering immediately, while hidden pane activity is coalesced. Event draining is bounded so one producer cannot starve the rest of the application.

- [Origin-aware render signal](https://github.com/herdrdev/herdr/blob/3f2a6e743f67bc947cfa06be25df106d00b9ee11/src/render_signal.rs)
- [Headless hidden-work filtering](https://github.com/herdrdev/herdr/blob/3f2a6e743f67bc947cfa06be25df106d00b9ee11/src/server/headless.rs)
- [Application cadence and bounded draining](https://github.com/herdrdev/herdr/blob/3f2a6e743f67bc947cfa06be25df106d00b9ee11/src/app/runtime.rs)

Incremental surface deltas carry base revisions. Clients reject patches when generation, geometry, or presentation state does not match. Sparse updates also fall back to full frames when their cost becomes worse than replacement.

- [Revisioned surface delta](https://github.com/herdrdev/herdr/blob/3f2a6e743f67bc947cfa06be25df106d00b9ee11/src/protocol/surface_delta.rs)
- [Client patch validation](https://github.com/herdrdev/herdr/blob/3f2a6e743f67bc947cfa06be25df106d00b9ee11/src/client/shell/surface_patch.rs)

Activity is a projection from terminal/agent state rather than a transcript of raw hook events. Persistence stores semantic snapshots separately from optional screen history.

- [Workspace activity aggregation](https://github.com/herdrdev/herdr/blob/3f2a6e743f67bc947cfa06be25df106d00b9ee11/src/workspace/aggregate.rs)
- [Versioned persistence snapshot](https://github.com/herdrdev/herdr/blob/3f2a6e743f67bc947cfa06be25df106d00b9ee11/src/persist/snapshot.rs)

### Transfer to Vimex

- Track damage source and distinguish visible from hidden presentation work.
- Bound event work so input retains priority.
- Keep revision vocabulary explicit and small.
- Choose incremental versus full rebuilding by correctness and cost.
- Treat `Working`, `Worked for`, unseen output, and collaborator summaries as read-model projections.
- Persist logical anchors and folds, never native geometry.

### Do not copy

Herdr is a multiplexer and terminal emulator with server/client transport concerns. Vimex does not need its process topology, wire-level surface revisions, or cell-history alignment.

## OpenTUI and React

OpenTUI is demand-driven by default, but every requested frame may still traverse native layout. Its `viewportCulling` reduces painting, not the cost of keeping the whole tree mounted. A measured OpenTUI issue showed one spinner repeatedly walking the full tree and consuming substantial idle CPU.

- [OpenTUI renderer scheduling](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/core-concepts/renderer.mdx)
- [Whole-tree spinner profile](https://github.com/anomalyco/opentui/issues/1339)
- [OpenTUI ScrollBox documentation](https://opentui.com/docs/components/scrollbox/)

React requires external-store snapshots to be immutable and referentially stable until the underlying selected data changes. Rebuilding snapshot objects inside `getSnapshot` defeats its update model.

- [`useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)
- [External-store selector RFC](https://github.com/reactjs/rfcs/blob/main/text/0214-use-sync-external-store.md)

### Transfer to Vimex

- Use one pane heartbeat rather than animation in every active row.
- Keep detached content props stable.
- Publish cached frames and subscribe to narrow slices.
- Do not mistake culling for windowing.
- Isolate OpenTUI private measurement APIs behind one adapter module.

## Scrollback continuity follow-up (2026-09-22)

The original research establishes ownership and bounded work, not smoothness of every painted frame. User reports after Stage 5 and the first scroll fixes triggered a dedicated [scrollback investigation](./transcript-scrollback-investigation.md). Further feature development is gated on transcript navigation quality. The investigation compares current windowing with a fully mounted control and records native paints before post-frame measurement changes state.

### Grok Build

Inspected official `xai-org/grok-build` at `07e35a3dfeed2f200d319ef6c893b5ea286d9a51`. This is source inspection; upstream tests and interactive smoothness were not executed.

Grok also virtualizes variable-height scrollback. Its important distinction is a preparation phase that resolves visible geometry and restores anchors before painting. Newly visible estimates are replaced repeatedly until the viewport is exact. Height measurement and painting use the same rendered-content cache.

- [Preparation](https://github.com/xai-org/grok-build/blob/07e35a3dfeed2f200d319ef6c893b5ea286d9a51/crates/codegen/xai-grok-pager/src/scrollback/state/mod.rs#L1316)
- [Visible-height settlement](https://github.com/xai-org/grok-build/blob/07e35a3dfeed2f200d319ef6c893b5ea286d9a51/crates/codegen/xai-grok-pager/src/scrollback/state/layout.rs#L731)
- [Shared rendered-content measurement](https://github.com/xai-org/grok-build/blob/07e35a3dfeed2f200d319ef6c893b5ea286d9a51/crates/codegen/xai-grok-pager/src/scrollback/wrappers/entry_renderer.rs#L544)

It measures a neighborhood around cold selection targets, retains exact scalar heights after evicting heavy rendered output, and discards a pending structural correction if subsequent user navigation changed the captured offset. Vimex already retains scalar heights; the open question is whether retaining lightweight row/point mappings would prevent warm revisits from becoming cold layout operations.

- [Target preparation](https://github.com/xai-org/grok-build/blob/07e35a3dfeed2f200d319ef6c893b5ea286d9a51/crates/codegen/xai-grok-pager/src/scrollback/state/layout.rs#L861)
- [Measurement and eviction](https://github.com/xai-org/grok-build/blob/07e35a3dfeed2f200d319ef6c893b5ea286d9a51/crates/codegen/xai-grok-pager/src/scrollback/state/layout.rs#L591)
- [Correction yields to navigation](https://github.com/xai-org/grok-build/blob/07e35a3dfeed2f200d319ef6c893b5ea286d9a51/crates/codegen/xai-grok-pager/src/scrollback/state/layout.rs#L530)

Tests worth adapting require repeated preparation to be a no-op, compare lazy heights with an independent exact oracle, preserve detached markers during growth/removal above them, and exercise cold paging and distant selection. A read-only scroll HUD and input logs provide event-loop diagnostics.

- [Convergence and exact oracle](https://github.com/xai-org/grok-build/blob/07e35a3dfeed2f200d319ef6c893b5ea286d9a51/crates/codegen/xai-grok-pager/src/scrollback/state/layout_tests.rs#L1682)
- [Cold paging](https://github.com/xai-org/grok-build/blob/07e35a3dfeed2f200d319ef6c893b5ea286d9a51/crates/codegen/xai-grok-pager/src/scrollback/state/layout_tests.rs#L1976)
- [Scroll HUD](https://github.com/xai-org/grok-build/blob/07e35a3dfeed2f200d319ef6c893b5ea286d9a51/crates/codegen/xai-grok-pager/src/views/scroll_debug_hud.rs)

Do not treat this as proof of flawless virtualization or bounded latency. Its settlement loop permits up to entry-count-plus-two iterations, corrections rebuild prefix positions, and rendering a large entry can be expensive. Its Ratatui preparation/render ownership does not directly transfer to React/OpenTUI.

### OpenCode and OpenTUI

Inspected `anomalyco/opencode` at `2406400f0aeb07b36d0495af4e05aaca49159832` and `anomalyco/opentui` at `5eeed22a2f42a842d26c9bd000b06c02d245103c`.

OpenCode mounts messages in a native sticky ScrollBox and uses actual child coordinates for message jumps, excluding tool-only messages. This is a useful full-mount reference, but offers less granular navigation than Vimex. Its tool spacing is updated during the lifecycle pass before Yoga, with first-frame insertion/removal assertions.

- [Mounted message list](https://github.com/anomalyco/opencode/blob/2406400f0aeb07b36d0495af4e05aaca49159832/packages/tui/src/routes/session/index.tsx#L1180)
- [Native-coordinate navigation](https://github.com/anomalyco/opencode/blob/2406400f0aeb07b36d0495af4e05aaca49159832/packages/tui/src/routes/session/index.tsx#L377)
- [Pre-layout spacing](https://github.com/anomalyco/opencode/blob/2406400f0aeb07b36d0495af4e05aaca49159832/packages/tui/src/util/layout.ts)
- [First-frame regression](https://github.com/anomalyco/opencode/blob/2406400f0aeb07b36d0495af4e05aaca49159832/packages/tui/test/cli/tui/inline-tool-wrap-snapshot.test.tsx#L337)

Current upstream OpenTUI distinguishes lifecycle, layout, and painting phases. Vimex pins 0.5.11; an upstream mechanism must be checked against that installed version before adoption. Local inspection establishes that its `FRAME` event fires after native rendering; the current Vimex layout hook performs anchor correction on that event.

- [Upstream lifecycle and layout order](https://github.com/anomalyco/opentui/blob/5eeed22a2f42a842d26c9bd000b06c02d245103c/packages/core/src/Renderable.ts#L1780)

### Updated decision boundary

Retain windowing if we can prepare and paint coherent destinations within the input latency budget. A fully mounted control deserves empirical evaluation at realistic sizes; a small control succeeding does not justify discarding bounded rendering. Larger overscan or additional settlement frames alone do not satisfy the user-visible requirement. See the investigation for baseline results and the devil's advocate assessment.

## Architecture methods

Juval Löwy's volatility-based decomposition advises decomposing around likely sources of change rather than use-case steps. The Method does not require literal folders for every layer.

- [Volatility-Based Decomposition excerpt](https://www.informit.com/articles/article.aspx?p=2995357&seqNum=2)
- [IDesign Architect's Master Class](https://www.idesign.net/Training/Architect-Master-Class)

Martin Fowler's Presentation Model provides a home for UI behavior independent of widgets, while warning that synchronization models and mappers add coordination cost. His event-driven discussion also distinguishes derived read models from independent authorities.

- [Presentation Model](https://martinfowler.com/eaaDev/PresentationModel.html)
- [GUI Architectures](https://martinfowler.com/eaaDev/uiArchs.html)
- [What do you mean by “Event-Driven”?](https://martinfowler.com/articles/201701-event-driven.html)
- [Who Needs an Architect?](https://martinfowler.com/ieeeSoftware/whoNeedsArchitect.pdf)

### Application to Vimex

| Role            | Vimex responsibility                                              |
| --------------- | ----------------------------------------------------------------- |
| Client          | `TranscriptViewport` and OpenTUI components                       |
| Manager         | `TranscriptRuntime`; upstream `VimexController`                   |
| Engines         | projection, navigation, measurement composition, window planning  |
| Resource access | Codex gateway now; optional history loader only if paging arrives |
| Resources       | canonical conversation state and disposable native geometry       |

These are reasoning tools, not directory names.

## Adopt, adapt, reject

| Pattern                                    | Decision                     |
| ------------------------------------------ | ---------------------------- |
| One canonical content model                | Adopt                        |
| Detached viewport/presentation pin         | Adopt                        |
| Stateful renderer-neutral render model     | Adopt as `TranscriptRuntime` |
| Explicit partial/full damage               | Adopt at block granularity   |
| Bounded ingress and event draining         | Adopt                        |
| Revision-guarded incremental updates       | Adopt                        |
| Safe full-rebuild fallback                 | Adopt                        |
| Multiple presentations of one state        | Adopt                        |
| Terminal cell coordinates as identity      | Reject                       |
| Second authoritative history/tail store    | Reject                       |
| Full transcript clone on every update      | Reject                       |
| Item-only Stage 5 virtualization           | Reject; use render blocks    |
| Literal architecture-role folder hierarchy | Reject                       |
| New transcript-runtime package now         | Reject                       |
| Persisted native geometry                  | Reject                       |

## Questions to validate through implementation

- What bounded settlement cadence gives the best latency/throughput trade-off under real Codex streams?
- Which Markdown block identity remains stable enough across incremental reparses?
- At what damage ratio is a full frame cheaper than incremental reconciliation?
- What cache budget and reset policy prevent large one-off content from pinning memory?
- Which OpenTUI measurements can be obtained without depending on unstable private fields?
- When does indexed search become necessary independently of renderer windowing?

Answer these with benchmarks and regression tests. Do not answer them by adding topology in advance.
