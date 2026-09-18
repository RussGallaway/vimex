# Vimex v1 Implementation Status

This is an implementation checkpoint, not a declaration that v1 acceptance is complete. The specification remains authoritative.

## Implemented and under validation

- Full-screen OpenTUI React shell, fixed composer, Markdown rendering, Vim modes, viewport navigation, selection, folds, and dark themes.
- Codex JSONL transport, versioned schema mapping, pagination, streaming, start/resume/switch/fork, steering, interruption, approval responses, model and reasoning settings.
- Application-owned conversation and approval gateways, runtime connection and model-catalog ports; concrete adapters selected by the executable composition root.
- Durable local drafts, recoverable outbox entries, and per-thread reading state. Recovered submissions require explicit retry.
- Herdr lifecycle/session/metadata reporting with bounded coalescing and connection-aware state.
- Unit, application integration, adapter contract, renderer, and real-PTY tests. Deterministic terminal tests exercise both offline demonstration and a JSONL approval/streaming flow.

## Checkpoint validation

`bun run check` passes: TypeScript, dependency boundaries, and 102 tests with 333 assertions, including both real-PTY scenarios. `bun install --frozen-lockfile` passes. CI is configured for Linux and macOS; those remote jobs have not been observed yet.

## Remaining acceptance work

- Complete question-response UI and parent/child agent navigation; normalized adapter events alone do not satisfy these workflows.
- Searchable session selection, confirmed user-message-boundary forks, transcript search and match motions, multiple-link selection, and command history/completion.
- Validate the complete Vim composer/operator set and configurable key bindings against `ux.md`.
- Validate rendered coordinate mapping for complex Markdown tables, nested structures, reflow, and streaming selections; extend fixtures where necessary.
- Responsive split diffs, tool duration, and complete status metadata.
- Controlled app-server restart while preserving local work.
- First-class Herdr launch configuration and live pane verification of clipboard, reporting, URLs, and restoration.
- A real Codex task end to end and the full release acceptance matrix. Offline fixtures cannot substitute for this verification.

## Structural correction

The initial implementation accumulated domain behavior in package entry points, application orchestration in the CLI, and a broad `backend.ts` interface. These diverged from `topology.md`. The correction places behavior under its domain/application owner, organizes UI files by feature, and separates volatile adapters. Boundary checks guard against implementation barrels, reversed domain/application imports, UI adapter selection, production testkit imports, and generic UI component directories.

Do not change the specification to make unfinished implementation appear complete.
