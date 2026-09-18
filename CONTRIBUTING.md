# Contributing to Vimex

Vimex is a Bun/TypeScript monorepo. Its v1 product and architecture documents are part of the implementation contract; read [the v1 index](work/projects/v1/README.md), especially the specification, architecture, and topology, before moving behavior across packages.

## Setup

```sh
bun install --frozen-lockfile
bun run start --demo
```

The demo is the quickest UI development loop because it needs neither Codex credentials nor network access. Live sessions require an authenticated Codex CLI; do not use real threads for routine tests.

## Repository boundaries

- Domain packages own pure state and transitions.
- Application packages coordinate domain effects through narrow ports.
- `packages/codex-app-server` owns versioned protocol types, transport, RPC, and normalization.
- `packages/ui-opentui-react` owns presentation and input binding, without selecting concrete adapters.
- `apps/tui` is the executable composition root.
- `plugins/herdr` owns optional Herdr launch, reporting, and external-action integration.

Run the boundary verifier after changing imports or moving files:

```sh
bun run boundaries
```

## Checks

Before submitting a change, run:

```sh
bun run check
git diff --check
```

`check` runs TypeScript, dependency boundaries, and the complete default Bun test suite. Focused scripts are available:

```sh
bun run test:unit
bun run test:integration
bun run test:contract
bun run test:ui
bun run test:e2e
```

The terminal suite needs Python 3 and a Unix PTY. It runs the actual renderer against a deterministic app-server fixture and must remain credential-free and network-free. The opt-in live driver is intentionally excluded from defaults because it touches real Codex threads and the host clipboard; do not run it or claim its acceptance evidence without explicit authorization. See [live validation](work/projects/v1/live-validation.md).

CI is configured for macOS and Ubuntu with Bun 1.3.6, Python 3.12, and `TERM=xterm-256color`. A configured target is not considered supported until its run has been observed and recorded in the [terminal matrix](docs/terminal-support.md).

## Protocol changes

Generated Codex types live only inside the adapter. To update them:

1. Install the exact Codex version being targeted.
2. Run `bun run generate:codex`.
3. Review the generated diff and update explicit normalization code.
4. Add or update contract fixtures, including unknown-event behavior.
5. Run `bun run test:contract` and then `bun run check`.

Do not hand-edit generated protocol files or let generated types cross into domain/UI packages.

## Test changes at the right layer

Prefer pure domain tests for state transitions, adapter contract tests for wire behavior, renderer tests for visual/input integration, and real-PTY tests only for behavior that depends on a terminal. Add regression tests for races, cleanup, persistence, and streaming-anchor behavior where the failure occurs rather than duplicating implementation details.

When documenting terminal behavior, record the operating system, terminal emulator, `$TERM`, multiplexer or SSH layer, dimensions, clipboard route, and exact scenarios exercised. Label partial or unobserved evidence plainly.

## Pull requests

Describe the concrete trigger and resulting behavior, list the checks run, and call out protocol or terminal compatibility implications. Keep generated changes, design-document changes, and acceptance claims reviewable. Do not edit the specification merely to make an incomplete implementation appear complete.
