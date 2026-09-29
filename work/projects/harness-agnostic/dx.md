# Harness and Extension Developer Experience

## Experience first

A developer adding a harness should be able to hold the whole change in their head:

```text
provider protocol
  -> adapter mapping
  -> existing Vimex ports
  -> existing workbench projection
  -> optional provider feature
```

Adding a harness should feel like adding one bounded integration, not changing the transcript, Vim modes, composer, or workbench state model.

Adding a harness-specific feature should start with the user experience it enables, then choose the smallest extension point that can express it.

## Social ownership

```text
adapter maintainer       provider wire, auth, IDs, fixtures
common contract owner    normalized ports, events, lifecycle laws
workbench owner          commands, projections, recovery policy
UI owner                 overlays, transcript cards, status language
integration owner        composition root, package graph, release checks
```

Promotion from a provider extension to a common capability requires equivalent user-facing semantics in at least two harnesses, a UX brief, and an explicit migration plan. This keeps the common contract from becoming a dumping ground for one provider's protocol.

## Two development paths

There are two related tasks:

```text
Add a harness
  -> implement the adapter contract
  -> expose common behavior
  -> declare capabilities
  -> add provider-specific extensions

Add a harness feature
  -> describe the user experience
  -> decide common capability or provider extension
  -> map provider messages
  -> add projection and interaction
```

The second path must not begin by changing the common event union. First establish whether the feature is truly shared.

## Adding a harness

### 1. Write the experience brief

Before code, describe:

- how the user starts the harness;
- what authentication and billing path is used;
- which common actions work;
- which provider-specific features matter;
- how sessions resume or reconnect;
- what the user sees when the harness is unavailable;
- which workspace and process boundaries it needs.

The brief should include one normal flow and one failure flow.

### 2. Create the adapter package

Use a dedicated package:

```text
packages/harness-<id>/
  src/
    <id>-adapter.ts
    <id>-manifest.ts
    <id>-auth.ts
    <id>-capabilities.ts
    <id>-mapper.ts
    <id>-extensions.ts       # only if needed
    client/                  # provider transport
    mapping/                 # wire to Vimex mapping
    fixtures/
    index.ts
```

Codex is the reference shape:

```text
packages/harness-codex/src/
  generated/
  transport/
  rpc/
  mapping/
  capabilities/
  codex-adapter.ts
  codex-auth.ts
  codex-approval-gateway.ts
```

Provider wire schemas, clients, auth details, and provider identifiers stay inside the package.

### 3. Declare the manifest

The manifest answers what Vimex can safely offer:

```ts
interface HarnessManifest {
  id: string
  label: string
  protocol: string
  capabilities: HarnessCapabilities
  authModes: readonly AuthMode[]
  persistence: "local" | "remote" | "ephemeral" | "unknown"
}
```

Capabilities should be explicit and operation-oriented:

```text
session.start       session.resume       session.close
turn.prompt         turn.steer          turn.interrupt
streaming           permissions         questions
model.catalog       usage               file.changes
fork                subagents           compaction
history.replay      session.persistence
```

Use `partial` or a feature detail object when a boolean is not enough. Do not advertise a capability because the provider has a superficially similar feature.

### 4. Implement typed ports

The adapter should implement separate ports:

```text
HarnessControl
  start / resume / list / fork / model catalog / auth status

HarnessSession
  prompt / steer / interrupt / permission response / question response

HarnessEventStream
  subscribe / optional history(after cursor) / close
```

Do not reduce all operations to `send(command): Promise<void>`. Start, resume, fork, model discovery, auth status, and mention search have meaningful typed results.

The adapter may use any internal architecture. Only the stable port contract crosses into Vimex application code.

### 5. Map provider identity

Maintain explicit maps for:

```text
Vimex SessionId       <-> provider session/thread ID
Vimex TurnId          <-> provider turn ID
Vimex ItemId          <-> provider message/part/tool ID
Vimex event cursor    <-> provider event cursor, if available
```

Provider IDs are opaque. Parent, child, and side relationships must be mapped explicitly.

Adapters may keep private correlation state for streaming parts and tool calls. Do not make the workbench infer identity from display text.

### 6. Separate signals from facts

Streaming deltas are transient signals. Completions, tool results, edits, permissions, and session metadata are durable facts for the current process.

```text
provider delta
  -> adapter mapper
  -> ConversationIngress accumulator
  -> transient frame

provider completion
  -> adapter mapper
  -> normalized fact
  -> conversation/workbench projection
```

Do not persist every token. Add replay storage only when the harness and user workflow require it.

### 7. Add fixtures and contract tests

Every adapter must test:

```text
connect and handshake
auth status
start and resume
prompt and streamed output
tool and file activity
permission and question flow
interrupt and completion
disconnect and reconnect policy
unknown and malformed provider messages
clean close
```

Fixtures belong in the adapter package. UI tests use normalized fake events and never require provider credentials.

## Adding a harness-specific feature

Start with the experience:

```text
What does the user see?
What action can they take?
Does the harness block while waiting for the action?
Does the feature change transcript content, status, or commands?
```

Then choose one of three homes.

### Common capability

Use this when at least two harnesses have the same user-facing semantics.

```text
provider feature
  -> normalized capability event
  -> shared workbench projection
  -> shared Vim command or overlay
```

Examples: permission requests, user questions, tool lifecycle, file changes.

### Optional capability

Use this when the feature is meaningful in the workbench but not universal.

```text
Codex goals
  -> capability: goals
  -> shared capability-aware command
  -> Codex implementation
```

The UI should explain absence rather than emulate it.

### Provider extension

Use this when the feature has provider-specific semantics or payloads.

```text
Cursor create-plan
  -> cursor extension event
  -> provider extension card
  -> Cursor-specific response
```

Provider extensions use a namespace:

```text
codex.goals
cursor.create-plan
claude.skill
opencode.tool
```

Promote an extension into a common capability only after another harness demonstrates equivalent semantics.

## Extension surfaces

Vimex has a small set of extension surfaces:

```text
adapter extension
  provider messages, commands, capability details

workbench extension
  named commands, status segments, projections

UI extension
  transcript cards, overlays, selectors, renderers

platform extension
  process, persistence, clipboard, URL, workspace services
```

Provider-owned skills, hooks, MCP servers, tools, and agent definitions remain configured through the provider harness. Vimex can show their status or route their messages when the harness protocol exposes them, but it should not duplicate their configuration systems.

## Adding a provider projection

When a feature needs UI, follow this call chain:

```text
provider wire message
  -> packages/harness-<id>/<id>-mapper.ts
  -> normalized common event or namespaced extension event
  -> workbench projection
  -> application command / status selector
  -> ui-opentui-react overlay or transcript renderer
```

The UI must never decode provider wire messages.

## Auth and billing development rules

An adapter declares how it discovers authentication:

```text
cli login
oauth
api key
inherited environment
```

It also reports the observed billing path when possible:

```text
subscription
api usage
provider managed
unknown
```

Persist profile references and environment names, not secret values. Test both subscription login and API-key paths when a provider supports both because environment configuration can change billing unexpectedly.

## Shared contract suite

The harness package should export a test factory or test helpers so each adapter runs the same behavioral checks:

```text
describeHarnessAdapter("cursor", createCursorAdapter, {
  expectedCapabilities: ...,
  fixtures: ...,
})
```

The shared suite checks the stable contract. Adapter-local tests check exact wire behavior and provider extensions.

## Local development loop

The intended loop is:

```text
1. Write the experience brief.
2. Add or update the manifest.
3. Add a deterministic provider fixture.
4. Map it into existing ports/events.
5. Exercise the workbench with fake normalized events.
6. Run adapter contract tests.
7. Run boundary checks.
8. Run the full check suite.
9. Manually exercise one real authenticated session.
```

The real session is a final integration check, not the main test harness.

## Review checklist

Reviewers should be able to answer these questions without reading the entire repository:

- What user experience does this change create?
- Which package owns the provider volatility?
- Which existing port or event does it use?
- Is the feature common, optional, or provider-specific?
- Where are provider IDs correlated?
- What happens on disconnect, duplicate events, and unknown messages?
- Which auth and billing path is exercised?
- Does the change require a new UI concept, or only a projection of an existing one?
- Can a fake adapter test it without the provider installed?

If those answers are unclear, the architecture is not ready for implementation.

## Definition of done

A harness addition is complete when its experience brief, manifest, typed adapter ports, provider mapping, auth status, capability declaration, fixtures, contract tests, boundary checks, and documentation are present. A harness-specific feature is complete when its user experience, namespace, projection, failure behavior, and adapter-local tests are clear.
