# Harness-Agnostic Refactor Specification

## Product statement

Vimex is a full-screen, keyboard-first workbench for authenticated coding harnesses. Codex app-server remains the first and only required harness during this refactor. The architecture prepares for Cursor ACP, Claude Code, OpenCode, and future harnesses without moving provider protocol types into the workbench or UI.

## Goals

1. Preserve all current Vimex v1 behavior while changing the harness boundary.
2. Keep Codex as the only required working harness during this refactor.
3. Let the existing `conversation`, `approvals`, `workbench`, and `transcript` domains remain stable while a harness facade is introduced around them.
4. Let each provider harness retain responsibility for authentication, model access, agent execution, tools, MCP, subscription entitlements, and billing.
5. Use messages with explicit identity, correlation, ordering, and capability results.
6. Keep provider-specific protocol volatility at adapter boundaries.
7. Make unsupported provider features visible and structured instead of pretending that every harness has the same behavior.
8. Preserve unknown provider events as diagnostic data without crashing the client.
9. Preserve user work and provide safe recovery when messages, tools, turns, transports, or harness processes fail.

## Non-goals

- Reimplementing Codex, Cursor Agent, Claude Code, OpenCode, or another agent loop.
- Creating a generic model API client that bypasses a provider's authenticated harness.
- Storing provider secrets in Vimex state when the harness can own authentication.
- Implementing Cursor, Claude Code, or OpenCode adapters in the first Codex-only migration.
- Defining a public third-party plugin ABI.
- Replacing the existing transcript, Vim, workspace, or Herdr product contracts.

## Vocabulary

### Workbench

The Vimex application layer: Vim interaction, transcript presentation, drafts, approvals, sessions, workspace state, and local persistence.

### Harness

The provider-owned agent runtime that performs model inference, invokes tools, edits files, and manages provider-specific execution state.

### Adapter

A Vimex integration that launches or connects to one harness protocol and translates between provider messages and the normalized Vimex message contract.

### Authenticated harness

A harness that has been configured through its own supported login, OAuth, API key, environment, or enterprise mechanism. Vimex may launch it and observe its auth status, but does not become the authority for the provider account.

## Boundary strategy

The first refactor is an incremental facade, not a wholesale domain relocation:

```text
existing conversation / approvals / workbench ports
                         ^
                         |
              harness facade and registry
                         ^
                         |
                    harness-codex
                         ^
                         |
                 codex app-server process
```

The current `ConversationIngress` remains the first event serializer and coalescer. A new generic session actor must not compete with it. If a later cross-harness session service is needed, it must wrap or replace that ingress deliberately and preserve its ordering guarantees.

## Runtime contract

The runtime has one command path and one event path per active session:

```text
OpenTUI input
    |
    v
Workbench command
    |
    v
Workbench application port
    |
    v
Harness control/session adapter  --->  authenticated harness
    ^                                      |
    |                                      v
    +-- RuntimeEvent / ConversationEvent <- provider messages
```

The adapter may use stdio, a local socket, HTTP, or another provider transport. The workbench must not know which transport is in use.

## Message contract

All messages have an envelope with enough information to order and trace a session:

```ts
interface MessageEnvelope<T> {
  messageId: string
  sessionId: string
  correlationId?: string
  causationId?: string
  sequence?: number
  occurredAt: number
  payload: T
}
```

Commands express user intent. Events describe observed harness or workbench facts. A command may fail with a structured unsupported-capability or provider error; it must not throw provider types into the UI.

The adapter contract is divided by behavior instead of forcing every operation through one `send()` method:

```text
HarnessControl
  start / resume / list / fork / model catalog / auth status

HarnessSession
  prompt / steer / interrupt / permission response / question response

HarnessEventStream
  subscribe / optional history(after cursor) / close
```

The existing typed application ports remain valid during the first migration. The harness facade may group and re-export them before any type consolidation.

The normalized contract must cover the common coding-agent lifecycle:

- session started, ready, resumed, disconnected, and closed;
- turn started, streamed, completed, interrupted, and failed;
- assistant and user messages;
- tool and command activity;
- file changes and diffs;
- permission requests and decisions;
- user questions and answers;
- model and usage metadata;
- child-agent activity where the harness exposes it;
- unknown provider events retained as diagnostic records.

Provider session, turn, message, item, and event identifiers are opaque. The adapter maps them to Vimex identifiers and keeps the provider references private.

Streaming deltas and durable facts have different lifetimes:

```text
assistant.delta       transient signal; coalesced by ConversationIngress
item.completed        durable fact; replaces or commits the item
tool.completed        durable fact
file.changed          durable fact
permission.requested  durable pending fact
```

The first Codex migration may remain in memory. The contract should still leave room for `history(afterCursor)` and a future `SessionStore`, so reconnect behavior does not become an ad hoc collection of retries.

Stable messages should support parts when a provider exposes them:

```text
Message
  +-- text part
  +-- reasoning part
  +-- tool part
  +-- edit or patch part
  +-- permission part
  +-- child-agent part
```

## Capabilities

Harnesses advertise capabilities at startup. The initial capability set includes:

```text
session.start       session.resume       session.close
turn.prompt         turn.steer          turn.interrupt
streaming           permissions         questions
model.catalog       usage               file.changes
fork                subagents           compaction
history.replay      session.persistence
```

Capability absence is normal. Workbench commands that require an absent capability produce a stable user-facing notice and a structured diagnostic event.

## Auth and billing contract

Vimex selects a harness profile. The profile identifies how to start or connect to the harness and how to inspect its status. It does not make Vimex the owner of provider billing.

```text
Vimex config -> harness profile -> provider executable or endpoint
                                      |
                                      v
                             provider auth and billing
```

The harness owns subscription versus API-key behavior. Profiles must distinguish at least:

```text
auth: cli-login | oauth | api-key | environment
billing: subscription | api-usage | provider-managed | unknown
```

Vimex should report detected auth and billing mode when available. It should use named environment references or inherited process environments rather than persisting arbitrary secret-valued environment maps.

## Invariants

- Codex remains startable after every migration step.
- UI and workbench packages do not import generated provider protocol types.
- Provider adapters do not mutate workbench state directly.
- `ConversationIngress` remains the authority for current streaming event ordering until a deliberate replacement is designed.
- Provider session identifiers remain opaque and are mapped explicitly.
- Every normalized event is validated at the adapter boundary.
- Unknown provider messages are retained in a bounded diagnostic channel.
- Every inbound provider message is either normalized or retained as an explicit unknown event.
- Every runtime event is scoped to a Vimex session and, when applicable, provider thread/turn/item identity; events from one session cannot mutate another.
- Every session command is processed in order for its session.
- A disconnected harness preserves Vimex drafts and local view state.
- Provider-specific capabilities are optional and never silently emulated.
- The transcript keeps canonical content independent from rendered cells and provider wire formats.
- Herdr observes workbench lifecycle state and remains optional.
- Lifecycle transitions are monotonic and duplicate events are idempotent.
- Ambiguous operations are represented as unknown and are never retried silently.
- Provider and process health are separate session facts.
- One malformed message cannot terminate the entire session stream.

## Acceptance criteria

The refactor is complete when:

1. A Codex session starts through the new harness registry.
2. Codex streaming, tools, edits, approvals, questions, interruption, resume, fork, and restart retain current behavior.
3. Existing workbench ports remain typed and are not replaced by a lowest-common-denominator `send()` API.
4. The Codex adapter owns all generated types, JSON-RPC, transport, and wire mapping.
5. A fake adapter can drive the workbench without Codex installed.
6. An unavailable capability produces a deterministic result and does not crash the UI.
7. Reconnect and stale-event behavior have explicit tests, even if durable replay is initially optional.
8. A future Cursor ACP adapter can be added without changing transcript or Vim domains.
9. Fault-injection tests cover duplicate, stale, malformed, missing, late, and disconnected lifecycle events.
10. Boundary checks, type checks, and the existing test suite pass.

The first Codex implementation must name its concrete evidence: the Codex gateway and approval-gateway tests, workbench controller and ingress tests, and terminal fixtures that exercise startup and streaming. A future package rename is not itself an acceptance criterion.
