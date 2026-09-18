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
│   │       │   ├── MarkdownMessage.tsx
│   │       │   ├── ToolCall.tsx
│   │       │   ├── FileChange.tsx
│   │       │   ├── ReasoningBlock.tsx
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

## Volatility boundaries

| Likely source of change | Contained in |
|---|---|
| Codex schemas and RPC methods | `codex-app-server` |
| OpenTUI APIs and React rendering | `ui-opentui-react` |
| Herdr protocol | `plugins/herdr` |
| Clipboard and URL behavior by OS or terminal | `platform-node` |
| Vim grammar and command semantics | `interaction` |
| Transcript selection and reflow invariants | `transcript` |
| Product presentation | UI themes and components |

## Package creation rule

The tree describes ownership, not a demand for empty packages. Start with the vertical slice identified in the roadmap. Extract or fill each package as behavior appears, while preserving the dependency direction from the first commit.


## Implemented transcript coordination

Within `packages/ui-opentui-react/src/transcript`, `use-transcript-layout.ts` coordinates frame measurement and reading-anchor restoration, `rendered-layout.ts` maps native cells, `layout.ts` provides visual-row navigation, and `TranscriptViewport.tsx` owns native scrolling input. `app/App.tsx` composes these capabilities rather than owning their geometry lifecycle. Pure semantic navigation and viewport anchors remain under `packages/transcript/src/application`.
