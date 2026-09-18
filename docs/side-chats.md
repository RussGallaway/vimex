# Side chats

`/side [question]` and `:side [question]` fork the focused parent context into a separate conversation. The parent keeps running. Reusing the command focuses the existing side conversation. Side questions do not inherit an autonomous parent goal: the adapter defers goal continuation during the fork, then clears the child's copied goal before submitting a question.

Bare `/side` and `:side` open the pane without submitting a message. An opening placeholder appears while the server creates the fork; failures appear as a notice. Wide terminals use a right sidebar, narrow terminals stack the panes, and very short terminals show one pane at a time.

- `:side close` hides the pane. The child stays subscribed and keeps working. `/side` reopens that same conversation and draft.
- `:side quit` waits for any in-flight child submission, clears its goal, interrupts its active turn, and archives the child. A persisted retirement record prevents Vimex from reopening that child through sessions, history, or an explicit resume. The next `/side` creates a new child.
- `:side quote` appends the selected side text (or current semantic block) as a Markdown blockquote to the parent draft, then focuses the parent composer. It never submits the draft.
- `:side maximize` toggles maximization; `:side reset` restores the default split.
- `:side refresh` sends a labeled snapshot of recent parent transcript content to the child. It preserves the child's draft. This is explicit context transfer, not automatic live synchronization; the snapshot is bounded to the latest 50 entries and 48,000 characters.

Each conversation retains its own draft, cursor, folds, viewport, and mode. Closing during creation keeps the completed fork hidden; quitting during creation retires it before submitting the pending question. Failed fork creation is retryable. Failed retirement reports the error and leaves the association available for a retry.

## Server lifetime

Vimex negotiates `experimentalApi: true` when connecting and reconnecting. The pinned server requires this capability for `thread/fork.deferGoalContinuation`; omitting it rejects side creation. The offline side fixture enforces this requirement too.

Vimex uses the pinned Codex 0.154 app-server archive operation, not unsubscribe, for retirement. In the [pinned archive implementation](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/src/request_processors/thread_processor.rs#L1572), archiving prepares the target and its spawned descendants for removal. The [removal implementation](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/src/request_processors/thread_processor.rs#L989) removes the loaded thread, requests shutdown, and tears down its listeners. The server may proceed with archival after a shutdown timeout; the RPC does not expose a stronger termination acknowledgment. Stored history is archived, not deleted.

Vimex's retirement record prevents reopening in this client; it does not prevent another Codex client from explicitly restoring an archived thread.

## Offline acceptance

`python tests/terminal/side-driver.py` runs Vimex against the isolated `side-app-server.ts` JSONL fixture in a real PTY (install `tests/terminal/requirements-live.txt` first). It checks slash-command creation while the parent streams, maximize/restore, window focus keys, close/reopen identity, quit/new-fork identity, and narrow stacked layout. PNGs under `/tmp/vimex-side-e2e` reconstruct the terminal cells; they are not OS screenshots. No live Codex thread or clipboard is used.
