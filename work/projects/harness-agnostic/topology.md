# Harness-Agnostic Repository Topology

## Design rule

Stable domain and application concepts remain inward. Provider protocols, authentication, process lifecycle, and billing observations remain outward. The first refactor adds a harness boundary around the existing domains; it does not create a second parallel conversation domain.

```text
                         provider volatility
                                /
conversation / transcript / workbench
              ^
              |
       existing typed application ports
              ^
              |
composition-only harness registry/factory
              |
              +--> current @vimex/codex-app-server
              +--> future harness-codex
              +--> future harness-cursor / claude / opencode

The first phase intentionally keeps the registry at the composition root. `RuntimeConnection` and `RuntimeEvent` currently live in `workbench`, while the Codex package imports them; importing a new harness package into workbench before moving those ports would create a dependency cycle.
```

## Target tree

```text
vimex/
├── apps/
│   ├── cli/
│   └── tui/
│       └── src/
│           ├── composition-root.ts
│           ├── cli-options.ts
│           └── harness-selection.ts
│
├── packages/
│   ├── harness/
│   │   └── src/
│   │       ├── messages/
│   │       │   ├── envelope.ts                # target
│   │       │   ├── cursor.ts                  # target
│   │       │   └── operation.ts               # target
│   │       ├── application/
│   │       │   ├── harness-registry.ts
│   │       │   ├── harness-discovery.ts
│   │       │   └── capability-negotiation.ts
│   │       ├── domain/
│   │       │   ├── harness-id.ts
│   │       │   ├── harness-manifest.ts
│   │       │   ├── harness-profile.ts
│   │       │   ├── auth-status.ts
│   │       │   └── capabilities.ts
│   │       ├── ports/
│   │       │   ├── harness-control.ts
│   │       │   ├── harness-session.ts
│   │       │   ├── harness-events.ts
│   │       │   └── harness-process.ts
│   │       └── index.ts
│   │
│   ├── harness-codex/                 # target name; not first-phase source path
│   │   └── src/
│   │       ├── generated/
│   │       │   └── <codex-version>/
│   │       ├── transport/
│   │       ├── rpc/
│   │       ├── mapping/
│   │       ├── capabilities/
│   │       ├── codex-adapter.ts
│   │       ├── codex-auth.ts
│   │       └── index.ts
│   │
│   ├── harness-cursor/
│   │   └── src/
│   │       ├── acp-client.ts
│   │       ├── cursor-adapter.ts
│   │       ├── cursor-mapper.ts
│   │       ├── cursor-auth.ts
│   │       └── index.ts
│   │
│   ├── harness-claude-code/
│   │   └── src/
│   │       ├── cli-client.ts
│   │       ├── claude-adapter.ts
│   │       ├── claude-mapper.ts
│   │       ├── claude-auth.ts
│   │       └── index.ts
│   │
│   ├── harness-opencode/
│   │   └── src/
│   │       ├── client.ts
│   │       ├── opencode-adapter.ts
│   │       ├── opencode-mapper.ts
│   │       ├── opencode-auth.ts
│   │       └── index.ts
│   │
│   ├── conversation/
│   │   └── src/
│   │       ├── domain/
│   │       │   ├── identifiers.ts
│   │       │   ├── thread.ts
│   │       │   ├── turn.ts
│   │       │   ├── item.ts
│   │       │   ├── events.ts
│   │       │   └── reduce-conversation.ts
│   │       ├── application/
│   │       │   └── conversation-gateway.ts
│   │       └── index.ts
│   │
│   ├── transcript/
│   │   └── src/
│   │       ├── runtime.ts
│   │       ├── window.ts
│   │       ├── geometry.ts
│   │       ├── navigation.ts
│   │       └── markdown-source-map.ts
│   │
│   ├── composer/
│   │   └── src/index.ts
│   ├── interaction/
│   │   └── src/index.ts
│   ├── approvals/
│   │   └── src/
│   │       ├── domain/approval.ts
│   │       ├── domain/approval-state.ts
│   │       └── application/approval-gateway.ts
│   ├── workbench/
│   │   └── src/application/
│   │       ├── workbench-controller.ts
│   │       ├── runtime-connection.ts
│   │       ├── conversation-ingress.ts
│   │       ├── conversation-projector.ts
│   │       ├── model-catalog.ts
│   │       ├── workbench-state.ts
│   │       ├── session-command-queue.ts       # target
│   │       ├── lifecycle-state.ts              # target
│   │       └── diagnostics.ts                  # target
│   ├── ui-opentui-react/
│   │   └── src/
│   │       ├── app/
│   │       ├── transcript/
│   │       ├── composer/
│   │       ├── approvals/
│   │       ├── keymap/
│   │       └── renderers/
│   ├── workspace/                     # future extraction; not present today
│   │   └── src/
│   │       ├── process-supervisor.ts
│   │       ├── session-store.ts
│   │       └── checkpoint-store.ts
│   ├── platform-node/
│   ├── distribution/
│   └── testkit/
│
├── plugins/
│   └── herdr/
│
└── work/projects/
    ├── v1/
    └── harness-agnostic/
```

## Package responsibilities

### `harness`

In the target design, this owns the adapter ports, manifests, discovery, capability negotiation, and auth status shape. In the first implementation it is composition-only: a registry/factory may return the existing `ConversationGateway`, `ApprovalGateway`, `RuntimeConnection`, and `ModelCatalog` bundle, but workbench does not yet import it.

### `harness-codex`

Target owner of the Codex app-server implementation. Today that implementation remains in `packages/codex-app-server/src/codex-gateway.ts` and is constructed by `apps/tui/src/composition-root.ts`. Generated types remain private here after the move.

### `conversation`

Remains the stable conversation domain. It owns Vimex threads, turns, items, normalized conversation events, and typed conversation operations. A new `agent-core` package is deferred until a real cross-harness concept cannot fit here cleanly.

### `workbench`

Owns application policy and projections. It sends normalized commands and consumes normalized events. It chooses no concrete harness.

### `workspace` and `platform-node`

`platform-node` currently owns most host concerns, including `JsonStore`; `workspace` is a future extraction for process lifecycle, worktrees, and checkpoints. Harness packages use these through ports or narrowly scoped infrastructure helpers.

## Call chains

### Application startup and Codex selection

```text
apps/tui/src/composition-root.ts
  -> harness registry/factory (composition only)
  -> current @vimex/codex-app-server
  -> codex-auth.ts and Codex process launcher
  -> transport/stdio-transport.ts
  -> rpc/json-rpc-client.ts
  -> {ConversationGateway, ApprovalGateway, RuntimeConnection, ModelCatalog}
  -> VimexController / ui-opentui-react
```

### Prompt and streaming

```text
OpenTUI key event
  -> ui-opentui-react key binding
  -> interaction named command
  -> workbench-controller.ts
  -> ConversationGateway.startTurn()
  -> current codex-gateway.ts
  -> rpc/json-rpc-client.ts
  -> Codex turn/start request

Codex notification
  -> json-rpc-client.ts
  -> mapping/map-notification.ts
  -> RuntimeEvent / ConversationEvent
  -> workbench/conversation-ingress.ts
  -> conversation reducer and projector
  -> transcript/runtime.ts
  -> UI transcript renderer
```

### Approval request

```text
Codex server request
  -> harness-codex/codex-approval-gateway.ts
  -> approvals domain event
  -> workbench approval projection
  -> UI approval overlay
  -> approvals/approval-gateway.ts
  -> harness-codex response mapper
  -> JSON-RPC response to Codex
```

### Reconnect and future replay

```text
adapter disconnect
  -> RuntimeConnection.disconnected
  -> workbench preserves draft and view state
  -> adapter reconnects
  -> optional HarnessEventStream.history(afterCursor)
  -> cursor dedupe / stale-event filter
  -> ConversationIngress
  -> projector settles canonical state
```

### Future adapter selection

```text
profile: cursor
  -> harness registry
  -> harness-cursor/cursor-adapter.ts
  -> acp-client.ts or Cursor API client
  -> cursor-mapper.ts
  -> existing ConversationGateway / RuntimeConnection ports
  -> unchanged workbench and UI
```

## Dependency direction

```text
apps/tui/composition-root.ts
  -> harness registry/factory
  -> current @vimex/codex-app-server (first phase)
  -> existing application ports

ui-opentui-react
  -> workbench
  -> conversation / transcript / approvals / interaction
  -> platform-node

ui-opentui-react -> workbench and renderer-neutral domain types
workbench         -> conversation, transcript, approvals, existing application ports
current codex gateway -> workbench, conversation, approvals
harness-codex     -> target harness ports and existing normalized application types
harness           -> no concrete adapter
conversation      -> no harness package
transcript        -> no harness package
ui                -> no harness package
```

The composition root is the only place that selects a concrete harness. No React component, transcript reducer, or Vim command may import `harness-codex`.

## Message ownership

```text
Harness wire message
  -> harness adapter decoder
  -> provider mapper
  -> RuntimeEvent / ConversationEvent
  -> workbench/conversation-ingress.ts
  -> conversation/workbench projector
  -> transcript runtime
  -> UI selector
```

The reverse path is:

```text
UI intent
  -> named Vim command
  -> workbench command
  -> typed application port
  -> harness facade
  -> harness adapter
  -> provider request
```

The resilience path is:

```text
harness adapter
  -> decode and validate
  -> provider identity and cursor mapping
  -> RuntimeEvent / ConversationEvent
  -> workbench/conversation-ingress.ts
  -> conversation reducer
  -> optional session snapshot
  -> workbench projection
  -> transcript runtime
  -> UI recovery state
```

## Migration compatibility

`@vimex/codex-app-server` may temporarily re-export `@vimex/harness-codex` so existing imports keep compiling while package ownership moves. The compatibility export should be removed after the composition root and tests use the new package.

The boundary verifier and workspace package manifests must encode these rules. A concrete adapter must never become a dependency of `conversation`, `transcript`, or the UI.

### Concrete first-phase files

```text
apps/tui/src/composition-root.ts
  -> packages/codex-app-server/src/codex-gateway.ts
  -> packages/workbench/src/application/runtime-connection.ts
  -> packages/conversation/src/application/conversation-gateway.ts
  -> packages/approvals/src/application/approval-gateway.ts

Target after the bridge is proven:
apps/tui/src/composition-root.ts
  -> packages/harness/src/application/harness-registry.ts
  -> packages/harness-codex/src/codex-adapter.ts
  -> the same four existing ports
```
