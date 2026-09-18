# Troubleshooting

## Vimex cannot start Codex

Confirm that `codex` is installed, authenticated, and available to the same shell:

```sh
codex --version
codex login
```

Vimex targets the Codex 0.154.0 app-server schema. If the executable is elsewhere, set `codexExecutable` to its path. An immediate app-server exit, malformed JSONL, or an incompatible protocol is surfaced as a connection failure.

## The app server disconnected

Use `:restart`. Vimex recreates the app-server process, reconnects, and rehydrates the active thread while retaining local thread views and drafts. A send that was in flight at disconnect is not assumed to have failed safely; Vimex exposes uncertain/failed outgoing messages for explicit retry rather than duplicating them automatically.

## Enter or Shift+Enter behaves incorrectly

The default is Enter to send and Shift+Enter for a newline. Modified Enter is terminal-dependent. Set:

```json
{ "insertEnter": "newline" }
```

Then use Enter for a newline and Escape followed by Enter to send from composer Normal mode. Ctrl+Enter can send or steer if your terminal reports that combination distinctly. See [terminal support](terminal-support.md) for the current evidence.

## Copy does not reach the system clipboard

Vimex asks OpenTUI for the best available clipboard destination. Local host clipboard, OSC52-like terminal paths, SSH, and tmux can differ. Verify the terminal or multiplexer permits clipboard access. The transcript selection remains visible even when the destination rejects the write; try a local terminal outside tmux to isolate the issue.

Use `y` in transcript Visual mode for rendered text and `Y` or `:yank markdown` for canonical Markdown source.

## The terminal display is left in a bad state

Handled quit, SIGINT/SIGTERM/SIGHUP, render failures, and persistence failures run terminal restoration. If the process is killed without cleanup, reset the shell manually:

```sh
reset
```

If input echo remains disabled, run `stty sane`. Please include the terminal emulator, `$TERM`, multiplexer/SSH details, and exit path in a bug report.

## Configuration fails to load

Vimex deliberately rejects unknown keys, the wrong `version`, invalid enum values, and malformed JSON. Validate the file named in the error. The default path is `~/.config/vimex/config.json`, subject to `XDG_CONFIG_HOME`; `--config` selects another path.

## Draft or viewport state is not saved

Local state defaults to `~/.local/state/vimex/views.json`, subject to `XDG_STATE_HOME`. Vimex displays `Local view state is not being saved` once for a run of write failures and rearms the warning after a successful save. Check that the parent directory is writable and is a directory. An unresolved final write makes Vimex exit nonzero.

## Colors are hard to read

Try `:theme nord` or `:theme kanagawa`. Use `:syntax theme` to keep code blocks aligned with the UI theme. Set `reducedColor: true`, or set `NO_COLOR` to a nonempty value, to reduce accent colors.

## A URL does not open

Only HTTP and HTTPS URLs are accepted by the Herdr external-action integration. Outside Herdr, Vimex delegates to the platform opener. In Herdr, review `external-actions.json` and verify its command exists; arguments are executed directly without a shell. See the [Herdr plugin guide](../plugins/herdr/README.md).
