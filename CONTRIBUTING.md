# Contributing to Vimex

Vimex is a Bun/TypeScript monorepo. Its v1 product and architecture documents are part of the implementation contract; read [the v1 index](work/projects/v1/README.md), especially the specification, architecture, and topology, before moving behavior across packages.

## Concurrent agent work

Follow [AGENTS.md](AGENTS.md) and use `bun run claim` before editing in a shared checkout. See [coordination](docs/coordination.md) for commands, handoffs, and recovery.

## Setup

Use Bun 1.3.6, matching the root `packageManager` field and CI. Install dependencies from the repository root:

```sh
bun install --frozen-lockfile
bun run start --demo
```

Installation runs `prepare` to configure Husky's Git hooks. If hooks need to be restored in an existing checkout, run `bun run prepare`.

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

`check` checks formatting, generated documentation, TypeScript, dependency boundaries, and the complete default Bun test suite. Focused scripts are available:

```sh
bun run test:unit
bun run test:integration
bun run test:contract
bun run test:ui
bun run test:e2e
bun run test:tmux
```

The default terminal suite needs Python 3 and a Unix PTY. It runs the actual renderer against a deterministic app-server fixture and must remain credential-free and network-free. The tmux smoke test is separate because a managed filesystem sandbox can remove its detached server socket; run `bun run test:tmux` on a host with tmux. The opt-in live driver is intentionally excluded from defaults because it touches real Codex threads and the host clipboard; do not run it or claim its acceptance evidence without explicit authorization. See [live validation](work/projects/v1/live-validation.md).

CI is configured for macOS and Ubuntu with Bun 1.3.6, Python 3.12, and `TERM=xterm-256color`. A configured target is not considered supported until its run has been observed and recorded in the [terminal matrix](docs/terminal-support.md).

## Formatting and commits

Prettier defines formatting, including two-space indentation, double quotes, and omitted JavaScript/TypeScript semicolons. Run `bun run format` to format the repository or `bun run format:check` to check it without changes. Generated protocol bindings, generated manual output, snapshots, lockfiles, and build artifacts are excluded in `.prettierignore`.

The pre-commit hook uses lint-staged to format supported staged files. It preserves partially staged changes; review the resulting staged diff before committing. Full tests run through `bun run check`, not in the pre-commit hook.

The commit-msg hook enforces Conventional Commits:

```text
feat(composer): add multiline input
fix(transcript): preserve scroll position
docs: clarify terminal setup
chore(tooling): configure formatting
```

Use a type followed by an optional scope, a colon, and a concise description. Common types are `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`, `style`, `revert`, and `chore`. Scopes are optional and are not restricted to a fixed package list. Mark breaking changes with `!` after the type or scope and explain the change in a `BREAKING CHANGE:` footer.

CI disables local hooks with `HUSKY=0` and checks formatting independently.

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

Use a Conventional Commit title for the pull request. Vimex uses squash merges, and the PR title becomes the commit title on `main`; CI validates the title, including when it is edited.

Describe the concrete trigger and resulting behavior, list the checks run, and call out protocol or terminal compatibility implications. Keep generated changes, design-document changes, and acceptance claims reviewable. Do not edit the specification merely to make an incomplete implementation appear complete.
