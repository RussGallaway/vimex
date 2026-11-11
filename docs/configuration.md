# Configuration

For automatic reopening of local and remote Vimex panes after Rex restarts, see [Rex pane restoration](rex-restoration.md).

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
  "composerMaxHeight": 0.33,
  "keybindings": {},
  "codexExecutable": "codex"
}
```

| Key                 | Values                                | Behavior                                                                                                                                                                                         |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`           | `1`                                   | Configuration schema version.                                                                                                                                                                    |
| `theme`             | A [supported theme](./themes.md) name | UI palette. `:theme NAME` changes and persists it.                                                                                                                                               |
| `syntaxTheme`       | `theme` or a theme name               | Markdown code palette. `theme` follows the UI palette; `:syntax NAME` persists a change.                                                                                                         |
| `reducedColor`      | boolean                               | Reduces accents to foreground/background tones. A nonempty `NO_COLOR` also enables this at runtime.                                                                                              |
| `insertEnter`       | `submit`, `newline`                   | With `submit`, Enter sends and Shift+Enter inserts a newline. With `newline`, Enter inserts a newline; Escape then Enter sends from Normal mode. Ctrl+Enter also sends when reported distinctly. |
| `busySubmit`        | `queue`, `steer`                      | Sending during an active turn either queues the message for the next turn or steers the active turn. Ctrl+Enter explicitly steers in Insert mode.                                                |
| `foldTools`         | boolean                               | Initially fold tool and command items. File-change diffs start expanded.                                                                                                                         |
| `foldReasoning`     | boolean                               | Deprecated v1 compatibility key. It is accepted and ignored because reasoning is excluded from the primary transcript.                                                                           |
| `composerMaxHeight` | `0.1` through `0.6`                   | Upper bound for the fixed input area relative to terminal height. Adding lines scrolls inside the input instead of growing it.                                                                   |
| `keybindings`       | object                                | Maps a key sequence to a named Ex command. Overrides have priority over built-in bindings whenever no overlay is open.                                                                           |
| `codexExecutable`   | nonempty string                       | Executable path or command used to start the Codex app server.                                                                                                                                   |

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

## Machines

Vimex keeps its UI on the computer where it was launched. `Space m` (leader then m), `:machine` in command mode, or `/machine` in the composer opens the machine manager, `:machine devbox` connects through the SSH alias `devbox`, and `vimex --machine devbox --cwd ~/CodeInbox/repo` starts against that host (quote `~` if your shell would expand it locally). `:machine local` returns to local sessions. An explicit machine name may be an SSH alias even without configuration.

The bottom status line shows the active machine's display name beside the working directory and connection status. The machine manager lists saved connections with favorites first and marks the current machine. Search by ID or display name, then press Enter to switch. Ctrl+F toggles a favorite and Ctrl+R renames the selected machine in place. Add and remove use forms inside the modal; removal asks for confirmation. Favorites, including `local`, survive restarts.

```vim
:machine add travel devbox
:machine rename travel Travel VM
:machine favorite travel
:machine remove travel
```

All machine commands are available through both command mode (`:machine …`) and composer slash commands (`/machine …`), including add, rename, remove, favorite, and switching. `/handoff NAME` and `:handoff NAME` use the same transfer action. The modal uses these same actions and saved settings.

Adding saves a connection to an existing SSH host or alias; it does not provision a VM. Renaming changes only its display name, so `:machine travel` and its saved drafts and views keep the same stable ID. Switch away before removing the active connection. Removing forgets the saved connection without deleting the VM, stopping its daemon, or deleting saved session/view state. The built-in `local` connection cannot be renamed or removed.

```json
{
  "localTransport": "auto",
  "favoriteMachines": ["local", "devbox"],
  "machines": {
    "devbox": {
      "sshHost": "devbox",
      "label": "Devbox",
      "cwd": "~/CodeInbox/repo",
      "codexExecutable": "codex"
    }
  }
}
```

`localTransport` accepts `auto`, `daemon`, and `stdio`. Auto uses the local Codex daemon/proxy with the default `codex` executable; an explicitly configured alternate executable retains stdio compatibility. Set `daemon` to use a custom executable with a daemon, or `stdio` for the original child-process lifecycle. Remote machines use their own daemon and proxy. Daemon connections use an HTTP Upgrade handshake and WebSocket JSON frames through the proxy; direct stdio connections use newline-delimited JSON. Automatic reconnect replaces Vimex's proxy connection without restarting the shared daemon. Vimex resolves the executable each time it connects, so an updated installation is not tied to a release directory. A running daemon may still use an older binary; Vimex does not restart a shared daemon to upgrade it.

SSH must work non-interactively with your existing keys or SSH agent. Codex must be installed and authenticated on the destination, with daemon management available. Remote directory discovery and native handoff require Python 3. Missing commands fail with a connection error rather than opening a local session in their place.

Navigation, selection, composing, and optimistic submission rendering stay local. Transcript web links also open through the local browser/Herdr action, including when a remote machine is selected. File links resolve against the session working directory and preview files through that machine’s gateway; they do not fall back to laptop files. Mouse link controls use left-click, so Herdr can retain its right-click pane menu. Connection loss preserves the visible session and draft; reconnect refreshes server state without automatically resending uncertain submissions. A lost client does not intentionally stop the shared daemon. `:restart` rebuilds Vimex's connection, not the shared daemon.

Local UI state remains in `views.json`; remote machine state uses `views-NAME.json` in the same state directory. Machine aliases are separate namespaces, even if two aliases point to the same server.

`:handoff devbox` or `/handoff devbox` opens a destination picker while preserving the local Vimex view. The machine manager's `h` shortcut opens handoff for its selected machine. Choose a prepared worktree, browse directories, or create an isolated worktree. Favorites and up to eight recent destinations are remembered per machine and repository origin. Source compatibility is checked before directory discovery. `Enter` browses the selected folder; `u` or Ctrl+Enter explicitly hands off to the selected clean matching worktree. `p` edits a path, Tab completes from remote directories, Ctrl+F toggles a favorite, `b` opens the parent, `w` returns to workspaces or retries a failed preflight, and `n` creates an isolated worktree from the selected matching repository. Quoted and relative paths are supported. The selected full path, branch, and readiness appear in the picker; modified or unknown-status destinations cannot be chosen. Transfer progress and errors remain in the picker so a failed attempt can be retried without losing the selection.

Explicit command equivalents work through both slash and command mode:

```vim
/handoff devbox --cwd ~/worktrees/app-travel
:handoff local --cwd "/Users/me/Prepared Worktrees/app"
/handoff devbox --isolated
```

Select an existing **worktree root**. Handoff restores the source session's relative subdirectory beneath it. The destination must have no staged, unstaged, or nonignored untracked files; ignored dependencies and local configuration can remain unless they collide with incoming files. Vimex imports the exact source commit, including unpushed commits, switches to the source branch when possible, and accepts only a fast-forward of an existing branch. It refuses divergence, branches already checked out elsewhere, sparse checkouts, and hidden index changes. A detached source remains detached. Handoff does not run `pull`, merge unrelated work, install dependencies, or start services.

Existing source files are left intact. If you hand off uncommitted changes, the original checkout remains dirty and cannot receive a return handoff until you reconcile those changes. Commit before leaving for a clean prepared-workspace round trip, or choose a fresh isolated destination. Do not edit a destination while its transfer is in progress. Vimex detects destination changes before rollback and retains uncertain state for recovery instead of discarding it.

Handoff transfers supported native history and Git state. It requires an idle session with no outstanding approvals. Supported paginated histories include their native ancestor dependencies. Sessions without subagents continue through a native fork. Sessions with subagent history transfer the complete discovered tree and resume the original parent ID, preserving native parent/child relationships; a new parent fork would not own those children. Native dependency records remain on the destination. Vimex validates the restored history before retiring the source, and never substitutes a generated summary. Unsupported history dependencies are rejected before transfer. Existing background programs and external services do not move with the conversation.

Handoff currently requires the same identifiable ChatGPT account/workspace on both hosts and matching Git origin URLs. Paginated handoff also requires matching running Codex app-server versions; subagent-tree goal-store validation currently supports Codex 0.166.0. Updating the CLI alone does not update an already-running daemon. API-key identity cannot be verified by this path. Remove structured file, skill, or plugin references from an unsent draft before handoff and reselect them on the destination; source-host paths are not silently reused. It also rejects active Git clean/smudge filters, submodules, merge conflicts, local image history, persisted goals on transferred sessions, and oversized artifacts. Every transferred agent must be idle, without background terminals, and use the source session’s working directory; separate agent workspaces are not transferred. A fork that references agents owned by another parent is refused; those historical references do not grant the fork ownership of that other tree. These checks protect fidelity; the original session remains on its host when preflight fails. Do not concurrently drive the same source session from another client during handoff: Codex does not expose an exclusive cross-client migration lock. Independent sessions can run concurrently, preferably in separate worktrees.

Successful handoff archives the old backend thread after validating the imported destination; it does not delete it. Newly imported ancestor records are also archived from normal session listings while their native files remain available to the destination fork. For a returning agent tree, Vimex can extend an older archived copy only when its bytes are an exact prefix of the incoming history. Active copies and divergent histories are refused. The original thread IDs remain the same across machines. Cleanup never archives preexisting destination sessions or live children of the restored tree. A newly created isolated destination is a detached worktree; keep it while using the session and create a named branch there when publishing commits. Existing destinations retain their machine-specific ignored environment and dependencies, which may need updating when source manifests change.

## Automatic sleep prevention

On macOS, Vimex defaults to preventing idle system sleep while its connected local runtime has an active agent turn or a pending submission. The display may still sleep. The status line shows `awake:on` while the assertion is active, `awake:auto` while enabled but idle, or `awake:off` when disabled. Errors are reported rather than showing an active assertion.

Use `/caffeinate` or `:caffeinate` to toggle; `on`, `off`, and `toggle` are also accepted. The `caffeinate` boolean configuration setting persists your preference. Finishing local work releases the assertion automatically. Disconnecting, switching to another machine, and closing Vimex also release it; remote work does not keep the laptop awake. Detached local daemon work is not monitored after switching away. Other operating systems do not launch the macOS utility.

## Transcript navigation

Retained transcript neighborhoods, prepared command-output painting, held-navigation repeat control, and the Markdown measurement cache are enabled by default in both `vimex` and `vimex-dev`. No configuration entries or shell exports are needed.

For diagnostic comparisons, set an individual environment variable to `0` when launching: `VIMEX_NAV_RETAINED_WINDOW`, `VIMEX_NAV_PREPARED_PAINT`, `VIMEX_NAV_REPEAT_CONTROL`, or `VIMEX_NAV_MARKDOWN_MEASUREMENT_CACHE`. These are runtime overrides, not JSON configuration keys. Existing values of `1` remain compatible but are redundant.
