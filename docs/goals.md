# Goals

Vimex uses Codex app server's persisted thread goal, shared with Codex's `/goal` feature. Both slash commands in the composer and Ex commands in the status bar accept the same syntax:

| Command | Result |
| --- | --- |
| `/goal` or `:goal show` | Fetch objective, status, token usage/budget, and elapsed seconds |
| `/goal Fix the parser and keep tests green` | Set an active goal |
| `:goal --budget 40000 Finish the migration` | Set a goal with an explicitly requested token budget |
| `:goal pause` | Pause the current goal |
| `:goal resume` | Activate the current goal |
| `:goal complete` | Mark the current goal complete |
| `:goal clear` | Remove the current goal |
| `:goal set pause` | Set the literal objective “pause”, rather than invoking a subcommand |

Objectives accept 1–4000 Unicode characters. A new objective replaces the prior goal and resets server usage accounting. An unchanged nonterminal objective, or a status-only update, preserves accounting. Vimex does not invent a token budget, inject a synthetic prompt, or run its own continuation loop. Codex owns goal execution and lifecycle. Pausing a goal is separate from interrupting an already-running turn; Escape or `:stop` retains its turn-interruption behavior.

The adapter uses `thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`, and handles `thread/goal/updated` and `thread/goal/cleared` notifications. Errors are reported without pretending a goal was changed.

Reference: [official app-server goal documentation](https://developers.openai.com/es-419/docs/app-server#administrar-la-meta-de-un-hilo), checked against the pinned 0.154.0 generated schemas.
