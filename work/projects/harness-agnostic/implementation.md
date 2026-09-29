# Harness-Agnostic Refactor Implementation Plan

## Strategy

Move the boundary before adding providers. Keep the existing Codex behavior as the compatibility oracle. Each phase leaves the application runnable and has a small verification gate.

```text
current Codex gateway
        |
        v
compatibility harness facade
        |
        v
Codex adapter behind registry
        |
        +--> future Cursor ACP adapter
        +--> future Claude Code adapter
        +--> future OpenCode adapter
```

## Phase 0: record the current contract

Before moving code:

- Confirm `git status` and active claims.
- Record the current Codex startup path in the composition root.
- Identify all imports from `@vimex/codex-app-server`.
- Identify Codex-specific types that cross into `conversation`, `workbench`, approvals, and UI.
- Add or preserve contract fixtures for startup, streaming, tools, edits, approvals, questions, interruption, resume, fork, and disconnect.

Exit gate:

- The existing default checks pass.
- The list of provider-specific imports is known.

## Phase 1: add the harness ports without replacing the domains

Create `packages/harness` with:

- `HarnessManifest`;
- `HarnessProfile` and auth status;
- registry and discovery;
- capability negotiation;
- typed `HarnessControl`, `HarnessSession`, and `HarnessEventStream` ports;
- process lifecycle port.

Do not create a second full conversation model yet. Re-export or alias the existing application types where needed.

The initial contract preserves typed operations:

```text
HarnessControl
  start / resume / list / fork / model catalog / auth status

HarnessSession
  prompt / steer / interrupt / approval response / question response

HarnessEventStream
  subscribe / optional history(after cursor) / close
```

Exit gate:

- A fake harness can be injected through the existing gateway bundle.
- Unsupported operations produce structured results.
- No provider type enters `packages/harness`.

Implementation note: do not make `workbench` import `packages/harness` yet. The current `RuntimeConnection` and `RuntimeEvent` are workbench-owned and the current Codex gateway imports workbench. Start with a composition-root factory whose return type is the existing four-port bundle:

```text
HarnessAdapterFactory
  -> ConversationGateway
  -> ApprovalGateway
  -> RuntimeConnection
  -> ModelCatalog
```

## Phase 2: put Codex behind the compatibility factory

Add `createCodexHarness()` beside the existing `createCodexGateways()` in `packages/codex-app-server/src/codex-gateway.ts`, and select it from `apps/tui/src/composition-root.ts`. Do not rename the package until startup parity is proven. The later move from `packages/codex-app-server` to `packages/harness-codex` is a packaging change, not a prerequisite for the architectural boundary.

Keep these concerns inside the Codex package:

- generated protocol types;
- stdio transport;
- JSON-RPC correlation;
- server-request handling;
- Codex wire-to-domain mapping;
- Codex auth and executable startup;
- Codex-specific approval and question translation.

The adapter may initially implement the existing `ConversationGateway`, `RuntimeConnection`, `ApprovalGateway`, and `ModelCatalog` ports directly. This is the low-risk compatibility facade. The workbench no longer constructs a Codex client directly.

Use a temporary compatibility export if needed:

```text
@vimex/codex-app-server -> @vimex/harness-codex
```

Exit gate:

- Codex starts through the composition-root registry/factory.
- Existing Codex tests and fixtures still pass.
- No generated Codex type is imported outside `harness-codex`.

The package-name condition is temporarily phrased as “outside the Codex adapter”; it becomes literally true after the package move.

## Phase 3: update composition and boundaries

Change `apps/tui/src/composition-root.ts` to select a manifest and adapter from the registry. Keep Codex as the default when no harness is configured.

Update:

- workspace package manifests;
- `scripts/verify-boundaries.ts`;
- package exports;
- testkit fakes;
- distribution diagnostics;
- help and configuration text.

Exit gate:

- `vimex` with no new configuration starts Codex exactly as before.
- Boundary verification rejects UI or domain imports of concrete adapters.
- A harness diagnostic reports availability without starting a session.

## Phase 4: add identity, correlation, and event policy

Add explicit mapping for Vimex IDs versus provider session, turn, message, part, and tool IDs, including parent, child, and side relationships.

Separate transient signals from durable facts:

```text
provider delta -> ConversationIngress accumulator -> transient UI update
provider completion/tool/edit -> normalized durable fact -> canonical projection
```

Validate normalized events at the adapter boundary. Keep unknown provider messages in a bounded diagnostic channel.

Exit gate:

- Rapid prompt, steer, interrupt, and reconnect tests are deterministic.
- A late event cannot overwrite a newer state.
- Provider IDs never become Vimex domain IDs implicitly.

Do not introduce a second generic actor in this phase. `workbench/conversation-ingress.ts` remains the current event serializer and coalescer.

The first concrete additions should be adapter-local correlation and diagnostics. Add cross-package envelopes, cursors, and operation ledgers only after the existing synchronous `RuntimeConnection.subscribe()` bridge has a tested owner.

## Phase 5: make lifecycle transitions durable

Document and test explicit state machines for session and process health, turns, tools, approvals, and user-originated operations.

Apply the durability laws:

- transitions are monotonic;
- duplicate events are idempotent;
- stale events are rejected;
- ambiguous operations become `unknown`;
- provider and process health remain separate.

Add operation IDs to prompts, steer messages, interrupts, approval responses, forks, and handoffs. Never silently retry an operation whose provider outcome is unknown.

Exit gate:

- lifecycle tests cover duplicate, stale, late, and missing events;
- a process exit during a turn preserves the draft and marks the outcome honestly.

## Phase 6: make UI features capability-aware

Replace assumptions such as “every session has Codex goals” with capability checks.

Examples:

- hide or disable fork when unavailable;
- show a normal notice when usage is not exposed;
- render generic permission requests;
- retain provider-specific activity as diagnostic details;
- keep the current Codex UI unchanged when Codex advertises the capability.

Exit gate:

- A minimal fake harness with only prompt, streaming, and interrupt works in the workbench.
- Codex retains its richer behavior.

## Phase 7: define optional replay without implementing a database

Add the shape of a future cursor/replay port:

```ts
interface HarnessEventStream {
  subscribe(afterCursor?: string): AsyncIterable<Envelope<RuntimeEvent>>
  history?(afterCursor?: string): Promise<readonly Envelope<RuntimeEvent>[]>
}
```

For Codex, initially use existing resume and in-memory state. Do not persist every token. Persist durable facts only when a real reconnect or idle-process requirement needs them.

Exit gate:

- Reconnect behavior is documented and tested.
- Duplicate and stale events have deterministic handling.
- The implementation does not claim durable replay until the selected harness supports it.

Replay remains future-facing until the contract defines cursor scope, replay boundaries, cancellation/backpressure, and snapshot authority. The current implementation has in-memory state and resume behavior, not durable replay.

## Phase 8: move composition and configuration

Add harness selection to the composition root and configuration. The initial default remains Codex.

Example configuration shape:

```json
{
  "harness": "codex",
  "harnesses": {
    "codex": {
      "executable": "codex",
      "auth": "cli-login"
    }
  }
}
```

Configuration should identify a harness and executable/profile. Secret material remains with the harness or host environment.

Exit gate:

- `vimex` with no new configuration starts Codex exactly as before.
- A test configuration can select a fake harness.
- `vimex harness list` or an equivalent diagnostic reports availability without starting a session.

## Phase 9: future adapters

Only after the Codex migration is stable:

### Cursor ACP

Implement a JSON-RPC stdio client for `agent acp`. Map session updates, permission requests, cancellation, and Cursor extension notifications into normalized events. Cursor ACP is a natural second adapter because its stream and permission model resemble the existing Codex app-server flow.

### Claude Code

Use the provider's supported CLI or SDK surface. Keep Claude-specific auth, tool events, skills, and subagents inside `harness-claude-code`.

### OpenCode

Use OpenCode's supported local client surface. Preserve its provider configuration and model catalog behind the adapter.

Each future adapter must pass the same adapter contract suite before it gets UI-specific work.

## Testing plan

### Existing domain and port tests

- conversation, transcript, approvals, composer, interaction, and workbench tests remain the primary regression suite;
- add narrow harness-port tests for capability checks and structured failures;
- add stale-event and disconnect tests at the existing ingress boundary;
- do not create a second event scheduler merely to test the new facade.

### Adapter contract tests

Every adapter should prove:

- startup and handshake;
- prompt and streamed deltas;
- tool lifecycle;
- permission request and response;
- interruption;
- completion and failure;
- unknown message handling;
- clean close.

### Codex wire tests

Keep generated types and recorded fixtures inside `harness-codex`. Test exact JSON-RPC behavior there rather than leaking it into workbench tests.

### UI tests

Use fake normalized events. UI tests should not launch Codex or depend on provider credentials.

### Fault-injection tests

Inject duplicate and out-of-order events, malformed messages, missing completions, replay after a cursor, stale events after reconnect, process exit during a turn, late completion after interruption, overlapping tools, duplicate approval responses, disconnect with a pending approval, bounded diagnostic overflow, and projector or renderer failures.

Each test must assert deterministic state, retained user work, and an actionable diagnostic.

## Refactor hazards

### Creating a duplicate core domain

Do not move every conversation type into a new `agent-core` package as a prerequisite. The current `conversation` package is already the stable domain. Add a new core package only when a real cross-harness concept cannot fit there cleanly.

### Over-generalizing too early

Keep the normalized event set small. Add a provider-neutral event only when at least one current workbench behavior needs it.

### Designing a lowest-common-denominator adapter

Do not collapse typed operations into `send(command): Promise<void>`. Preserve typed returns for start, resume, list, fork, models, mentions, and auth status.

### Competing event schedulers

Do not add a second generic actor that competes with `ConversationIngress`. Make the first facade feed the existing ingress and measure before changing ownership.

### Leaking provider concepts

Names such as `CodexThread`, `CodexItem`, or generated request types must stop at the adapter boundary. Use `Session`, `ConversationItem`, and `PermissionRequest` in the core.

### Making every capability mandatory

Optional capabilities are expected. Model them explicitly instead of weakening the contract until every provider fits badly.

### Treating every event as durable

Do not persist every streaming delta. Coalesce transient signals and commit durable facts. Add replay storage after a harness and product workflow require it.

### Hiding billing mode

A profile must distinguish subscription login from API-key billing. Environment variables can silently change the provider billing path.

### Expanding the scope into orchestration

Keep branches, worktrees, checkpoints, reviews, and pull requests above the harness adapter. Add those capabilities through `workspace` ports when evidence requires them.

### Building infrastructure before evidence

Use in-process actors and async iterables first. A broker, durable event store, or public plugin ABI can be added after real adapters expose a need.

### Treating uncertainty as failure

Do not convert an incomplete provider lifecycle into a false success or false failure. Preserve `unknown`, show it to the user, and provide an explicit inspection or retry action.

## Definition of done

This project is complete when Codex runs through `harness-codex`, the harness registry selects it, existing workbench ports consume normalized events, provider identities stay inside the adapter boundary, lifecycle transitions are idempotent and monotonic, ambiguous operations are explicit, capability failures are clear, fault-injection tests pass, and current Vimex validation passes. Cursor, Claude Code, and OpenCode remain follow-on adapters built against the established contract.
