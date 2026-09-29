# Vimex Harness-Agnostic Refactor

This project refactors Vimex from a Codex-shaped client into a harness-agnostic workbench.

The first implementation target remains Codex. Codex must continue to start and work throughout the refactor. Cursor, Claude Code, and OpenCode are future adapters; this project creates the seams for them without implementing them yet.

## Documents

- [spec.md](./spec.md) defines the product and architecture contract.
- [topology.md](./topology.md) defines the target package tree, ownership, and dependency direction.
- [implementation.md](./implementation.md) defines the staged migration and verification gates.
- [ux.md](./ux.md) defines the experience for choosing, using, and combining harnesses.
- [dx.md](./dx.md) defines the developer path for adding harnesses and harness-specific features.
- [resilience.md](./resilience.md) defines lifecycle durability, recovery, diagnostics, and fault-testing.

## Authority

The v1 documents remain the authority for existing Vimex behavior. This project changes the runtime boundary around the agent harness. It does not remove Vim behavior, transcript guarantees, Herdr integration, or current Codex acceptance requirements.

When these documents conflict with v1 behavior, preserve the observable v1 behavior and use the harness-agnostic design to determine where the implementation belongs.

Within this project, the documents have a deliberate order of authority:

1. `spec.md` and `ux.md` define the intended product behavior.
2. `topology.md` defines ownership and source placement.
3. `dx.md` defines the social contract for extending the system.
4. `resilience.md` refines lifecycle and recovery behavior.
5. `implementation.md` defines the migration order and evidence gates.

The target topology is aspirational. The current Codex package and ports are called out explicitly so a migration step never depends on an unimplemented package move.

## Working definition

> Vimex is a message-driven, Vim-native workbench for authenticated coding harnesses.

Vimex owns the workbench experience. The selected harness owns agent execution, provider authentication, model access, tools, and billing.
