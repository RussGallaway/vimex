# Vimex

A full-screen, Vim-operated terminal interface for the Codex app server, built with OpenTUI React. Vimex owns presentation and interaction; Codex owns execution, permissions, and conversation history.

V1 is under active implementation. The acceptance criteria and remaining work are in [the v1 project documents](work/projects/v1/README.md).

## Run from source

Requires Bun 1.3.6 or later and an installed, authenticated Codex CLI. The adapter currently targets Codex 0.154.0. Run `codex login` separately before launching a live session.

```sh
bun install --frozen-lockfile
bun run start --cwd /path/to/project
```

Use `bun run start --demo` for an offline streaming demonstration, or `--thread ID` to resume a Codex thread. See `bun run start --help` for the remaining options.

The default dark theme is **Ember Tide**: charcoal, warm ivory, muted blue, sage, and amber.

## Keyboard basics

- `i` enters Insert mode; `Esc` returns to Normal.
- In Insert mode, `Enter` adds a newline and `Alt+Enter` submits.
- `Ctrl-w k` and `Ctrl-w j` move between transcript and composer.
- `Ctrl-e/y` scroll by line; `Ctrl-d/u` scroll by half a viewport.
- `v` selects transcript text; `y` copies the selection.
- `:` opens command entry; `:help` lists commands; `:q` quits.

The composer stays at the bottom while the transcript streams. Reading position and tail attachment are independent of Vim mode.

## Configuration and state

Configuration lives in `$XDG_CONFIG_HOME/vimex/config.json` (default `~/.config/vimex/config.json`). Use `--config PATH` to select another file. Missing fields use defaults; unknown keys are rejected.

```json
{
  "version": 1,
  "theme": "ember-tide",
  "insertEnter": "newline",
  "busySubmit": "queue",
  "foldTools": true,
  "foldReasoning": true,
  "composerMaxHeight": 0.33,
  "codexExecutable": "codex"
}
```

Local draft and viewport state lives under `$XDG_STATE_HOME/vimex` (default `~/.local/state/vimex`). Codex remains the source of truth for thread history. Herdr reporting activates when launched within a recognized Herdr pane.

## Development checks

```sh
bun run check
bun run test:unit
bun run test:integration
bun run test:contract
bun run test:ui
bun run test:e2e
```

`check` runs type checking, dependency-boundary checks, and all tests. Terminal end-to-end tests require Python 3 and a Unix PTY; they launch the actual renderer and a deterministic JSONL server fixture without credentials or network access. Live Codex and Herdr verification are separate from these offline tests.

Generated Codex protocol types stay inside the adapter. Refresh them deliberately with `bun run generate:codex` after installing the intended Codex version, then review schema changes and run contract tests.
