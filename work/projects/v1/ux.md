# Vimex v1 UX

## Interaction model

Vimex has exactly four user-visible modes:

- **Normal** navigates and operates on the transcript, composer, and overlays.
- **Insert** edits the composer.
- **Visual** extends a logical selection in the transcript or composer.
- **Command** accepts an Ex-style command line.

Focus and mode are separate. The active surface may be the transcript, composer, or an overlay without inventing additional modes.

Follow is also separate from mode. The transcript viewport is either attached to the tail or anchored to a logical position. Normal and Insert modes may operate in either condition.

## Full-screen layout

```text
┌──────────────── transcript viewport ────────────────┐
│                                                     │
│ rendered messages, reasoning, tools, diffs          │
│                                                     │
├──────────────── composer / command line ────────────┤
│ draft                                               │
├──────────────── status ─────────────────────────────┤
│ NORMAL  thread-name  gpt-6 · high  61k/200k · 31%  │
│ ~/repo/project                 main  ● working  +12 │
└─────────────────────────────────────────────────────┘
```

The transcript receives remaining height. The composer is a fixed-height sibling at the bottom; additional input lines scroll internally. A blank row separates it from the slim status strip. Narrow terminals truncate metadata within that strip rather than expanding the composer.

## Viewport behavior

The viewport starts attached to the tail. New output remains visible until the user navigates upward. Any upward motion detaches the viewport and records a stable logical anchor consisting of a transcript position and its desired screen row.

While detached:

- New content accumulates below without moving the viewport.
- The status line shows the number of unseen logical blocks or lines.
- Composer focus and Insert mode leave the anchor unchanged.
- Folding and terminal resize reproject the same logical anchor.

`G` moves to the bottom and reattaches. Merely entering Normal mode does not reattach.

## Default navigation

### Global and focus

| Key | Command |
|---|---|
| `Esc` | Return to Normal mode or close the top transient overlay |
| `:` | Enter Command mode |
| `Ctrl-k` (also `Ctrl-w k`) | Focus transcript |
| `Ctrl-j` (also `Ctrl-w j`) | Focus composer |
| `Space` | Leader prefix |

`Ctrl-b` is avoided as a default leader because terminal multiplexers and Herdr may already use it.

### Transcript Normal mode

| Keys | Command |
|---|---|
| `j`, `k` | Move by visual line |
| `Ctrl-e`, `Ctrl-y` | Scroll one line while preserving cursor intent |
| `Ctrl-d`, `Ctrl-u` | Move half a viewport |
| `gg`, `G` | First item; tail and resume following |
| `{`, `}` | Previous or next semantic block |
| `[[`, `]]` | Previous or next message |
| `0`, `^`, `$` | Start, first content, or end of logical line |
| `v`, `V` | Character or line Visual mode |
| `za`, `zo`, `zc` | Toggle, open, or close fold |
| `zM`, `zR` | Close or open all folds |
| `/`, `?` | Search forward or backward |
| `n`, `N` | Next or previous match |
| `[u`, `]u` | Previous or next URL |
| `gx` | Open URL under cursor |
| `r` | Reference selected or current block in composer |

Counts apply where their Vim equivalent is meaningful.

### Composer

Composer Normal mode supports the familiar editing subset: `h/j/k/l`, `w/b/e`, `0/^/$`, `gg/G`, `x`, `dd`, `D`, `C`, `u`, `Ctrl-r`, `p/P`, and `i/a/I/A/o/O`.

Normal-mode `Enter` submits. Insert-mode submission versus newline is configurable because terminal modifier fidelity differs. Enter submits by default; Shift+Enter inserts a newline. Alt+Enter is not bound because the user’s terminal host opens a new window with that combination.

Each thread owns its draft. An active turn does not disable the composer. Submitting during an active turn presents or applies a clear intent: steer the current turn or queue the next turn.

### Visual mode and copying

Transcript Visual mode selects logical content rather than screen cells.

- Motions extend the selection.
- `o` swaps anchor and head.
- `y` copies rendered plain text and returns to Normal mode.
- `:yank markdown` copies canonical Markdown.
- `gx` opens a selected URL when the selection resolves unambiguously.
- Selection may extend beyond the viewport.

Tool decorations and status chrome are excluded from copied content unless a command explicitly requests diagnostic output.

### Command mode

The command line replaces the lower status row and provides history and completion. Initial commands include:

```text
:sessions
:fork
:model
:thinking
:cwd
:stop
:approvals
:approve
:reject
:fold
:unfold
:open
:yank text
:yank markdown
:theme
:help
:quit
```

Named commands are the stable interaction API; keybindings invoke commands rather than component-local callbacks.

## Transcript presentation

- User and agent messages have distinct but restrained treatments.
- Agent text renders as streaming Markdown.
- Reasoning is visually subordinate and collapsible.
- Tool calls use compact semantic cards with state, duration, and a short preview.
- File edits use syntax-aware diffs, split on wide terminals and unified on narrow terminals.
- Running items visibly update without causing completed content to jump unnecessarily.
- Unknown Codex items remain visible as inspectable diagnostic cards.

Folding state is owned per logical item and per thread. Mouse click may toggle a fold, but every fold action has a keyboard command.

## Sessions, forks, and agents

The session picker is a fuzzy-search overlay grouped by recency. It shows thread name, cwd, branch, model, and running state when space permits.

Forking selects the completed turn beginning at a user message and includes that turn’s replies and tool activity, matching Codex’s inclusive turn boundary. The transcript cursor identifies the default boundary; `:fork` opens a small confirmation overlay and then switches to the fork.

Subagent activity appears inline as a foldable item and in a navigable thread relationship. Opening a child thread must preserve the parent's exact view state, and returning must restore it.

## Approvals

Approvals must not steal focus while the user is typing. A pending request produces a visible badge and optional terminal notification. `<leader>a` or `:approvals` opens the approval overlay. The overlay is a focus context using Normal-mode navigation rather than a fifth mode.

## URL behavior

Markdown links and detected bare URLs are indexed as semantic targets. OSC 8 links may supplement mouse interaction, but keyboard behavior uses the semantic index. URL opening goes through an application port so Herdr can intercept it.

## Visual direction

Use OpenCode's density, whitespace, compact tool cards, responsive layout, and restrained use of borders as inspiration. Do not inherit its mouse-first selection or ad hoc fold behavior. Mode, cursor, selection, and status must remain legible in low-color terminals.

## Interaction refinements from terminal testing

- The composer is a full-width panel with a left accent and an internal model/effort footer, above a separate status strip.
- Command entry replaces that strip and preserves transcript/composer geometry.
- Ctrl-J focuses the composer; Ctrl-K focuses the transcript; Ctrl-W J/K remain aliases.
- A precise transcript cursor is visible in Normal and Visual modes. Visual selection begins at that cursor and extends with character, word/WORD, and line motions.
- Submitted text leaves the native composer immediately; outbox entries retain recoverable send failures independently of the next draft.
- Activity indicators animate locally while connected work is active. Labels reflect actual reasoning, tool, response, approval, or waiting state; animation is not evidence of new server progress.

- Insert-mode slash commands use a prompt-anchored drawer above the composer, while Ex commands continue to use the bottom strip.

## Command entry refinements

Application actions share one command vocabulary across two entry points. Composer `/` offers discoverable slash commands; transcript Normal `/` still searches. Bottom-bar `:` offers direct arguments and completion without changing the composer draft. `/model` and argument-free `:model` open the model picker; `:model <id>` validates and applies the exact model directly. Tab completes commands and model IDs. Command mode remains a typing mode, with arrows selecting suggestions and Ctrl-P/N recalling history.

Up focuses the transcript and Down focuses the composer outside menus and command completion, supporting global Ctrl-K/J-to-arrow mappings. Session menus use j/k in Normal and literal text in Insert search. Escape leaves search before closing the menu.

The composer has no extra bottom padding below its model footer; one blank row separates the composer from the status or command bar.

Skill discovery and path-qualified skill insertion remain pending; a textual `$name` alone is not sufficient to preserve skill identity.

Composer-focused Ctrl-E/Y scroll the transcript by one line and Ctrl-D/U by half a page in Normal, Insert, and Visual modes, preserving the composer cursor and selection. Transcript block navigation supports both literal braces and explicit Shift-bracket terminal events.

Tool headers use server-provided action descriptions when available. Expanded command blocks separate the exact execution command from unchanged output, with both represented in the semantic transcript for selection and copying.
