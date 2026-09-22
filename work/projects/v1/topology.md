# Vimex v1 Repository Topology

## Approach

Use a Bun workspace modular monolith. Packages mark bounded contexts and volatile integrations while producing one application. Avoid generic top-level `components`, `hooks`, `services`, and `stores` directories because they erase ownership.

## Proposed tree

```text
vimex/
├── apps/
│   └── tui/
│       ├── src/
│       │   ├── main.tsx
│       │   ├── composition-root.ts
│       │   ├── lifecycle.ts
│       │   └── cli-options.ts
│       └── package.json
│
├── packages/
│   ├── conversation/
│   │   └── src/
│   │       ├── domain/
│   │       │   ├── thread.ts
│   │       │   ├── turn.ts
│   │       │   ├── item.ts
│   │       │   ├── identifiers.ts
│   │       │   ├── events.ts
│   │       │   └── reduce-conversation.ts
│   │       ├── application/
│   │       │   ├── conversation-gateway.ts
│   │       │   ├── start-turn.ts
│   │       │   ├── steer-turn.ts
│   │       │   ├── interrupt-turn.ts
│   │       │   ├── fork-thread.ts
│   │       │   └── switch-thread.ts
│   │       └── index.ts
│   │
│   ├── transcript/
│   │   └── src/
│   │       ├── domain/
│   │       │   ├── transcript-document.ts
│   │       │   ├── transcript-node.ts
│   │       │   ├── logical-position.ts
│   │       │   ├── viewport-anchor.ts
│   │       │   ├── selection.ts
│   │       │   ├── fold-state.ts
│   │       │   ├── markdown-source-map.ts
│   │       │   └── url-target.ts
│   │       ├── application/
│   │       │   ├── project-conversation.ts
│   │       │   ├── move-cursor.ts
│   │       │   ├── copy-selection.ts
│   │       │   ├── toggle-fold.ts
│   │       │   └── open-url.ts
│   │       ├── runtime.ts
│   │       ├── window.ts
│   │       └── index.ts
│   │
│   ├── composer/
│   │   └── src/
│   │       ├── domain/
│   │       │   ├── draft.ts
│   │       │   ├── draft-by-thread.ts
│   │       │   └── submission-intent.ts
│   │       ├── application/
│   │       │   ├── composer-controller.ts
│   │       │   └── submit-draft.ts
│   │       └── index.ts
│   │
│   ├── interaction/
│   │   └── src/
│   │       ├── vim/
│   │       │   ├── mode.ts
│   │       │   ├── state-machine.ts
│   │       │   ├── motion.ts
│   │       │   ├── operator.ts
│   │       │   ├── count.ts
│   │       │   └── key-sequence.ts
│   │       ├── commands/
│   │       │   ├── registry.ts
│   │       │   ├── parser.ts
│   │       │   └── command-line.ts
│   │       ├── focus/
│   │       │   └── focus-controller.ts
│   │       └── index.ts
│   │
│   ├── approvals/
│   ├── workbench/
│   │   └── src/
│   │       └── application/
│   │           ├── conversation-ingress.ts
│   │           ├── conversation-projector.ts
│   │           ├── live-activity.ts
│   │           └── workbench-controller.ts
│   │
│   ├── ui-opentui-react/
│   │   └── src/
│   │       ├── app/
│   │       │   ├── App.tsx
│   │       │   ├── FullscreenShell.tsx
│   │       │   └── ErrorBoundary.tsx
│   │       ├── transcript/
│   │       │   ├── TranscriptViewport.tsx
│   │       │   ├── TranscriptNode.tsx
│   │       │   ├── TurnActivity.tsx
│   │       │   ├── AgentActivity.tsx
│   │       │   ├── MarkdownMessage.tsx
│   │       │   ├── ToolCall.tsx
│   │       │   ├── FileChange.tsx
│   │       │   ├── ReasoningBlock.tsx
│   │       │   ├── use-transcript-runtime.ts
│   │       │   ├── measure-rendered-block.ts
│   │       │   ├── SelectionOverlay.tsx
│   │       │   └── NewOutputMarker.tsx
│   │       ├── composer/
│   │       │   ├── Composer.tsx
│   │       │   └── CommandLine.tsx
│   │       ├── sessions/
│   │       ├── approvals/
│   │       ├── statusline/
│   │       ├── keymap/
│   │       │   ├── normal-bindings.ts
│   │       │   ├── insert-bindings.ts
│   │       │   ├── visual-bindings.ts
│   │       │   └── command-bindings.ts
│   │       ├── renderers/
│   │       │   ├── registry.ts
│   │       │   └── unknown-item.tsx
│   │       └── theme/
│   │
│   ├── codex-app-server/
│   │   └── src/
│   │       ├── generated/
│   │       │   └── <codex-version>/
│   │       ├── transport/
│   │       │   ├── transport.ts
│   │       │   ├── stdio-transport.ts
│   │       │   └── websocket-transport.ts
│   │       ├── rpc/
│   │       │   ├── json-rpc-client.ts
│   │       │   ├── request-router.ts
│   │       │   └── pending-requests.ts
│   │       ├── mapping/
│   │       │   ├── map-thread.ts
│   │       │   ├── map-item.ts
│   │       │   ├── map-notification.ts
│   │       │   └── map-server-request.ts
│   │       ├── capabilities/
│   │       ├── codex-gateway.ts
│   │       └── codex-approval-gateway.ts
│   │
│   ├── platform-node/
│   │   └── src/
│   │       ├── clipboard/
│   │       ├── urls/
│   │       ├── persistence/
│   │       ├── process/
│   │       └── index.ts
│   │
│   └── testkit/
│       └── src/
│           ├── fake-conversation-gateway.ts
│           ├── fake-codex-server.ts
│           ├── transcript-builders.ts
│           └── terminal-driver.ts
│
├── plugins/
│   └── herdr/
│       ├── src/
│       │   ├── herdr-plugin.ts
│       │   ├── herdr-client.ts
│       │   ├── lifecycle-reporter.ts
│       │   ├── session-reporter.ts
│       │   └── metadata-reporter.ts
│       └── package.json
│
├── tests/
│   ├── contract/
│   │   ├── codex-protocol.test.ts
│   │   └── fixtures/
│   ├── acceptance/
│   │   ├── streaming-anchor.test.ts
│   │   ├── vim-navigation.test.ts
│   │   ├── visual-copy.test.ts
│   │   ├── fork-thread.test.ts
│   │   └── approval-flow.test.ts
│   └── terminal/
│       ├── fullscreen-smoke.test.ts
│       └── terminal-restoration.test.ts
│
├── work/
│   └── projects/
│       └── v1/
├── scripts/
│   ├── generate-codex-types.ts
│   └── verify-boundaries.ts
├── package.json
├── tsconfig.base.json
└── bun.lock
```

Directories should be added when their first real file is needed rather than scaffolding the entire tree at once.

## Dependency direction

```text
apps/tui
  -> ui-opentui-react
  -> codex-app-server
  -> platform-node
  -> plugins/herdr

ui-opentui-react -> application APIs -> pure domains
codex-app-server -> application ports
platform-node -> application ports
plugins/herdr -> application ports and read models
```

## Import rules

1. Domain code imports no React, OpenTUI, Zustand, Bun, Node, generated Codex types, or Herdr types.
2. Application code declares ports and orchestrates domains; it does not select concrete adapters.
3. UI code consumes application commands and selectors; it never imports generated Codex types.
4. Generated code is never hand-edited.
5. Only `apps/tui/src/composition-root.ts` selects concrete adapters.
6. Each package exports a narrow public surface from `index.ts`.
7. Cross-package deep imports into another package's `src` are rejected by lint or a boundary script.
8. Tests may use `testkit`; production packages may not.
9. `transcript` defines renderer-neutral frame, window, damage, and measurement contracts; it never imports `workbench`, React, or OpenTUI.
10. `workbench` owns transcript-runtime lifetimes. UI bridges subscribe through public contracts and may report measurements, but they do not own canonical or semantic transcript state.

## Volatility boundaries

| Likely source of change                                         | Contained in             |
| --------------------------------------------------------------- | ------------------------ |
| Codex schemas and RPC methods                                   | `codex-app-server`       |
| OpenTUI APIs and React rendering                                | `ui-opentui-react`       |
| Herdr protocol                                                  | `plugins/herdr`          |
| Clipboard and URL behavior by OS or terminal                    | `platform-node`          |
| Vim grammar and command semantics                               | `interaction`            |
| Transcript selection and reflow invariants                      | `transcript`             |
| Transcript presentation revisions, damage, and windowing policy | `transcript`             |
| Streaming settlement and presentation lifetime                  | `workbench`              |
| Native block measurement and terminal rendering                 | `ui-opentui-react`       |
| Product presentation                                            | UI themes and components |

## Package creation rule

The tree describes ownership, not a demand for empty packages. Start with the vertical slice identified in the roadmap. Extract or fill each package as behavior appears, while preserving the dependency direction from the first commit.

## Current transcript coordination

`packages/transcript/src/runtime.ts` owns each presentation frame, geometry generation, accepted block measurements, and follow/detached policy. `packages/transcript/src/geometry.ts` owns renderer-neutral immutable block geometry and global row composition. Pure semantic navigation and viewport anchors remain under `packages/transcript/src/application`.

Within the OpenTUI adapter, `measure-rendered-block.ts` is the single module allowed to inspect private native text, Markdown, table, and diff state. `rendered-layout.ts` owns dirty-block scheduling, native placement, and cached scroll translation; it reports guarded batches to the runtime rather than keeping a competing production geometry cache. `layout.ts` reads runtime indexes for visual-row navigation, `use-transcript-layout.ts` restores semantic anchors, and `TranscriptViewport.tsx` owns native scrolling input and stable render-block roots. `app/App.tsx` composes these capabilities and refreshes cached viewport translation before hardware-cursor visibility decisions.

## Transcript runtime target topology

[Transcript runtime](./transcript-runtime.md) is the normative design, [transcript runtime research](./transcript-runtime-research.md) records its evidence, and [the implementation ledger](./transcript-runtime-implementation.md) records delivery status.

The package dependency direction is:

```text
apps/tui composition root
  -> workbench
       -> conversation
       -> transcript
  -> ui-opentui-react
       -> workbench public APIs
       -> transcript public contracts

codex-app-server
  -> ConversationEvent boundary
```

The runtime data and feedback path is:

```text
Codex notification
  -> mapper
  -> bounded workbench ingress
  -> canonical ConversationState
  -> semantic TranscriptState
  -> presentation-owned TranscriptRuntime
  -> immutable TranscriptFrame
  -> React bridge
  -> OpenTUI render
       |
       `-> block measurements -> TranscriptRuntime
```

Workbench owns a `TranscriptRuntime` for each stable presentation identity, such as the main pane or a side pane. A runtime may outlive a React mount and is disposed only when its presentation is retired or the application shuts down. Two presentations of one thread have independent follow mode, displayed revision, window, damage, and disposable geometry while sharing canonical conversation and semantic per-thread state.

The React bridge subscribes to cached frame snapshots, sends semantic commands through workbench, and reports renderer measurements. Measurement feedback may change disposable layout knowledge; it may not mutate canonical conversation data or semantic positions. A thread change within a presentation causes a guarded full presentation rebuild rather than reusing revision relationships across threads.

Stages 2–4 are complete: the runtime still uses a pass-through window, while native measurement sits behind `measure-rendered-block.ts`. Geometry retains one current immutable variant per materialized block, and width/style/syntax/renderer uncertainty resets the layout generation. Workbench publishes cached layout and pane read models whose identities change only with their narrow semantic inputs; React panes subscribe independently, and persistence and Herdr observe semantic signatures rather than canonical token cadence. Normal scheduled ingress work is capped at 64 distinct streams per turn with zero-delay continuation, while semantic and lifecycle boundaries remain atomic. Stage 5 may replace the pass-through planner with block windowing without changing the renderer contract: `TranscriptFrame.blocks` remains the complete lightweight plan, `TranscriptFrame.window.blocks` becomes the native-mounted and measured subset, and stable block IDs, render payloads, half-open source spans, activity footprints, spacers, overscan, and logical target materialization are already explicit. [The windowing implementation ledger](./transcript-windowing-implementation.md) owns that next implementation stage.

File-change presentation remains under `packages/ui-opentui-react/src/transcript/`: `FileChange.tsx` renders per-file patches, `diff-summary.ts` owns presentation counts and native language names, and `diff-layout.test.tsx` validates source-to-screen mapping through `rendered-layout.ts`. Server metadata mapping remains in the Codex adapter; no Git or filesystem responsibility is added to transcript rendering.

Syntax grammar registration belongs to `packages/ui-opentui-react/src/syntax/`; pinned grammar binaries, highlight queries, licenses, and provenance belong to its `assets/parsers/` directory. The executable composition root calls the UI adapter’s registration entry point for these local assets before native Markdown or diff renderables are created. Grammars load lazily; domain packages remain independent of highlighting technology.

Flash presentation and visible-cell target indexing live under `ui-opentui-react/src/transcript/` (`FlashJump.tsx`, `flash-targets.ts`). Label overlays never alter canonical transcript text. Jump history and named marks belong to transcript state/operations; workbench local-state stores source offsets for resume and owns focus transitions. Terminal key disambiguation stays in the UI keymap.

Cross-session cursor/viewport history belongs to `workbench/src/application/navigation-history.ts`; it stores bounded semantic locations, leaving native geometry in the renderer and per-thread drafts in their workspaces.

Side-chat application state lives in `workbench/src/application/side-chat.ts`, separate from thread transport and screen layout. Retirement and retained parent/child associations persist through local state. `ui-opentui-react/src/side-chat/SideChatLayout.tsx` arranges persistent pane Apps; `pane-geometry.tsx` supplies pane-local dimensions and screen origins to Markdown diffs, Flash labels, composers, and overlays. Focus gates input and hardware-cursor ownership, while both transcripts continue receiving events.

`workbench/src/application/goal-command.ts` adapts goal commands to server-owned persisted goal state. `compaction.ts` owns the asynchronous per-thread compaction lifecycle. Their protocol mappings stay in the Codex adapter; neither feature implements a second agent harness or artificial continuation loop.

## Distribution milestone (0.1.0)

The proposed global CLI and distribution context are documented in [CLI architecture](../../../docs/cli-architecture.md). This is an additive proposal; apps/tui remains the current source entry point. The offline guide lives in ui-opentui-react/src/help. scripts/generate-manual.ts derives its embedded content and docs/man/vimex.1 from docs/manual.md; docs:check prevents drift.
