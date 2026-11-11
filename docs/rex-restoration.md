# Rex pane restoration

Vimex reopens previously open Vimex panes at their corresponding local or remote conversations after Rex restores its sessions. Rex owns tabs, splits and pane existence; Vimex owns conversation bindings and local presentation checkpoints. No Vimex background service or second layout snapshot is required.

## Enable

Run this using the Vimex installation you intend to reopen:

```sh
vimex rex install --shell zsh
# Or:
vimex rex install --shell bash
```

The command installs a marked block in shell startup files, preserving existing content and symlinks. New interactive Rex shells check only their own pane. An inherited marker suppresses repeated checks and nested shells. Inspect the integration without installing it using `vimex rex hook zsh`. Remove it with `vimex rex uninstall --shell zsh` (or `bash`).

Rex must start again after a computer restart and restore its saved sessions. On macOS, configure Rex to open at login through the app/OS. Vimex's setup does not change login settings, start a server, or restart an existing server. The integration supports Bash and Zsh on macOS/Linux. It requires complete `REX_SERVER`, `REX_SESSION`, and `REX_BLOCK` values. A bare foreground Rex server may need its endpoint supplied through `REX_SERVER` when it starts.

Only panes that have run this implementation acquire checkpoints. Older Vimex processes must be relaunched once. A normal Vimex launch remains usable without registration when Rex identity cannot be verified. Restoration fails closed for an unverifiable saved pane.

## Behavior

- Switching conversations or machines updates the exact resume target. Titles and most-recent-session selection are never used for recovery.
- Two panes showing the same conversation retain independent drafts, outboxes, cursors, folds and viewports.
- Explicit `:q` retires the binding before returning to the shell. Shutdown signals and crashes preserve restoration intent.
- A closed Rex pane has no shell to invoke recovery. Old files cannot recreate closed panes.
- An unavailable remote machine retains its exact target and shows a retryable connection screen. Press `r` to retry or `q` to leave. Recovery never substitutes another machine or conversation.
- Pending submissions require explicit retry. Restoration does not replay turns, approvals or uncertain submissions.
- Restarting a local computer ends its running processes and turns. A remote daemon may remain alive; Vimex reconnects to authoritative backend state.

## Composition and ownership

```text
OS login / Rex launch
  -> Rex restores panes and starts their shells
  -> shell hook invokes vimex rex resume-pane
  -> verify exact server/session/block and actual terminal
  -> acquire crash-released pane ownership
  -> load checkpoint and resume exact machine/thread
```

The bootstrap verifies the requested server and live IDs through Rex's CLI, then checks that Vimex's actual input terminal matches the pane's terminal process. An inherited environment alone is insufficient. Vimex runs as a foreground child; no commands are typed into an existing terminal.

A pane holds an OS advisory lock for its lifetime. Duplicate launches cannot become concurrent checkpoint writers. The stable lock file is never unlinked; process exit releases ownership. Restoration re-reads the checkpoint after acquiring ownership so a stale bootstrap read cannot revive a retired binding.

## Topology

```text
apps/cli/src/rex-commands.ts                 headless command orchestration
apps/cli/src/rex-launcher.ts                 stable installed/source launcher
apps/tui/src/composition-root.ts            checkpoint and shutdown composition
apps/tui/src/pane-persistence.ts            target observation and shared deltas
apps/tui/src/restored-runtime.ts            unavailable-target recovery
packages/workbench/src/application/
  workbench-observation.ts                  committed application resume target
  local-state.ts                           presentation capture and hydration
packages/platform-node/src/
  persistence/pane-state.ts                 schema and exact-pane namespace
  persistence/import-pane-state.ts          explicit legacy migration
  persistence/json-store.ts                 atomic/durable writes, fresh updates
  process/file-lock.ts                      crash-released macOS/Linux locking
  rex/pane-verification.ts                  Rex identity and actual terminal
  rex/shell-hook.ts                         shell setup and removal
```

## Checkpoints and migration

Checkpoints live under `$XDG_STATE_HOME/vimex/panes/`, defaulting to `~/.local/state/vimex/panes/`. A hash of server, session and block identifies the file; its envelope verifies those exact values. Stable instance identity, active binding, target and per-machine local views are committed together. Assets use an adjacent private directory.

Writes serialize and atomically replace complete checkpoints. Durable writes synchronize the temporary file before rename and the containing directory afterward. Draft/navigation writes are coalesced; semantic target transitions trigger saves. Recovery uses the last committed checkpoint, so keystrokes still awaiting a save can be lost. This does not guarantee survival of every hardware or filesystem failure.

Legacy `views.json` and `views-NAME.json` remain intact. A new Rex pane may inherit navigation, but never silently copies unsent drafts or outboxes. To explicitly import legacy state for the pane's selected machine:

```sh
# Quit Vimex first so the pane has no active owner, then:
vimex rex import-state
```

Import preserves originals, privately copies referenced images, and refuses conflicting unsent work. Repeated imports replace keyed views rather than appending submissions. Reopen Vimex afterward; import does not mark a quit pane active.

Thread favorites are shared separately. Shared settings and non-Rex legacy view updates lock, read the latest file, and apply only the calling client's changes. Separate non-Rex terminals retain legacy same-thread last-writer behavior; Rex pane views are independently owned.

## Validation

Tests cover cross-process ownership/crash release, concurrent shared updates, validation, legacy import/image rollback, actual terminal identity, shell setup, nested-shell suppression, unavailable-target recovery, and real Vimex PTYs using deterministic Codex/Rex fixtures.

Disposable Rex `0.1.0-preview.14` runs on macOS verified clean restart and forced-crash recovery with stable IDs and selective hook invocation. An additional source-Vimex run verified exact thread/draft recovery after server restart, zero new-thread requests, and explicit quit preventing another restore. These runs touched no live Codex conversations or user dotfiles.

A full host reboot, sudden power loss and Linux Rex end-to-end execution have not been observed. Do not restart the user's working Rex server for acceptance tests.
