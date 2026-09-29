# Startup runtime

Status: first implementation slice

Vimex renders a usable local draft before the Codex app server is ready. The
draft owns the composer, interaction state, and outgoing queue. It receives a
local thread id and later binds to the real Codex thread created by the gateway.

## Runtime contract

```text
renderer → local draft → app-server connection → real thread → queued turn
```

Typing, editing, mode changes, and ordinary text submission are local
operations. The connection, thread creation, and turn request are background
effects. A queued outgoing message keeps its client message id while it moves
from the provisional workspace to the real workspace, so retries do not create
duplicates.

Shell commands, approvals, image attachment reads, and other operations that
require a real thread remain gated until the binding completes.

## Binding sequence

1. Workbench creates a provisional workspace for the launch directory.
2. The UI renders the workspace and accepts input.
3. Submission adds an outgoing message with `queued` status.
4. The app-server connection initializes in the background.
5. A new or resumed Codex thread is hydrated.
6. Workbench transfers the draft, interaction state, and outbox to that thread.
7. Queued messages are scheduled through the normal submission scheduler.
8. Server events and streaming deltas update the bound workspace.

If binding fails, the provisional workspace and its draft remain available for
the existing restart flow. The implementation must never discard local input
because the server is slow or unavailable.

## Critical path

The first usable frame must not wait on thread listing, model catalog loading,
syntax parser setup, Herdr reporting, or local persistence writes. This slice
defers parser setup and skips the thread catalog for new sessions. Configuration
and local view loading remain launch prerequisites until a later bootstrap slice
can merge them safely into the already-rendered draft. Resume and picker flows
may still load the catalog because they need it to choose a target.

## Measurements

Startup profiling should eventually record renderer creation, first frame,
first accepted key, first draft paint, app-server connection, thread binding,
request write, first activity, and first assistant delta. Submit and navigation
profiles remain separate from these startup marks.
