# Harness-Agnostic Resilience and Durability

## Experience first

Vimex should remain useful when the provider, process, transport, or one message is wrong. A malformed event, duplicate notification, late tool result, or disconnected harness should produce a visible and recoverable state.

```text
bad input or partial failure
          |
          v
diagnostic + preserved user work + safe recovery action
```

The user should not lose a draft, lose their transcript position, submit a prompt twice accidentally, or see a false success because a provider stopped halfway through a turn.

## Durability laws

These are target laws. The current Codex path only partially satisfies them: `ConversationIngress` coalesces deltas and retries failed batches, but normalized events do not yet have universal event IDs or cursors, and unknown Codex notifications are not yet retained as diagnostics. Each implementation phase must mark the invariant as `current`, `bridged`, or `target` rather than implying that the document is already the runtime behavior.

### Monotonic transitions

Lifecycle state moves forward. A late event cannot move completed state back to running.

```text
turn.completed -> turn.started         ignored
tool.completed -> tool.started         ignored
approval.resolved -> approval.pending  ignored
```

Reducers must make duplicate and stale transitions explicit and testable.

### Idempotent events

Every provider event should carry or receive a stable identity: provider event ID, provider cursor, provider message or part ID, or a local correlation ID as a last resort. Applying an event twice must produce the same state as applying it once.

### Signals and facts

Streaming deltas are transient signals. Completions, tool results, edits, permissions, and session metadata are facts for the current process.

```text
signal: assistant.delta

fact: item.completed
fact: tool.completed
fact: file.changed
fact: approval.requested
fact: turn.completed
```

Signals may be coalesced or reconstructed. Facts remain available until their projection succeeds.

### Reconciliation at boundaries

Reconnect is a reconciliation workflow:

```text
disconnect
  -> mark session uncertain
  -> preserve draft and view state
  -> reconnect harness
  -> request snapshot or events after cursor
  -> deduplicate and reject stale events
  -> replay facts
  -> settle session state
```

If a harness cannot replay, the adapter requests an authoritative snapshot where available. Vimex must not claim durable replay for a harness that cannot provide it.

The first Codex bridge should mark all in-flight operations as `unknown` when a restart interrupts their outcome. It must not silently replay a prompt or approval. Reconciliation becomes authoritative only when a provider cursor or snapshot can prove the result.

## Lifecycle state machines

### Session

```text
created -> starting -> ready -> working -> idle
                         |                  |
                         v                  v
                    reconnecting <------- waking
                         |
                         v
                    reconciling
                         |
             +-----------+-----------+
             v                       v
          ready                  disconnected
                                     |
                                     v
                                  closing -> closed
```

`failed` is an observable terminal state with an actionable reason. `reconciling` prevents ambiguous submissions while provider state is being settled.

`waking` is a local workbench state used while restoring a known session; it is not a provider lifecycle event. If the process exits during this path, transition to `disconnected` or `failed` with a diagnostic.

### Turn

```text
created -> queued -> sending -> running
                                |
                                v
                           stopping
                                |
             +------------------+------------------+
             v                  v                  v
          completed         interrupted          failed
                                \
                                 -> unknown
```

`unknown` means the request may have been accepted but its outcome is unavailable. Vimex asks before resubmitting an ambiguous prompt.

### Tool

```text
announced -> waiting-permission -> approved -> running
                                             |
                         +-------------------+-------------------+
                         v                   v                   v
                      completed           failed             cancelled
                         |
                         v
                      unknown
```

A tool without a completion event remains visible as `unknown`. It must not disappear from the transcript.

### Approval

```text
requested -> presented -> resolving -> resolved
                 |            |
                 v            v
             expired      failed
                 |
                 v
             invalidated
```

Approval responses need an operation identity so retries do not produce multiple logical decisions. Transport loss invalidates pending approvals rather than leaving them falsely actionable.

## Process health and agent health

Process health and agent health are separate facts:

```text
process: running       agent: idle
process: running       agent: disconnected
process: exited        agent: outcome-unknown
```

The session header shows both when they differ. This allows a future process supervisor to stop idle harnesses and resume them without changing the durable agent session identity.

## Safe operation lifecycle

Every user-originated operation receives an operation ID:

```text
created -> sent -> acknowledged -> completed
                         |
                         +-> failed
                         +-> unknown
```

This applies to prompts, steer messages, approval responses, interrupts, forks, and handoffs. If Vimex restarts after sending a command but before learning its result, it asks before retrying.

## Snapshots and recovery

The first Codex migration may remain in memory, but the boundary supports a future `SessionStore`:

```text
provider events
  -> normalized facts
  -> conversation reducer
  -> session snapshot
  -> workbench projection
```

A recovery snapshot contains session metadata, provider identity mappings, turn states, committed items, pending approvals, the last accepted cursor, the local projection revision, and draft/view-state references.

Do not persist every token. Persist committed facts and periodic checkpoints when reconnect, idle shutdown, or process restart requires them.

## Diagnostics and containment

Unknown, malformed, or failed events become bounded diagnostics:

```ts
interface DiagnosticRecord {
  id: string
  sessionId: string
  source: "provider" | "transport" | "reducer" | "ui"
  severity: "info" | "warning" | "error"
  code: string
  message: string
  raw?: unknown
  recoverable: boolean
}
```

Diagnostics are associated with a session, capped, inspectable, and excluded from unsafe state transitions.

```text
transport failure -> reconnect state
decode failure    -> diagnostic event
mapping failure   -> unknown provider item
reducer failure   -> retained batch and retry
projection error  -> isolated projection failure
render error      -> item-level fallback card
```

One bad event must not terminate the whole stream.

Unknown provider messages must be preserved at the adapter boundary, including their provider name, message kind, session/thread identity when available, and bounded raw payload. The current Codex `unknown` branch is a known gap to close before claiming this invariant.

## Ownership

```text
adapter       decode, validate, provider identity, cursor, wire recovery
ingress       order, coalesce signals, retain facts until projection
conversation  turn/item invariants and monotonic reduction
approvals     approval lifecycle and response identity
workbench     session health, operation status, recovery presentation
transcript    stable logical positions and render fallback
workspace     process supervision, snapshots, checkpoints, resume
ui            clear uncertain states and safe next actions
```

No layer silently takes ownership from another. This is the social contract that keeps the system understandable as harnesses grow.

## Fault-testing contract

Inject duplicate, out-of-order, malformed, missing, late, replayed, and disconnected events; process exits during turns; overlapping tools; duplicate approval responses; pending approvals during disconnect; bounded diagnostic overflow; and projector or renderer failures.

Each test asserts deterministic state, retained user work, and an actionable diagnostic.

## UX for uncertainty

The UI distinguishes `Working`, `Waiting for approval`, `Reconnecting`, `Reconciling`, `Outcome unknown`, `Provider unavailable`, and `Completed`.

```text
Reconnecting      :restart
Outcome unknown   :inspect or retry explicitly
Auth expired      provider login
Capability absent continue without feature
Provider error    :details
```

## Definition of done

The refactor is resilient when lifecycle transitions are explicit, duplicate and stale events are harmless, ambiguous operations are never silently retried, provider failure preserves local work, unknown messages become bounded diagnostics, and fault-injection tests cover message, agent, tool, approval, transport, and projection boundaries. Until then, the docs must label those behaviors as target behavior rather than existing guarantees.
