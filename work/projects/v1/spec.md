# Vimex v1 Product Specification

## Product statement

Vimex is a full-screen terminal client for the Codex app server. It combines Codex's agent runtime with a Vim-native interaction model and an OpenCode-inspired presentation.

## Goals

V1 must provide:

1. A full-screen alternate-screen TUI built with OpenTUI React.
2. A transcript viewport and a composer fixed to the bottom of the screen.
3. Four user-visible Vim modes: Normal, Insert, Visual, and Command.
4. Independent transcript navigation while a response is streaming and while a draft is being written.
5. First-class keyboard selection, copying, URL navigation, folding, sessions, forks, and approvals.
6. Markdown rendering for agent messages and appropriate renderers for tools, commands, reasoning, and file edits.
7. Persistent visibility of thread and workspace state.
8. Native integration with Herdr without making Herdr a runtime requirement.

## Product invariants

- The composer remains mounted and fixed to the bottom when the transcript scrolls.
- Typing never moves a detached transcript viewport.
- Streaming output never steals the user's reading position.
- Follow behavior is viewport state, not an interaction mode.
- Visual selections use logical transcript positions, not terminal cells.
- Every essential action is available from the keyboard.
- Codex remains the source of truth for threads, turns, items, approvals, and execution.
- Vimex retains canonical Markdown source even when it displays rendered Markdown.

## Functional requirements

### Codex lifecycle

- Start and initialize `codex app-server` over stdio.
- Start, resume, list, switch, rename, and fork threads.
- Start, steer, and interrupt turns.
- Render streaming agent messages and reasoning.
- Render command executions, file changes, MCP calls, and agent activity.
- Receive and resolve approval requests.
- Recover gracefully from unknown notification and item variants.
- Show a disconnected state and permit a controlled restart after app-server failure.

### Transcript

- Render CommonMark-compatible Markdown during streaming.
- Preserve stable logical positions across streaming, folding, and terminal resize.
- Navigate by line, half-page, page, semantic block, message, URL, top, and bottom.
- Collapse or expand one tool, one message section, or all foldable items.
- Show unseen-output state while detached from the tail.
- Copy rendered text or canonical Markdown.
- Open the URL under the cursor and offer a keyboard URL picker when several targets are present.
- Display diffs with a responsive unified or split presentation.

### Composer

- Provide Vim editing in Normal, Insert, and Visual modes.
- Keep one draft per thread.
- Allow drafting while a turn is active.
- Distinguish steering the active turn from queueing the next user turn.
- Preserve the draft and transcript position across thread switches.
- Keep a fixed-height input area; additional lines scroll internally. Adapt its height only when the terminal is resized.

### Sessions and forks

- Provide a searchable, keyboard-operated session picker.
- Show thread name, recency, status, cwd, and branch when available.
- Fork from a selected prior user-message boundary.
- Open child agent threads and return to their parent.
- Preserve local per-thread view state.
- Rename selected sessions and persist local favorites, including resumable threads absent from the server listing.

### Status

The persistent status area must show, subject to responsive truncation:

- Vim mode
- Thread name
- Model
- Reasoning effort
- Context tokens and percentage
- Working directory
- Git branch
- Turn or agent state
- Pending approval count
- Unseen output count

### Configuration

- Theme and syntax-theme selection.
- Key overrides expressed in named commands rather than component callbacks.
- Configurable submit/newline behavior in Insert mode.
- Configurable tool and reasoning fold defaults.
- Safe terminal restoration after normal exit, signals, and handled failures.

### Herdr integration

- Launch Vimex as a recognized Herdr pane type.
- Report the current Codex thread ID and changes to it.
- Report `working`, `blocked`, `idle`, or `unknown` lifecycle state.
- Report useful metadata including model, cwd, branch, and context usage.
- Allow Herdr to handle external actions such as URL opening when configured.

## Non-functional requirements

- Input and viewport movement remain responsive during streaming and large tool output.
- Domain packages have no dependency on React, OpenTUI, Node, Bun, Herdr, or generated Codex types.
- A new Codex item variant degrades to an inspectable unknown item rather than crashing the UI.
- Terminal reflow must not invalidate selections, cursor locations, or viewport anchors.
- Clipboard operations support local terminals and remote sessions through host clipboard and OSC52 where available.
- Accessibility includes visible focus, unambiguous mode color and text, reduced-color operation, and no color-only status meaning.

## V1 exclusions

- Reimplementing the Codex runtime, model orchestration, sandbox, or thread store.
- A public stable plugin ABI.
- Mouse-dependent workflows. Mouse support may supplement keyboard behavior.
- Exact emulation of every Vim command, register, mark, macro, and text object.
- Remote multi-user collaboration.
- An embedded terminal or general-purpose editor.

## Acceptance criteria

V1 is complete when all of the following work against a real app server:

1. Start a thread, submit a prompt, and observe streaming Markdown and tool activity.
2. Scroll upward during streaming, enter Insert mode, compose text, and remain at the same logical transcript position.
3. Press `G` to return to the tail and resume following output.
4. Select rendered text in Visual mode and copy it after a terminal resize.
5. Copy canonical Markdown for the same selection.
6. Navigate to a URL and open it with `gx` without using a mouse.
7. Fold and unfold tool and edit blocks without moving the logical cursor.
8. Switch threads and recover each thread's draft, cursor, folds, and viewport anchor.
9. Fork from a previous message and enter the new thread.
10. Resolve a Codex approval entirely from the keyboard.
11. Exit or crash through a handled path and restore the terminal correctly.
12. Run inside Herdr and report thread and lifecycle metadata accurately.

## References

- [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
- [OpenTUI repository](https://github.com/anomalyco/opentui)
- [OpenCode TUI package](https://github.com/anomalyco/opencode/tree/dev/packages/tui)
