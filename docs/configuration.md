# Configuration

Vimex reads JSON from `$XDG_CONFIG_HOME/vimex/config.json`, or `~/.config/vimex/config.json` when `XDG_CONFIG_HOME` is unset. Pass `--config PATH` to use another file. A missing file is valid and uses defaults. Vimex rejects unknown keys and invalid values rather than silently ignoring them.

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

| Key | Values | Behavior |
| --- | --- | --- |
| `version` | `1` | Configuration schema version. |
| `theme` | `ember-tide`, `nord`, `kanagawa` | UI palette. `:theme NAME` changes and persists it. |
| `syntaxTheme` | `theme` or a theme name | Markdown code palette. `theme` follows the UI palette; `:syntax NAME` persists a change. |
| `reducedColor` | boolean | Reduces accents to foreground/background tones. A nonempty `NO_COLOR` also enables this at runtime. |
| `insertEnter` | `submit`, `newline` | With `submit`, Enter sends and Shift+Enter inserts a newline. With `newline`, Enter inserts a newline; Escape then Enter sends from Normal mode. Ctrl+Enter also sends when reported distinctly. |
| `busySubmit` | `queue`, `steer` | Sending during an active turn either queues the message for the next turn or steers the active turn. Ctrl+Enter explicitly steers in Insert mode. |
| `foldTools` | boolean | Initially fold tool, command, and edit items. |
| `foldReasoning` | boolean | Initially fold reasoning items. |
| `composerMaxHeight` | `0.1` through `0.6` | Upper bound for the fixed input area relative to terminal height. Adding lines scrolls inside the input instead of growing it. |
| `keybindings` | object | Maps a key sequence to a named Ex command. Overrides have priority over built-in bindings whenever no overlay is open. |
| `codexExecutable` | nonempty string | Executable path or command used to start the Codex app server. |

## Key overrides

Values must be known command names without a leading colon. For example:

```json
{
  "keybindings": {
    "ctrl+s": "submit",
    "ctrl+o": "sessions",
    "ctrl+g": "normal"
  }
}
```

Available names are `quit`, `sessions`, `approvals`, `help`, `model`, `thinking`, `cwd`, `new`, `approve`, `reject`, `stop`, `fork`, `fold`, `unfold`, `yank`, `open`, `rename`, `questions`, `agents`, `parent`, `restart`, `theme`, `syntax`, `submit`, `insert`, `normal`, and `visual`.

An override invokes the command without arguments. Commands such as `model`, `cwd`, `rename`, and `theme` are usually more useful from Command mode because their arguments are entered there. Overrides are disabled while an overlay is open so overlay navigation remains usable.

## Local state

Per-thread drafts and viewport state are stored in `$XDG_STATE_HOME/vimex/views.json`, or `~/.local/state/vimex/views.json`. Vimex writes atomic snapshots with user-only file permissions. Codex remains the source of truth for conversation history.

If a local-state write fails, Vimex shows a deduplicated warning and tries again after later state changes. It also attempts a final flush at shutdown; an unresolved failure produces a nonzero exit.
