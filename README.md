# Vimex

A full-screen, Vim-operated terminal interface for the Codex app server, built with OpenTUI React. Vimex owns presentation and interaction; Codex owns execution, permissions, and conversation history.

Vimex is preparing an initial **0.1.0** release and follows Semantic Versioning. The `work/projects/v1` directory names a planning milestone, not a 1.0.0 release commitment. The acceptance criteria and remaining work are in [the v1 project documents](work/projects/v1/README.md).

## Documentation

- [Documentation index](docs/README.md)
- [User manual](docs/manual.md) — available offline with `:manual`
- [Distribution and release plan](docs/releasing.md)

- [Install and run](docs/install.md)
- [Configuration](docs/configuration.md)
- [Keyboard reference](docs/keys.md)
- [Terminal support](docs/terminal-support.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md)

## Run from source

Requires Bun 1.3.6 or later and an installed, authenticated Codex CLI. The adapter currently targets Codex 0.154.0. Run `codex login` separately before launching a live session.

```sh
bun install --frozen-lockfile
bun run start --cwd /path/to/project
```

Use `bun run start --demo` for an offline streaming demonstration, or `--thread ID` to resume a Codex thread. See `bun run start --help` for the remaining options. Vimex is currently run from a checkout; there is no published binary or package yet.

The default dark theme is **Ember Tide**: charcoal, warm ivory, muted blue, sage, and amber.

## Keyboard basics

- `i` enters Insert mode; `Esc` returns to Normal.
- In Insert mode, `Enter` submits and `Shift+Enter` adds a newline.
- `Ctrl-k` and `Ctrl-j` move between transcript and composer from every mode.
- `Ctrl-e/y` scroll by line; `Ctrl-d/u` scroll by half a viewport.
- `v` selects transcript text; `y` copies rendered text; `:yank markdown` copies its source.
- `/` and `?` search; `n`/`N` repeat; `G` or `t` resumes following the response.
- `za` toggles a fold; `[u`/`]u` move between links; `gx` opens a link.
- `s` opens Flash; Space leads to `s` sessions, `a` approvals, `q` questions, or `?` help; `:agents` opens agent threads; `:parent` returns.
- `f` confirms a fork through the selected completed turn.
- `:approvals` and `:questions` open pending requests for the active session.
- `:restart` reconnects a failed runtime while keeping local drafts. Uncertain sends require an explicit retry.
- `:` opens command entry; `:help` lists commands; `:q` quits.

The composer stays at the bottom while the transcript streams. Reading position and tail attachment are independent of Vim mode.

## Configuration and state

Configuration lives in `$XDG_CONFIG_HOME/vimex/config.json` (default `~/.config/vimex/config.json`). Use `--config PATH` to select another file. Missing fields use defaults; unknown keys are rejected.

```json
{
  "version": 1,
  "theme": "ember-tide",
  "syntaxTheme": "theme",
  "reducedColor": false,
  "insertEnter": "submit",
  "busySubmit": "queue",
  "foldTools": true,
  "foldReasoning": true,
  "composerMaxHeight": 0.33,
  "keybindings": {},
  "codexExecutable": "codex"
}
```

`keybindings` maps key sequences to named commands, such as `{ "ctrl+s": "submit" }`. `:theme nord`, `:theme kanagawa`, and `:syntax theme` change and persist display preferences.

The complete option descriptions and override rules are in [configuration](docs/configuration.md). The full command and mode tables are in the [keyboard reference](docs/keys.md).

Local draft and viewport state lives under `$XDG_STATE_HOME/vimex` (default `~/.local/state/vimex`). Codex remains the source of truth for thread history. Herdr reporting activates when launched within a recognized Herdr pane. See the [Herdr plugin instructions](plugins/herdr/README.md) for installation and external URL actions.

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

Set `reducedColor: true` or a nonempty `NO_COLOR` environment variable to reduce accent colors to the theme’s text and background tones. Status and mode indicators also use text.

## License

[MIT](LICENSE). Bundled third-party assets retain their own licenses and notices.
